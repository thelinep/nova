'use strict';
/* ===========================================================================
 * Radheya model: what the board learns from its own events.
 *
 * Two learners on the same task (predict a card's next event from the events
 * so far), compared on cards held out from training:
 *   baseline     a smoothed bigram (Markov) model over event tokens, plus the
 *                median time a card stays in each column. Needs little data.
 *   transformer  a tiny causal transformer (lib/radheya-tensor.js) that reads
 *                the last `ctx` events of a card.
 * "Evolution" proposes neighbouring transformer shapes (wider, narrower, more
 * heads, deeper, longer context), trains each with a fixed seed and scores it
 * on the held-out cards. A shape is only RECOMMENDED when it beats both the
 * baseline and the active model by a margin on enough held-out events; it is
 * only USED after a person approves it (lib/radheya.js). Nothing here claims
 * accuracy beyond the held-out numbers it reports.
 * ========================================================================= */

const crypto = require('node:crypto');
const tensor = require('./radheya-tensor');

const MIN_EVAL_TARGETS = 30;     // held-out next-event predictions needed before any recommendation
const MIN_TRAIN_EVENTS = 200;    // training events needed before a transformer may be recommended
const MARGIN = 0.02;             // a candidate must cut held-out loss by 2% to be recommended
const ALPHA = 0.5;               // add-alpha smoothing for the baseline
const BOS = '<bos>', UNK = '<unk>';

function tokenOf(e) { return [e.type, e.to || '', e.assigneeKind || '', e.result || ''].join('|'); }

/** Events grouped per card, oldest first. */
function sequences(events) {
  const by = new Map();
  for (const e of events) { if (!e.cardId) continue; if (!by.has(e.cardId)) by.set(e.cardId, []); by.get(e.cardId).push(e); }
  for (const list of by.values()) list.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  return by;
}

/** Deterministic split by card id: about one card in five is held out. */
function isHeldOut(cardId) { return crypto.createHash('sha256').update(String(cardId)).digest()[0] < 52; }

function buildVocab(trainSeqs) {
  const tokens = [BOS, UNK];
  const seen = new Set(tokens);
  for (const seq of trainSeqs) for (const e of seq) { const t = tokenOf(e); if (!seen.has(t)) { seen.add(t); tokens.push(t); } }
  return { tokens, index: new Map(tokens.map((t, i) => [t, i])) };
}
const encode = (vocab, seq) => [0, ...seq.map(e => vocab.index.has(tokenOf(e)) ? vocab.index.get(tokenOf(e)) : 1)];

function split(events) {
  const train = [], test = [];
  for (const [cardId, seq] of sequences(events)) (isHeldOut(cardId) ? test : train).push(seq);
  return { train, test };
}

// ---------------- baseline ----------------

function trainBaseline(trainSeqs, vocab) {
  const V = vocab.tokens.length, counts = new Map(), totals = new Map();
  for (const seq of trainSeqs) {
    const ids = encode(vocab, seq);
    for (let i = 1; i < ids.length; i++) { const k = ids[i - 1] * V + ids[i]; counts.set(k, (counts.get(k) || 0) + 1); totals.set(ids[i - 1], (totals.get(ids[i - 1]) || 0) + 1); }
  }
  return { kind: 'baseline', vocab: vocab.tokens, counts: Object.fromEntries(counts), totals: Object.fromEntries(totals) };
}
function baselineDist(b, prevId) {
  const V = b.vocab.length, tot = b.totals[prevId] || 0, out = new Array(V);
  for (let j = 0; j < V; j++) out[j] = ((b.counts[prevId * V + j] || 0) + ALPHA) / (tot + ALPHA * V);
  return out;
}

/** Time a card spent in each column, from move events. */
function durations(events) {
  const per = {}, perKind = {};
  for (const seq of sequences(events).values()) {
    let col = null, since = null, kind = null;
    for (const e of seq) {
      if (e.type === 'assigned') kind = e.assigneeKind || kind;
      if (e.type === 'moved' || e.type === 'created') {
        if (col && since) { const s = (Date.parse(e.at) - Date.parse(since)) / 1000; if (s >= 0) { (per[col] = per[col] || []).push(s); const k = col + '|' + (kind || 'human'); (perKind[k] = perKind[k] || []).push(s); } }
        col = e.to || col; since = e.at;
      }
    }
  }
  const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sum = o => Object.fromEntries(Object.entries(o).map(([k, a]) => [k, { medianSeconds: Math.round(med(a)), samples: a.length }]));
  return { byColumn: sum(per), byColumnAndAssignee: sum(perKind) };
}

