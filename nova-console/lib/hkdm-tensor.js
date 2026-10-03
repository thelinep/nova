'use strict';
/* ===========================================================================
 * HKDM script tensor T(α, β, γ, δ)
 *
 *   α  epoch        time bins (default 500 years, 3500 BCE – 2000 CE)
 *   β  substrate    clay, stone, metal, bone-shell, wood-bamboo, birch-bark,
 *                   palm-leaf, papyrus, leather, silk, paper
 *   γ  architecture logographic, abjad, alphabet, abugida, featural,
 *                   undeciphered
 *   δ  direction    ltr, rtl, ttb (columns), boustrophedon, unfixed (mixed)
 *
 * What a cell holds: the scripts attested with that substrate, architecture
 * and direction during that epoch. The tensor value is their count; every
 * cell can be opened to the records behind it. A record is one attestation
 * (script, years, β, γ, δ) with a note, a confidence (established | debated)
 * and a basis (source = stated on the script's reference page; general =
 * general knowledge, not yet checked against a page). The seed data is a
 * draft for an epigraphist to review (lib/hkdm-scripts.json).
 *
 * Nothing here is inferred: a cell is non-zero only because a record says so.
 * ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'hkdm-scripts.json');
const AXIS_KEYS = ['alpha', 'beta', 'gamma', 'delta'];
const CONFIDENCE = ['established', 'debated'];
const BASIS = ['source', 'general'];

let cache = null;
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function load() { if (!cache) cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return cache; }

function yearLabel(y) { return y < 0 ? `${-y} BCE` : y === 0 ? '0' : `${y} CE`; }
function yearLabelHi(y) { return y < 0 ? `${-y} ईपू` : `${y} ई`; }

/** The α bins for a bin size. Each bin is [start, end). */
function epochs(data, bin) {
  const a = data.axes.alpha, size = bin || a.bin, out = [];
  if (!Number.isInteger(size) || size < 50 || size > 2000) throw error('The epoch bin must be a whole number of years from 50 to 2000.');
  for (let s = a.from; s < a.to; s += size) {
    const e = Math.min(s + size, a.to);
    out.push({ id: String(s), from: s, to: e, label: `${yearLabel(s)} – ${yearLabel(e)}`, hi: `${yearLabelHi(s)} – ${yearLabelHi(e)}` });
  }
  return out;
}

/** The four axes, with α resolved for the bin size. */
function axes(data = load(), bin) {
  const v = list => list.map(([id, label, hi]) => ({ id, label, hi }));
  return {
    alpha: { ...data.axes.alpha, values: epochs(data, bin) },
    beta: { ...data.axes.beta, values: v(data.axes.beta.values) },
    gamma: { ...data.axes.gamma, values: v(data.axes.gamma.values) },
    delta: { ...data.axes.delta, values: v(data.axes.delta.values) },
  };
}

