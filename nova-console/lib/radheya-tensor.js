'use strict';
/* ===========================================================================
 * Radheya tensor: a small reverse-mode autodiff over 2-D Float64 matrices and
 * a tiny causal transformer built on it. Pure JavaScript, no dependencies, CPU.
 *
 * It is deliberately small (thousands to tens of thousands of parameters):
 * Radheya learns from one person's Kanban events, so data, not compute, is the
 * limit. Every gradient here is checked numerically in tests/radheya-model.test.js.
 * ========================================================================= */

class T {
  constructor(rows, cols, data) {
    this.rows = rows; this.cols = cols;
    this.data = data || new Float64Array(rows * cols);
    this.grad = null; this.parents = []; this.back = null;
  }
  get size() { return this.rows * this.cols; }
  zeroGrad() { this.grad = new Float64Array(this.size); }
}

function node(rows, cols, data, parents, back) {
  const t = new T(rows, cols, data);
  t.parents = parents; t.back = back;
  return t;
}
const g = t => (t.grad || (t.grad = new Float64Array(t.size)));

/** Deterministic random numbers (mulberry32) so training runs repeat exactly. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function param(rows, cols, rand, scale) {
  const t = new T(rows, cols);
  for (let i = 0; i < t.size; i++) t.data[i] = (rand() * 2 - 1) * scale;
  t.isParam = true;
  return t;
}
function constant(rows, cols, value) { const t = new T(rows, cols); if (value) t.data.fill(value); t.isParam = true; return t; }

function matmul(A, B) {
  if (A.cols !== B.rows) throw new Error(`matmul ${A.rows}x${A.cols} · ${B.rows}x${B.cols}`);
  const m = A.rows, k = A.cols, n = B.cols, out = new Float64Array(m * n);
  for (let i = 0; i < m; i++) for (let p = 0; p < k; p++) { const a = A.data[i * k + p]; if (a === 0) continue; for (let j = 0; j < n; j++) out[i * n + j] += a * B.data[p * n + j]; }
  return node(m, n, out, [A, B], o => {
    const ga = g(A), gb = g(B);
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { const d = o.grad[i * n + j]; if (d === 0) continue; for (let p = 0; p < k; p++) { ga[i * k + p] += d * B.data[p * n + j]; gb[p * n + j] += A.data[i * k + p] * d; } }
  });
}
function add(A, B) {
  const out = new Float64Array(A.size);
  for (let i = 0; i < A.size; i++) out[i] = A.data[i] + B.data[i];
  return node(A.rows, A.cols, out, [A, B], o => { const ga = g(A), gb = g(B); for (let i = 0; i < A.size; i++) { ga[i] += o.grad[i]; gb[i] += o.grad[i]; } });
}
/** A[m,n] + b[1,n] broadcast over rows. */
function addRow(A, b) {
  const { rows: m, cols: n } = A, out = new Float64Array(m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) out[i * n + j] = A.data[i * n + j] + b.data[j];
  return node(m, n, out, [A, b], o => { const ga = g(A), gb = g(b); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { ga[i * n + j] += o.grad[i * n + j]; gb[j] += o.grad[i * n + j]; } });
}
function scale(A, s) {
  const out = new Float64Array(A.size);
  for (let i = 0; i < A.size; i++) out[i] = A.data[i] * s;
  return node(A.rows, A.cols, out, [A], o => { const ga = g(A); for (let i = 0; i < A.size; i++) ga[i] += o.grad[i] * s; });
}
function relu(A) {
  const out = new Float64Array(A.size);
  for (let i = 0; i < A.size; i++) out[i] = A.data[i] > 0 ? A.data[i] : 0;
  return node(A.rows, A.cols, out, [A], o => { const ga = g(A); for (let i = 0; i < A.size; i++) if (A.data[i] > 0) ga[i] += o.grad[i]; });
}
function transpose(A) {
  const { rows: m, cols: n } = A, out = new Float64Array(m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) out[j * m + i] = A.data[i * n + j];
  return node(n, m, out, [A], o => { const ga = g(A); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) ga[i * n + j] += o.grad[j * m + i]; });
}
function sliceCols(A, start, len) {
  const { rows: m, cols: n } = A, out = new Float64Array(m * len);
  for (let i = 0; i < m; i++) for (let j = 0; j < len; j++) out[i * len + j] = A.data[i * n + start + j];
  return node(m, len, out, [A], o => { const ga = g(A); for (let i = 0; i < m; i++) for (let j = 0; j < len; j++) ga[i * n + start + j] += o.grad[i * len + j]; });
}
function concatCols(list) {
  const m = list[0].rows, n = list.reduce((s, t) => s + t.cols, 0), out = new Float64Array(m * n);
  let off = 0;
  for (const t of list) { for (let i = 0; i < m; i++) for (let j = 0; j < t.cols; j++) out[i * n + off + j] = t.data[i * t.cols + j]; off += t.cols; }
  return node(m, n, out, list, o => { let at = 0; for (const t of list) { const gt = g(t); for (let i = 0; i < m; i++) for (let j = 0; j < t.cols; j++) gt[i * t.cols + j] += o.grad[i * n + at + j]; at += t.cols; } });
}
/** Rows of E picked by ids (an embedding lookup). */
function gatherRows(E, ids) {
  const n = E.cols, out = new Float64Array(ids.length * n);
  ids.forEach((id, i) => { for (let j = 0; j < n; j++) out[i * n + j] = E.data[id * n + j]; });
  return node(ids.length, n, out, [E], o => { const ge = g(E); ids.forEach((id, i) => { for (let j = 0; j < n; j++) ge[id * n + j] += o.grad[i * n + j]; }); });
}
/** The first `rows` rows of A. */
function topRows(A, rows) {
  const n = A.cols, out = A.data.slice(0, rows * n);
  return node(rows, n, out, [A], o => { const ga = g(A); for (let i = 0; i < rows * n; i++) ga[i] += o.grad[i]; });
}
/** Row-wise softmax with a causal mask: position i sees positions 0..i only. */
function causalSoftmax(A) {
  const m = A.rows, n = A.cols, out = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    let max = -Infinity; for (let j = 0; j <= i && j < n; j++) max = Math.max(max, A.data[i * n + j]);
    let sum = 0; for (let j = 0; j <= i && j < n; j++) { const e = Math.exp(A.data[i * n + j] - max); out[i * n + j] = e; sum += e; }
    for (let j = 0; j <= i && j < n; j++) out[i * n + j] /= sum;
  }
  return node(m, n, out, [A], o => {
    const ga = g(A);
    for (let i = 0; i < m; i++) { let dot = 0; for (let j = 0; j <= i && j < n; j++) dot += o.grad[i * n + j] * out[i * n + j]; for (let j = 0; j <= i && j < n; j++) ga[i * n + j] += out[i * n + j] * (o.grad[i * n + j] - dot); }
  });
}
function layerNorm(A, gamma, beta, eps = 1e-5) {
  const m = A.rows, n = A.cols, out = new Float64Array(m * n), xhat = new Float64Array(m * n), inv = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let mu = 0; for (let j = 0; j < n; j++) mu += A.data[i * n + j]; mu /= n;
    let v = 0; for (let j = 0; j < n; j++) { const d = A.data[i * n + j] - mu; v += d * d; } v /= n;
    inv[i] = 1 / Math.sqrt(v + eps);
    for (let j = 0; j < n; j++) { xhat[i * n + j] = (A.data[i * n + j] - mu) * inv[i]; out[i * n + j] = xhat[i * n + j] * gamma.data[j] + beta.data[j]; }
  }
  return node(m, n, out, [A, gamma, beta], o => {
    const ga = g(A), gg = g(gamma), gbt = g(beta);
    for (let i = 0; i < m; i++) {
      let s1 = 0, s2 = 0;
      for (let j = 0; j < n; j++) { const dy = o.grad[i * n + j]; gg[j] += dy * xhat[i * n + j]; gbt[j] += dy; const dx = dy * gamma.data[j]; s1 += dx; s2 += dx * xhat[i * n + j]; }
      for (let j = 0; j < n; j++) { const dx = o.grad[i * n + j] * gamma.data[j]; ga[i * n + j] += inv[i] * (dx - s1 / n - xhat[i * n + j] * s2 / n); }
    }
  });
}
/** Mean cross-entropy of logits[m,V] against targets (length m; -1 = skip). Returns a 1x1 tensor. */
function crossEntropy(L, targets) {
  const m = L.rows, V = L.cols, probs = new Float64Array(m * V);
  let loss = 0, count = 0;
  for (let i = 0; i < m; i++) {
    let max = -Infinity; for (let j = 0; j < V; j++) max = Math.max(max, L.data[i * V + j]);
    let sum = 0; for (let j = 0; j < V; j++) { probs[i * V + j] = Math.exp(L.data[i * V + j] - max); sum += probs[i * V + j]; }
    for (let j = 0; j < V; j++) probs[i * V + j] /= sum;
    if (targets[i] >= 0) { loss -= Math.log(Math.max(probs[i * V + targets[i]], 1e-12)); count++; }
  }
  const out = new Float64Array([count ? loss / count : 0]);
  return node(1, 1, out, [L], o => {
    if (!count) return; const gl = g(L), s = o.grad[0] / count;
    for (let i = 0; i < m; i++) { if (targets[i] < 0) continue; for (let j = 0; j < V; j++) gl[i * V + j] += s * (probs[i * V + j] - (j === targets[i] ? 1 : 0)); }
  });
}

