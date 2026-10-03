'use strict';
/* HKDM script tensor T(α, β, γ, δ): every non-zero cell comes from a sourced record. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hkdm = require('../lib/hkdm-tensor');

test('the seed data is well formed: no errors, every script referenced', () => {
  const issues = hkdm.validate();
  assert.deepEqual(issues.filter(i => i.level === 'error'), []);
  const data = hkdm.load();
  assert.equal(data.status, 'draft');
  assert.ok(data.scripts.every(s => s.refs.length && s.refs.every(u => /^https:\/\//.test(u))));
  assert.ok(data.records.every(r => ['source', 'general'].includes(r.basis)));
});

test('the tensor has the four axes and the default shape 11 × 11 × 6 × 5', () => {
  const t = hkdm.build();
  assert.deepEqual(t.shape, [11, 11, 6, 5]);
  assert.equal(t.axes.alpha.values[0].label, '3500 BCE – 3000 BCE');
  assert.deepEqual(t.axes.delta.values.map(v => v.id), ['ltr', 'rtl', 'ttb', 'boustrophedon', 'unfixed']);
  assert.equal(hkdm.build({ bin: 100 }).shape[0], 55);
  assert.throws(() => hkdm.build({ bin: 7 }), /bin/);
});

test('cells hold what the records say, and nothing else', () => {
  // Kharoshthi on birch bark, right to left, an abugida, 1st–3rd century CE.
  const recs = hkdm.cell({ alpha: '0', beta: 'birch-bark', gamma: 'abugida', delta: 'rtl' });
  assert.deepEqual(recs.map(r => r.script), ['kharoshthi']);
  assert.match(recs[0].refs[0], /Kharosthi/);
  // No abugida is written right to left on palm leaf.
  assert.equal(hkdm.cell({ beta: 'palm-leaf', gamma: 'abugida', delta: 'rtl' }).length, 0);
  // Cuneiform: columns before the rotation, left to right after it.
  assert.ok(hkdm.cell({ alpha: '-3000', beta: 'clay', delta: 'ttb' }).some(r => r.script === 'cuneiform'));
  assert.ok(hkdm.cell({ alpha: '-1500', beta: 'clay', delta: 'ltr' }).some(r => r.script === 'cuneiform'));
  assert.ok(!hkdm.cell({ alpha: '-1500', beta: 'clay', delta: 'ttb' }).some(r => r.script === 'cuneiform'));
});

test('a projection counts distinct scripts and sums over the free axes', () => {
  const p = hkdm.project({ rows: 'alpha', cols: 'gamma' });
  const row = p.rowValues.findIndex(v => v.id === '0'), col = p.colValues.findIndex(v => v.id === 'abugida');
  assert.deepEqual(p.scripts[row][col], ['brahmi', 'devanagari', 'grantha', 'gupta', 'kharoshthi', 'sharada', 'tamil-brahmi']);
  assert.equal(p.matrix[row][col], 7, 'includes the debated early Devanagari and Sharada records');
  // Fixing δ = rtl leaves only Kharoshthi among abugidas in 0–500 CE.
  const rtl = hkdm.project({ rows: 'alpha', cols: 'gamma', filter: { delta: 'rtl' } });
  assert.deepEqual(rtl.scripts[row][col], ['kharoshthi']);
  assert.throws(() => hkdm.project({ rows: 'beta', cols: 'beta' }), /two different axes/);
  assert.throws(() => hkdm.project({ filter: { beta: 'vellum' } }), /Unknown beta/);
});

test('the confidence filter removes debated claims', () => {
  const all = hkdm.project({ rows: 'alpha', cols: 'gamma' });
  const firm = hkdm.project({ rows: 'alpha', cols: 'gamma', confidence: 'established' });
  const row = all.rowValues.findIndex(v => v.id === '-1000'), col = all.colValues.findIndex(v => v.id === 'abugida');
  assert.deepEqual(all.scripts[row][col], ['brahmi'], 'the Anuradhapura potsherds (debated)');
  assert.deepEqual(firm.scripts[row][col], []);
  // Hangul as 'featural' is itself debated, so it leaves the established view.
  assert.equal(firm.colValues.findIndex(v => v.id === 'featural') >= 0, true);
  assert.ok(firm.matrix.every(r => r[firm.colValues.findIndex(v => v.id === 'featural')] === 0));
});

test('lineage gaps use first established records; both Brahmi hypotheses are kept as debated', () => {
  const g = hkdm.gaps();
  const k = g.find(e => e.parent === 'aramaic' && e.child === 'kharoshthi');
  assert.equal(k.gap, -260 - -800);
  const brahmi = g.filter(e => e.child === 'brahmi');
  assert.deepEqual(brahmi.map(e => e.parent).sort(), ['aramaic', 'indus']);
  assert.ok(brahmi.every(e => e.confidence === 'debated'));
});

test('exports: the dense tensor agrees with the sparse cells, and the CSV has every record', () => {
  const x = hkdm.exportTensor();
  assert.equal(x.format, 'hkdm-tensor/1');
  assert.deepEqual(x.shape, [11, 11, 6, 5]);
  let sum = 0; for (const a of x.dense) for (const b of a) for (const c of b) for (const d of c) sum += d;
  assert.equal(sum, x.sparse.reduce((n, c) => n + c.count, 0));
  for (const c of x.sparse) { const [i, j, k, l] = c.at; assert.equal(x.dense[i][j][k][l], c.count); }
  const csv = hkdm.exportCsv();
  assert.equal(csv.trim().split('\n').length, hkdm.load().records.length + 1);
  assert.match(csv, /^id,script,from,to,beta,gamma,delta,confidence,basis,note,reference/);
  assert.equal(hkdm.exportCsv({ basis: 'source' }).trim().split('\n').length, hkdm.load().records.filter(r => r.basis === 'source').length + 1);
});

test('Omniglot cross-checks: every script named exists, disagreements are kept, and they shape the data', () => {
  const s = hkdm.summary();
  assert.ok(s.crossChecks.length >= 15);
  assert.ok(s.crossChecks.every(c => ['agree', 'partial', 'differ'].includes(c.verdict) && c.wikipedia && c.omniglot));
  assert.ok(s.crossChecks.some(c => c.script === 'devanagari' && c.verdict === 'differ'));
  // Where the sources differ on Devanagari's parent, both links are debated.
  const dev = hkdm.gaps().filter(e => e.child === 'devanagari');
  assert.deepEqual(dev.map(e => e.parent).sort(), ['gupta', 'siddham']);
  assert.ok(dev.every(e => e.confidence === 'debated'));
  // Proto-Sinaitic sits between Egyptian and Phoenician; its direction is not yet fixed.
  assert.ok(hkdm.gaps().some(e => e.parent === 'egyptian' && e.child === 'proto-sinaitic'));
  assert.deepEqual(hkdm.cell({ delta: 'unfixed' }).map(r => r.script), ['proto-sinaitic']);
  // Sharada's start follows Omniglot's earliest inscription.
  assert.equal(hkdm.load().records.find(r => r.id === 'sha-stone-ltr').from, 774);
  assert.ok(hkdm.load().scripts.find(x => x.id === 'sharada').refs.some(u => /omniglot\.com/.test(u)));
});

test('checked records carry their own references, and general knowledge is the minority', () => {
  const data = hkdm.load();
  const general = data.records.filter(r => r.basis === 'general');
  assert.ok(general.length <= 8, `${general.length} general records`);
  for (const id of ['chi-bamboo-ttb', 'ara-leather-rtl', 'arb-leather-rtl', 'lat-paper-ltr', 'tib-paper-ltr']) {
    const r = data.records.find(x => x.id === id);
    assert.equal(r.basis, 'source', id);
    assert.ok(r.refs.length, id);
  }
  // The cell view lists the record's own pages first.
  const [aram] = hkdm.cell({ beta: 'leather', gamma: 'abjad' }).filter(r => r.id === 'ara-leather-rtl');
  assert.match(aram.refs[0], /Khalili/);
  // A source that contradicts another is kept as a debated record.
  assert.equal(data.records.find(r => r.id === 'sha-birch-early').confidence, 'debated');
});