/** Problems with the data; an empty list means every record is well formed. */
function validate(data = load()) {
  const issues = [];
  const ids = new Set(), scripts = new Set(data.scripts.map(s => s.id));
  const vocab = k => new Set(data.axes[k].values.map(v => v[0]));
  const B = vocab('beta'), G = vocab('gamma'), D = vocab('delta');
  for (const s of data.scripts) if (!Array.isArray(s.refs) || !s.refs.length) issues.push({ level: 'error', where: s.id, message: 'A script needs at least one reference.' });
  for (const r of data.records) {
    const at = r.id || '(no id)';
    if (!r.id || ids.has(r.id)) issues.push({ level: 'error', where: at, message: 'Record ids must be present and unique.' });
    ids.add(r.id);
    if (!scripts.has(r.script)) issues.push({ level: 'error', where: at, message: `Unknown script ${r.script}.` });
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from > r.to) issues.push({ level: 'error', where: at, message: 'Years must be whole numbers with from ≤ to.' });
    if (r.from < data.axes.alpha.from || r.to > data.axes.alpha.to) issues.push({ level: 'error', where: at, message: 'Years fall outside the α axis.' });
    if (!B.has(r.beta)) issues.push({ level: 'error', where: at, message: `Unknown substrate ${r.beta}.` });
    if (!G.has(r.gamma)) issues.push({ level: 'error', where: at, message: `Unknown architecture ${r.gamma}.` });
    if (!D.has(r.delta)) issues.push({ level: 'error', where: at, message: `Unknown direction ${r.delta}.` });
    if (!CONFIDENCE.includes(r.confidence)) issues.push({ level: 'error', where: at, message: 'Confidence must be established or debated.' });
    if (!BASIS.includes(r.basis)) issues.push({ level: 'error', where: at, message: 'Basis must be source or general.' });
    if (r.refs && (!Array.isArray(r.refs) || r.refs.some(u => !/^https:\/\//.test(u)))) issues.push({ level: 'error', where: at, message: 'Record references must be https links.' });
    if (!r.note || r.note.length < 10) issues.push({ level: 'error', where: at, message: 'Every record needs a note saying what is attested.' });
  }
  for (const e of data.lineage) {
    const at = `${e.parent} → ${e.child}`;
    if (!scripts.has(e.parent) || !scripts.has(e.child)) issues.push({ level: 'error', where: at, message: 'Lineage names an unknown script.' });
    if (!CONFIDENCE.includes(e.confidence)) issues.push({ level: 'error', where: at, message: 'Confidence must be established or debated.' });
    if (!e.ref) issues.push({ level: 'error', where: at, message: 'A lineage link needs a reference.' });
  }
  for (const c of data.crossChecks || []) {
    const at = `cross-check ${c.script}: ${c.topic}`;
    if (!scripts.has(c.script)) issues.push({ level: 'error', where: at, message: 'Cross-check names an unknown script.' });
    if (!['agree', 'partial', 'differ'].includes(c.verdict)) issues.push({ level: 'error', where: at, message: 'Verdict must be agree, partial or differ.' });
    if (!c.wikipedia || !c.omniglot) issues.push({ level: 'error', where: at, message: 'A cross-check states what each source says.' });
  }
  for (const g of gaps(data)) if (g.gap != null && g.gap < 0) issues.push({ level: 'warning', where: `${g.parent} → ${g.child}`, message: `The child's first established record is ${-g.gap} years older than the parent's.` });
  return issues;
}

/** Records kept by the filters: confidence 'established' drops debated records; basis 'source' drops general knowledge. */
function selected(data, { confidence = 'all', basis = 'all' } = {}) {
  return data.records.filter(r => (confidence === 'all' || r.confidence === confidence) && (basis === 'all' || r.basis === basis));
}

/** Index of each axis value. */
function indexOf(ax) { const m = {}; for (const k of AXIS_KEYS) m[k] = new Map(ax[k].values.map((v, i) => [v.id, i])); return m; }

/** The α bins a record touches: every bin its [from, to] overlaps. */
function touches(r, e) { return r.from === r.to ? r.from >= e.from && r.from < e.to : r.from < e.to && r.to > e.from; }
function binsOf(r, ax) { return ax.alpha.values.map((v, i) => (touches(r, v) ? i : -1)).filter(i => i >= 0); }

/**
 * Builds the tensor. Returns the shape, the axes and the non-zero cells, each with the
 * scripts and record ids behind it. counts(i,j,k,l) = number of distinct scripts.
 */
function build(opts = {}) {
  const data = load(), ax = axes(data, opts.bin), idx = indexOf(ax);
  const shape = AXIS_KEYS.map(k => ax[k].values.length);
  const cells = new Map();
  for (const r of selected(data, opts)) {
    const j = idx.beta.get(r.beta), k = idx.gamma.get(r.gamma), l = idx.delta.get(r.delta);
    for (const i of binsOf(r, ax)) {
      const key = `${i},${j},${k},${l}`;
      if (!cells.has(key)) cells.set(key, { at: [i, j, k, l], scripts: new Set(), records: [] });
      const c = cells.get(key); c.scripts.add(r.script); c.records.push(r.id);
    }
  }
  return { shape, axes: ax, cells, records: selected(data, opts) };
}

function parseFilter(ax, filter = {}) {
  const out = {};
  for (const k of AXIS_KEYS) {
    if (filter[k] == null || filter[k] === '' || filter[k] === 'all') continue;
    const i = ax[k].values.findIndex(v => v.id === String(filter[k]));
    if (i < 0) throw error(`Unknown ${k} value: ${filter[k]}.`);
    out[k] = i;
  }
  return out;
}

/**
 * Two-axis view: rows × cols, the other two axes fixed by filter or summed over.
 * A cell counts distinct scripts (a script on stone and on metal in one epoch counts once).
 */
function project({ rows = 'alpha', cols = 'beta', filter = {}, ...opts } = {}) {
  if (!AXIS_KEYS.includes(rows) || !AXIS_KEYS.includes(cols) || rows === cols) throw error('Choose two different axes from alpha, beta, gamma and delta.');
  const t = build(opts), f = parseFilter(t.axes, filter);
  const R = t.axes[rows].values, C = t.axes[cols].values;
  const sets = R.map(() => C.map(() => new Set()));
  const pos = { alpha: 0, beta: 1, gamma: 2, delta: 3 };
  for (const c of t.cells.values()) {
    if (Object.entries(f).some(([k, i]) => c.at[pos[k]] !== i)) continue;
    for (const s of c.scripts) sets[c.at[pos[rows]]][c.at[pos[cols]]].add(s);
  }
  const matrix = sets.map(row => row.map(s => s.size));
  const scripts = sets.map(row => row.map(s => [...s].sort()));
  const total = new Set(sets.flat().flatMap(s => [...s])).size;
  return { rows, cols, filter: Object.fromEntries(Object.entries(f).map(([k, i]) => [k, t.axes[k].values[i].id])), rowValues: R, colValues: C, matrix, scripts, max: Math.max(0, ...matrix.flat()), scriptsInView: total };
}

/** The records behind a cell or a slice. Any axis left out is not fixed. */
function cell(filter = {}, opts = {}) {
  const data = load(), ax = axes(data, opts.bin), f = parseFilter(ax, filter);
  const byId = new Map(data.scripts.map(s => [s.id, s]));
  return selected(data, opts).filter(r => {
    if ('beta' in f && ax.beta.values[f.beta].id !== r.beta) return false;
    if ('gamma' in f && ax.gamma.values[f.gamma].id !== r.gamma) return false;
    if ('delta' in f && ax.delta.values[f.delta].id !== r.delta) return false;
    if ('alpha' in f && !touches(r, ax.alpha.values[f.alpha])) return false;
    return true;
  }).map(r => ({ ...r, scriptName: byId.get(r.script)?.name, scriptHi: byId.get(r.script)?.hi, refs: [...new Set([...(r.refs || []), ...(byId.get(r.script)?.refs || [])])] }));
}

/** First established attestation of each script (debated early claims are not used for gaps). */
function firstAttested(data) {
  const m = new Map();
  for (const r of data.records) if (r.confidence === 'established') m.set(r.script, Math.min(m.has(r.script) ? m.get(r.script) : Infinity, r.from));
  return m;
}

/** Lineage links with the years between the parent's and the child's first established records. */
function gaps(data = load()) {
  const first = firstAttested(data);
  return data.lineage.map(e => ({ ...e, parentFirst: first.get(e.parent) ?? null, childFirst: first.get(e.child) ?? null, gap: first.has(e.parent) && first.has(e.child) ? first.get(e.child) - first.get(e.parent) : null }));
}

function summary(opts = {}) {
  const data = load(), t = build(opts), issues = validate(data);
  const records = t.records;
  return {
    format: data.format, title: data.title, status: data.status, note: data.note,
    axes: t.axes, shape: t.shape, cellsTotal: t.shape.reduce((a, b) => a * b, 1), cellsNonZero: t.cells.size,
    scripts: data.scripts.map(s => ({ ...s, records: records.filter(r => r.script === s.id).length })),
    counts: { scripts: data.scripts.length, records: records.length, allRecords: data.records.length, established: records.filter(r => r.confidence === 'established').length, debated: records.filter(r => r.confidence === 'debated').length, fromSource: records.filter(r => r.basis === 'source').length, general: records.filter(r => r.basis === 'general').length },
    lineage: gaps(data), crossChecks: (data.crossChecks || []).map(c => ({ ...c, scriptName: data.scripts.find(s => s.id === c.script)?.name })), issues,
  };
}

/** The dense count tensor (nested arrays [α][β][γ][δ]) plus the sparse cells with their scripts. */
function exportTensor(opts = {}) {
  const t = build(opts);
  const dense = Array.from({ length: t.shape[0] }, () => Array.from({ length: t.shape[1] }, () => Array.from({ length: t.shape[2] }, () => Array(t.shape[3]).fill(0))));
  const sparse = [];
  for (const c of [...t.cells.values()].sort((a, b) => a.at.join(',').localeCompare(b.at.join(','), undefined, { numeric: true }))) {
    const [i, j, k, l] = c.at; dense[i][j][k][l] = c.scripts.size;
    sparse.push({ at: c.at, count: c.scripts.size, scripts: [...c.scripts].sort(), records: c.records });
  }
  const data = load();
  return { format: 'hkdm-tensor/1', status: data.status, note: data.note, filters: { bin: t.axes.alpha.values[0].to - t.axes.alpha.values[0].from, confidence: opts.confidence || 'all', basis: opts.basis || 'all' },
    axes: Object.fromEntries(AXIS_KEYS.map(k => [k, { symbol: t.axes[k].symbol, name: t.axes[k].name, values: t.axes[k].values.map(v => v.id) }])), shape: t.shape, dense, sparse };
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportCsv(opts = {}) {
  const data = load(), byId = new Map(data.scripts.map(s => [s.id, s]));
  const head = ['id', 'script', 'from', 'to', 'beta', 'gamma', 'delta', 'confidence', 'basis', 'note', 'reference'];
  return [head.join(',')].concat(selected(data, opts).map(r => [r.id, r.script, r.from, r.to, r.beta, r.gamma, r.delta, r.confidence, r.basis, r.note, [...new Set([...(r.refs || []), ...(byId.get(r.script)?.refs || [])])].join(' ')].map(csvCell).join(','))).join('\n') + '\n';
}

module.exports = { AXIS_KEYS, load, axes, validate, build, project, cell, gaps, summary, exportTensor, exportCsv, _reset: () => { cache = null; } };