function backward(loss) {
  const order = [], seen = new Set();
  const visit = t => { if (seen.has(t)) return; seen.add(t); for (const p of t.parents) visit(p); order.push(t); };
  visit(loss);
  for (const t of order) if (!t.isParam) t.grad = null;
  loss.grad = new Float64Array([1]);
  for (let i = order.length - 1; i >= 0; i--) if (order[i].back) order[i].back(order[i]);
}

// ---------------------------------------------------------------------------
// The transformer: token + position embeddings, pre-norm blocks of multi-head
// causal self-attention and a ReLU MLP, a final norm and a vocabulary head.

const DEFAULT_CONFIG = Object.freeze({ d: 32, heads: 2, layers: 1, ctx: 16, ff: 2 });

function validConfig(c) {
  const cfg = { ...DEFAULT_CONFIG, ...c };
  for (const k of ['d', 'heads', 'layers', 'ctx', 'ff']) if (!Number.isInteger(cfg[k]) || cfg[k] < 1) throw new Error(`config.${k} must be a positive integer`);
  if (cfg.d % cfg.heads) throw new Error('config.d must be divisible by config.heads');
  if (cfg.d > 256 || cfg.layers > 4 || cfg.ctx > 64 || cfg.heads > 8) throw new Error('config is larger than Radheya allows (d ≤ 256, layers ≤ 4, ctx ≤ 64, heads ≤ 8)');
  return cfg;
}