// ---------------- transformer ----------------

function windows(ids, ctx) {
  const out = [];
  if (ids.length < 2) return out;
  const step = Math.max(1, ctx >> 1);
  for (let s = 0; ; s += step) {
    const x = ids.slice(s, s + ctx);
    out.push({ x, y: x.map((_, i) => (s + i + 1 < ids.length ? ids[s + i + 1] : -1)) });
    if (s + ctx >= ids.length) break;
  }
  return out;
}

function trainTransformer(trainSeqs, vocab, config, { seed = 7, maxSteps = 1500, lr = 0.01 } = {}) {
  const model = tensor.createTransformer(vocab.tokens.length, config, seed);
  const data = trainSeqs.flatMap(seq => windows(encode(vocab, seq), model.cfg.ctx));
  const opt = tensor.adam(tensor.parameters(model), lr);
  let steps = 0, last = null;
  if (data.length) {
    const rand = tensor.rng(seed + 1);
    while (steps < maxSteps) {
      const w = data[Math.floor(rand() * data.length)];
      opt.zero();
      const loss = tensor.crossEntropy(tensor.forward(model, w.x), w.y);
      tensor.backward(loss); opt.step();
      last = loss.data[0]; steps++;
      if (steps >= data.length * 40) break;   // small boards: about 40 passes is plenty
    }
  }
  return { model, steps, lastLoss: last };
}

/** Next-event distribution for every position of a card's history, from either learner. */
function distributions(learner, vocab, seq) {
  const ids = encode(vocab, seq), out = [];
  if (learner.kind === 'baseline') { for (let i = 0; i < ids.length; i++) out.push(baselineDist(learner, ids[i])); return out; }
  const ctx = learner.model.cfg.ctx;
  for (let end = 1; end <= ids.length; end++) {
    const x = ids.slice(Math.max(0, end - ctx), end);
    out.push(tensor.softmaxRow(tensor.forward(learner.model, x), x.length - 1));
  }
  return out;
}

/** Mean held-out cross-entropy (nats per event) and the number of predictions it averages. */
function evaluate(learner, vocab, testSeqs) {
  let loss = 0, n = 0, hit = 0;
  for (const seq of testSeqs) {
    const ids = encode(vocab, seq), dists = distributions(learner, vocab, seq);
    for (let i = 0; i + 1 < ids.length; i++) {
      const p = dists[i]; loss -= Math.log(Math.max(p[ids[i + 1]], 1e-12)); n++;
      if (p.indexOf(Math.max(...p)) === ids[i + 1]) hit++;
    }
  }
  return { loss: n ? loss / n : null, top1: n ? hit / n : null, targets: n };
}

/** Neighbouring shapes of a configuration, in a fixed order. */
function mutations(config) {
  const c = tensor.validConfig(config), out = [];
  const tryAdd = (change, label) => { try { const next = tensor.validConfig({ ...c, ...change }); if (JSON.stringify(next) !== JSON.stringify(c) && !out.some(o => JSON.stringify(o.config) === JSON.stringify(next))) out.push({ config: next, change: label }); } catch (_) {} };
  tryAdd({ d: c.d * 2 }, `width ${c.d} → ${c.d * 2}`);
  tryAdd({ d: Math.max(c.heads * 4, c.d / 2) }, `width ${c.d} → ${Math.max(c.heads * 4, c.d / 2)}`);
  tryAdd({ heads: c.heads * 2 }, `heads ${c.heads} → ${c.heads * 2}`);
  tryAdd({ layers: c.layers + 1 }, `layers ${c.layers} → ${c.layers + 1}`);
  tryAdd({ ctx: c.ctx * 2 }, `context ${c.ctx} → ${c.ctx * 2}`);
  tryAdd({ layers: c.layers - 1 }, `layers ${c.layers} → ${c.layers - 1}`);
  return out;
}