function createTransformer(vocabSize, config, seed = 1) {
  const cfg = validConfig(config), rand = rng(seed), d = cfg.d, s = 1 / Math.sqrt(d);
  const p = { tok: param(vocabSize, d, rand, 0.1), pos: param(cfg.ctx, d, rand, 0.1), blocks: [], lnF: [constant(1, d, 1), constant(1, d, 0)], head: param(d, vocabSize, rand, s) };
  for (let l = 0; l < cfg.layers; l++) p.blocks.push({
    ln1: [constant(1, d, 1), constant(1, d, 0)], wq: param(d, d, rand, s), wk: param(d, d, rand, s), wv: param(d, d, rand, s), wo: param(d, d, rand, s),
    ln2: [constant(1, d, 1), constant(1, d, 0)], w1: param(d, d * cfg.ff, rand, s), b1: constant(1, d * cfg.ff, 0), w2: param(d * cfg.ff, d, rand, 1 / Math.sqrt(d * cfg.ff)), b2: constant(1, d, 0),
  });
  return { cfg, vocabSize, p };
}

function parameters(model) {
  const { p } = model, out = [p.tok, p.pos, ...p.lnF, p.head];
  for (const b of p.blocks) out.push(...b.ln1, b.wq, b.wk, b.wv, b.wo, ...b.ln2, b.w1, b.b1, b.w2, b.b2);
  return out;
}
const countParams = model => parameters(model).reduce((s, t) => s + t.size, 0);