/**
 * One evolution round: baseline, the current shape and up to `limit` mutations,
 * each trained on the training cards and scored on the held-out cards.
 * Returns a proposal; it never activates anything.
 */
function evolve(events, { activeConfig, activeLoss = null, limit = 3, seed = 7, maxSteps = 1500 } = {}) {
  const { train, test } = split(events);
  const trainEvents = train.reduce((s, q) => s + q.length, 0);
  const vocab = buildVocab(train);
  const baseline = trainBaseline(train, vocab);
  const baseEval = evaluate(baseline, vocab, test);
  const current = tensor.validConfig(activeConfig || tensor.DEFAULT_CONFIG);
  const shapes = [{ config: current, change: 'current shape' }, ...mutations(current).slice(0, limit)];
  const candidates = shapes.map(({ config, change }) => {
    const t = trainTransformer(train, vocab, config, { seed, maxSteps });
    const ev = evaluate({ kind: 'transformer', model: t.model }, vocab, test);
    return { config, change, params: tensor.countParams(t.model), steps: t.steps, trainLoss: t.lastLoss, heldOut: ev, saved: tensor.serialize(t.model) };
  });
  const scored = candidates.filter(c => c.heldOut.loss != null).sort((a, b) => a.heldOut.loss - b.heldOut.loss);
  const best = scored[0] || null;
  const reasons = [];
  if (baseEval.targets < MIN_EVAL_TARGETS) reasons.push(`only ${baseEval.targets} held-out predictions (needs ${MIN_EVAL_TARGETS})`);
  if (trainEvents < MIN_TRAIN_EVENTS) reasons.push(`only ${trainEvents} training events (needs ${MIN_TRAIN_EVENTS})`);
  const bar = Math.min(baseEval.loss ?? Infinity, activeLoss ?? Infinity);
  if (best && Number.isFinite(bar) && !(best.heldOut.loss < bar * (1 - MARGIN))) reasons.push(`best shape (${best.heldOut.loss.toFixed(3)}) does not beat ${activeLoss != null && activeLoss <= (baseEval.loss ?? Infinity) ? 'the active model' : 'the baseline'} (${bar.toFixed(3)}) by ${MARGIN * 100}%`);
  return {
    vocab: vocab.tokens, trainCards: train.length, testCards: test.length, trainEvents,
    baseline: { heldOut: baseEval, saved: baseline },
    candidates,
    best: best ? candidates.indexOf(best) : null,
    recommendation: best && !reasons.length ? 'promote' : 'keep',
    reasons,
    rules: { MIN_EVAL_TARGETS, MIN_TRAIN_EVENTS, MARGIN },
  };
}

/** What a learner expects next for one card: next column and failure chance of a run. */
function predict(learner, vocabTokens, seq) {
  const vocab = { tokens: vocabTokens, index: new Map(vocabTokens.map((t, i) => [t, i])) };
  const dists = distributions(learner, vocab, seq), p = dists[dists.length - 1];
  const next = {}; let runPass = 0, runFail = 0;
  vocabTokens.forEach((t, i) => {
    const [type, to, , result] = t.split('|');
    if (type === 'moved' && to) next[to] = (next[to] || 0) + p[i];
    if (type === 'run_finished') { if (result === 'fail') runFail += p[i]; else if (result === 'pass') runPass += p[i]; }
  });
  const mass = Object.values(next).reduce((s, x) => s + x, 0);
  const nextColumn = mass > 0 ? Object.fromEntries(Object.entries(next).map(([k, v]) => [k, Math.round(v / mass * 1000) / 1000]).sort((a, b) => b[1] - a[1])) : {};
  return { nextColumn, runFailure: runPass + runFail > 0 ? Math.round(runFail / (runPass + runFail) * 1000) / 1000 : null };
}

function loadLearner(record) {
  if (!record) return null;
  if (record.kind === 'baseline') return record.saved;
  return { kind: 'transformer', model: tensor.deserialize(record.saved) };
}

module.exports = { tokenOf, sequences, isHeldOut, split, buildVocab, encode, trainBaseline, baselineDist, durations, windows, trainTransformer, distributions, evaluate, mutations, evolve, predict, loadLearner, MIN_EVAL_TARGETS, MIN_TRAIN_EVENTS, MARGIN };