/** Logits [len, V] for a token sequence (len ≤ ctx). */
function forward(model, ids) {
  const { cfg, p } = model, len = ids.length, dh = cfg.d / cfg.heads;
  if (!len || len > cfg.ctx) throw new Error(`sequence length must be 1..${cfg.ctx}`);
  let x = add(gatherRows(p.tok, ids), topRows(p.pos, len));
  for (const b of p.blocks) {
    const h = layerNorm(x, b.ln1[0], b.ln1[1]);
    const q = matmul(h, b.wq), k = matmul(h, b.wk), v = matmul(h, b.wv), heads = [];
    for (let i = 0; i < cfg.heads; i++) {
      const qi = sliceCols(q, i * dh, dh), ki = sliceCols(k, i * dh, dh), vi = sliceCols(v, i * dh, dh);
      heads.push(matmul(causalSoftmax(scale(matmul(qi, transpose(ki)), 1 / Math.sqrt(dh))), vi));
    }
    x = add(x, matmul(concatCols(heads), b.wo));
    const h2 = layerNorm(x, b.ln2[0], b.ln2[1]);
    x = add(x, addRow(matmul(relu(addRow(matmul(h2, b.w1), b.b1)), b.w2), b.b2));
  }
  return matmul(layerNorm(x, p.lnF[0], p.lnF[1]), p.head);
}

function softmaxRow(L, row) {
  const V = L.cols, out = new Array(V); let max = -Infinity;
  for (let j = 0; j < V; j++) max = Math.max(max, L.data[row * V + j]);
  let sum = 0; for (let j = 0; j < V; j++) { out[j] = Math.exp(L.data[row * V + j] - max); sum += out[j]; }
  return out.map(x => x / sum);
}

/** Adam over all parameters. */
function adam(params, lr = 0.01, b1 = 0.9, b2 = 0.999, eps = 1e-8) {
  const m = params.map(t => new Float64Array(t.size)), v = params.map(t => new Float64Array(t.size));
  let step = 0;
  return {
    zero() { for (const t of params) t.grad = new Float64Array(t.size); },
    step() {
      step++;
      params.forEach((t, k) => { if (!t.grad) return; for (let i = 0; i < t.size; i++) { const gr = Math.max(-5, Math.min(5, t.grad[i])); m[k][i] = b1 * m[k][i] + (1 - b1) * gr; v[k][i] = b2 * v[k][i] + (1 - b2) * gr * gr; const mh = m[k][i] / (1 - b1 ** step), vh = v[k][i] / (1 - b2 ** step); t.data[i] -= lr * mh / (Math.sqrt(vh) + eps); } });
    },
  };
}

/** Weights as plain arrays for storage, and back. */
function serialize(model) { return { cfg: model.cfg, vocabSize: model.vocabSize, weights: parameters(model).map(t => Array.from(t.data, x => Math.round(x * 1e6) / 1e6)) }; }
function deserialize(saved) {
  const model = createTransformer(saved.vocabSize, saved.cfg, 1), ps = parameters(model);
  if (ps.length !== saved.weights.length) throw new Error('saved weights do not match the configuration');
  ps.forEach((t, i) => { if (saved.weights[i].length !== t.size) throw new Error('saved weight shape mismatch'); t.data.set(saved.weights[i]); });
  return model;
}

module.exports = { T, rng, param, matmul, add, addRow, scale, relu, transpose, sliceCols, concatCols, gatherRows, topRows, causalSoftmax, layerNorm, crossEntropy, backward, DEFAULT_CONFIG, validConfig, createTransformer, parameters, countParams, forward, softmaxRow, adam, serialize, deserialize };
