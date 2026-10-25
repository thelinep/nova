'use strict';
// Lipi OS and the Rakhigarhi platform: the many-script converter, the absorbed prototype data,
// recomputed prices and budgets, the four stores, and the HTTP routes on a temporary data folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const lipi = require('../lib/lipi-scripts');
const heritage = require('../lib/heritage');
const { STORE_NAMES } = require('../lib/db');

function store() { const s = new Map(); return { all(n) { return [...(s.get(n)?.values() || [])].map(r => JSON.parse(JSON.stringify(r))); }, get(n, id) { const r = s.get(n)?.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; }, put(n, r) { if (!s.has(n)) s.set(n, new Map()); s.get(n).set(r.id, JSON.parse(JSON.stringify(r))); return r; }, delete(n, id) { s.get(n)?.delete(id); } }; }
const LIPI_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'heritage-data', 'lipi-os.json'), 'utf8'));
const RAKHI_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'heritage-data', 'rakhigarhi.json'), 'utf8'));
const cps = s => [...s].map(c => c.codePointAt(0));

test('the Hindi welcome matches the prototype in all eleven scripts that share a convention', () => {
  const w = lipi.welcome(), ref = Object.fromEntries(LIPI_DATA.welcomeReference.map(r => [r.id, r.rendering]));
  assert.equal(w.results.length, 12);
  assert.equal(w.spelled, 'आप्का स्वागत है', 'Hindi drops the medial a of आपका; स्वागत keeps its sounded a');
  for (const r of w.results) {
    assert.deepEqual(r.missing, [], `${r.code} writes every letter of the phrase`);
    if (r.code === 'Khar') { assert.equal(r.text, ref.Khar + String.fromCodePoint(0x10A0C), 'Kharoshthi differs only by Guru’s length mark on ai'); continue; }
    assert.equal(r.text, ref[r.code], `${r.label} matches the prototype rendering`);
  }
});

test('tables come from Unicode names: long e/o in Dravidian scripts, va as ba in Bengali, Kawi stacks with the conjoiner', () => {
  const one = (t, c) => lipi.fromDeva(t, c).text;
  assert.equal(one('ए', 'Telu'), 'ఏ'); assert.equal(one('ऎ', 'Telu'), 'ఎ'); assert.equal(one('के', 'Knda'), 'ಕೇ');
  assert.deepEqual(cps(one('ओ', 'Gran')), [0x11313]);
  assert.equal(one('व', 'Beng'), 'ব');
  assert.deepEqual(cps(one('स्व', 'Kawi')), [0x11F31, 0x11F42, 0x11F2E], 'a virama before a consonant becomes the Kawi conjoiner');
  assert.equal(cps(one('क्', 'Kawi')).at(-1), 0x11F41, 'a final virama stays the killer');
  const takri = lipi.fromDeva('ऋषि', 'Takr');
  assert.deepEqual(takri.missing.sort(), ['ऋ', 'ष'].sort(), 'letters Takri lacks are kept in Devanagari and reported');
  assert.ok(takri.text.includes('ऋ'));
  assert.deepEqual(cps(one('क़', 'Brah')), [0x11013], 'a nukta with no counterpart is dropped, the base letter stands');
  const list = lipi.list();
  assert.equal(list.length, 26, 'Devanagari plus twenty-four scripts, and Brahmi+');
  assert.deepEqual(list.slice(0, 4).map(s => s.code), ['Deva', 'Khar', 'Brah', 'Brah+'], 'historic scripts come before modern ones');
  assert.equal(list.find(s => s.code === 'Khar').direction, 'rtl');
  for (const s of list) if (s.coverage != null) assert.ok(s.coverage >= 0.75, `${s.code} covers at least three quarters of the core letters`);
});

test('every script reads back to the same Devanagari, apart from letters it cannot write', () => {
  const core = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'lipi-scripts.json'), 'utf8'));
  const sample = 'अ आ इ ई उ ऊ ए ऐ ओ औ कं खः गँ घ ङ च छ ज झ ञ ट ठ ड ढ ण त थ द ध न प फ ब भ म य र ल व श ष स ह क्ष ज्ञ कि की कु कू के कै को कौ धर्म';
  let tested = 0;
  for (const [code] of Object.entries(core.scripts)) {
    if (code === 'Beng') continue; // va and ba share one letter
    const { text, missing } = lipi.fromDeva(sample, code);
    if (missing.length) continue;
    assert.equal(lipi.toDeva(text), sample.normalize('NFC'), `${code} round-trips`); tested++;
  }
  assert.ok(tested >= 10, `${tested} scripts round-trip the sample`);
  assert.equal(lipi.toDeva('DarmaH'), 'धर्मः', 'Latin letters are read as SLP1');
  assert.throws(() => lipi.toDeva(String.fromCodePoint(0x10A10)), /Kharoshthi can be written here but not read back/);
});

test('Hindi pronunciation spelling follows the schwa-deletion rule and leaves short words alone', () => {
  const cases = { 'आपका': 'आप्का', 'स्वागत': 'स्वागत', 'है': 'है', 'कमला': 'कम्ला', 'समझ': 'समझ', 'समझना': 'समझ्ना', 'कल': 'कल', 'नमस्ते': 'नमस्ते', 'abc': 'abc' };
  for (const [a, b] of Object.entries(cases)) assert.equal(lipi.hindiSpelling(a), b, a);
  assert.equal(lipi.hindiSpelling('आपका  स्वागत'), 'आप्का  स्वागत', 'spacing is kept');
});

test('convert validates input and reports every requested script', () => {
  assert.throws(() => lipi.convert('  '), /Type some text/);
  assert.throws(() => lipi.convert('क'.repeat(5001)), /at most 5,000/);
  assert.throws(() => lipi.convert('क', { scripts: ['Xyzz'] }), /does not know: Xyzz/);
  const r = lipi.convert('धर्म', { scripts: ['Deva', 'Brah', 'Shrd'] });
  assert.deepEqual(r.results.map(x => x.code), ['Deva', 'Brah', 'Shrd']);
  assert.equal(r.iast, 'dharma'); assert.equal(r.spelling, 'as-written');
  assert.equal(lipi.convert('आपका', { hindi: true, scripts: ['Deva'] }).results[0].text, 'आप्का');
});

test('the absorbed prototype data is complete and keeps its caveats', () => {
  assert.equal(LIPI_DATA.registry.length, 69); assert.equal(new Set(LIPI_DATA.registry.map(r => r.code)).size, 69);
  assert.deepEqual(LIPI_DATA.registry.filter(r => r.exhibitionOnly).map(r => r.code), ['Inds']);
  assert.equal(LIPI_DATA.courses.length, 6); assert.equal(LIPI_DATA.catalogs.length, 4); assert.equal(LIPI_DATA.workshops.length, 11); assert.equal(LIPI_DATA.futurism.workshops.length, 9);
  assert.ok(LIPI_DATA.workshops.every(w => w.qa && w.qa.checks.length === 3), 'every workshop carries its QA checkpoints');
  assert.equal(LIPI_DATA.chronology.events.length, 23); assert.equal(LIPI_DATA.atlas.length, 4);
  for (const e of [...LIPI_DATA.chronology.events, ...LIPI_DATA.chronology.scriptEvents]) { assert.match(e.sourceUrl, /^https:\/\//, e.id); assert.ok(e.evidenceNote, e.id); }
  for (const s of LIPI_DATA.atlas) { assert.ok(s.coordinates.latitude > 6 && s.coordinates.latitude < 37.5 && s.coordinates.longitude > 66 && s.coordinates.longitude < 98, s.id); assert.ok(s.imageCredit); }
  assert.equal(RAKHI_DATA.mounds.length, 7); assert.equal(RAKHI_DATA.indiaSites.length, 12); assert.equal(RAKHI_DATA.activities.length, 25); assert.equal(RAKHI_DATA.packages.length, 9);
  assert.ok(RAKHI_DATA.mounds.every(m => /Illustrative marker only/.test(m.summary)));
  assert.ok(RAKHI_DATA.news.every(n => n.category === 'DEMO CONTENT'));
  assert.equal(RAKHI_DATA.literature.references.length, 5); assert.equal(RAKHI_DATA.itinerary.callSheet.blocks.length, 13);
  assert.match(RAKHI_DATA.status, /concept prototype/);
});

test('registry, learning and chronology views', () => {
  const r = heritage.registry();
  assert.equal(r.total, 69); assert.equal(r.tiers.reduce((a, t) => a + t.count, 0), 69);
  assert.ok(r.records.find(x => x.code === 'Shrd').convertible); assert.ok(!r.records.find(x => x.code === 'Inds').convertible);
  assert.equal(r.convertible, r.records.filter(x => x.convertible).length);
  assert.deepEqual(heritage.registry({ q: 'nepal' }).records.map(x => x.code).sort(), ['Newa', 'PrcN', 'Ranj']);
  assert.ok(heritage.registry({ tier: 'FLAGSHIP' }).records.every(x => x.tier === 'FLAGSHIP'));
  const L = heritage.learning();
  assert.ok(L.workshops.every(w => w.matchesRuntime), 'session minutes add up to each workshop runtime');
  assert.equal(L.workshops[5].sessions[6].start, 135);
  assert.deepEqual(L.futurism.workshops.map(w => w.computed.perParticipant), L.futurism.workshops.map(w => w.price), 'every draft price is reproduced from the stated basis');
  const c = heritage.chronology({ continent: 'europe' });
  assert.ok(c.dated.every(e => e.continent === 'europe')); assert.equal(c.continents.reduce((a, x) => a + x.count, 0), 23);
  assert.ok(heritage.chronology({ category: 'scripts' }).dated.every(e => e.entityTypes.includes('scripts') || e.entities.scripts.length));
  const w = heritage.chronology({ from: -3000, to: 0 });
  assert.ok(w.dated.every(e => e.dateSort >= -3000 && e.dateSort <= 0)); assert.equal(w.undated.length, 1, 'undated records are never dropped by the time window');
  const sorted = heritage.chronology().dated.map(e => e.dateSort);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b));
});

test('field-visit estimate and the 7-day budget reproduce the prototype figures', () => {
  const e = heritage.fieldVisitEstimate();
  assert.equal(e.priced, 31943); assert.equal(e.scheduled, 35137); assert.deepEqual(e.unpriced, ['Field-session materials / hosting', 'Day 2 guests’ inbound transport', 'Airfare']);
  const by = Object.fromEntries(e.scenarios.map(s => [s.attendees, [s.total, s.perAttendee]]));
  assert.deepEqual(by, { 1: [29682, 29682], 3: [33509, 11170], 5: [41956, 8391], 6: [42770, 7128], 10: [59664, 5966], 15: [74951, 4997], 20: [92659, 4633] });
  const b = heritage.budgetModel({ adults: 1 });
  assert.equal(b.selected.perPerson, 80894); assert.deepEqual(b.samples.map(s => s.perPerson), [28230, 24497, 23030, 21697]);
  const custom = heritage.budgetModel({ adults: 4, mealsPerDay: 1000, vehiclePerDay: 6000, learningPerPerson: 0 });
  assert.equal(custom.selected.rooms, 2); assert.equal(custom.selected.perPerson, Math.round(2 * 1999 * 6 / 4 + 7000 + 6000 * 7 / 4));
  assert.equal(heritage.budgetModel({ adults: 99 }).inputs.adults, 20, 'group size is clamped to 20');
  assert.equal(heritage.budgetModel({ adults: 6, mealsPerDay: null }).selected.perPerson, 28230, 'a missing input keeps its default');
});

test('reading desk, newsroom editions, itinerary drafts and providers are kept in their stores', () => {
  for (const n of ['lipiReadings', 'lipiEditions', 'heritageItinerary', 'heritageProviders']) assert.ok(STORE_NAMES.includes(n), n);
  const db = store();
  assert.throws(() => heritage.saveReading(db, { title: ' ' }), /title/);
  assert.throws(() => heritage.saveReading(db, { title: 'X', url: 'javascript:alert(1)' }), /http/);
  const r = heritage.saveReading(db, { title: 'Ashtadhyayi', author: 'Panini', script: 'Sharada', url: 'https://gretil.sub.uni-goettingen.de/' });
  assert.equal(r.status, 'to-read'); assert.equal(heritage.saveReading(db, { ...r, status: 'done' }, r.id).status, 'done');
  assert.equal(heritage.readings(db).length, 1); heritage.removeReading(db, r.id); assert.equal(heritage.readings(db).length, 0);

  const ed = heritage.saveEdition(db, { masthead: 'Vaigyaaniq Times', theme: 'nope', lanes: [{ language: 'Sanskrit', script: 'Brah', headline: '𑀥𑀭𑁆𑀫' }, { script: 'Klingon' }] });
  assert.equal(ed.theme, 'heritage'); assert.equal(ed.lanes[1].script, 'Deva', 'an unknown script falls back to Devanagari'); assert.equal(ed.lanes[0].method, 'typed');
  assert.equal(heritage.saveEdition(db, { lanes: [...ed.lanes, { script: 'Latn' }] }, ed.id).lanes.length, 3);
  assert.throws(() => heritage.saveEdition(db, {}, 'ed_missing'), /Unknown edition/);
  const ins = heritage.inspectText('धर्म 𑀥𑀭𑁆𑀫 ok');
  assert.deepEqual(ins.scripts.map(s => s.name), ['Devanagari', 'Brahmi', 'Latin']); assert.equal(ins.nfc, true);

  const it = heritage.saveItinerary(db, { items: ['local-welcome', 'not-real', 'documentary-field-day', 'heritage-walk'], group: 50, date: 'soon' });
  assert.deepEqual(it.items, ['local-welcome', 'documentary-field-day', 'heritage-walk']); assert.equal(it.group, 20); assert.equal(it.date, '');
  assert.equal(it.minutes, 30 + 90, 'packages without minute durations add nothing');

  heritage.saveProvider(db, { name: 'Ravi', roles: 'line producer, runner', rate: 15000, verified: true });
  heritage.saveProvider(db, { name: 'Asha', roles: ['line producer'], rate: 12000, verified: true, certifications: [{ name: 'First aid', expires: '2025-01-01' }] });
  heritage.saveProvider(db, { name: 'Cheap Cabs', kind: 'vendor', roles: 'vehicle', rate: 3045 });
  assert.throws(() => heritage.saveProvider(db, { name: '' }), /name/);
  const m = heritage.matchProviders(db, '2026-10-25'), need = id => m.needs.find(n => n.id === id);
  assert.equal(need('line-producer').proposed.name, 'Ravi', 'an expired certification keeps a cheaper provider out');
  assert.deepEqual(need('line-producer').needsReview.map(x => x.reason), ['certification expired']);
  assert.equal(need('local-vehicle').proposed, null); assert.equal(need('local-vehicle').needsReview[0].reason, 'not verified');
  assert.equal(need('runner').proposed.name, 'Ravi');
  assert.match(m.note, /Nothing is booked or sent/);
});

test('HTTP routes on a temporary data folder', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-lipi-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "require('./server');"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, OLLAMA_HOST: 'http://127.0.0.1:9', NOVA_LIBRARY_DIR: path.join(dir, 'library') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('Startup timeout: ' + out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); child.stderr.on('data', d => { out += d; }); child.once('exit', c => reject(new Error('exited ' + c + ': ' + out))); });
    const req = (p, method = 'GET', body) => new Promise((resolve, reject) => { const r = http.request(base + p, { method, headers: { Origin: base, 'Content-Type': 'application/json' } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { const t = Buffer.concat(c).toString(); let json = null; try { json = JSON.parse(t); } catch (_) { json = null; } resolve({ status: res.statusCode, type: res.headers['content-type'], json }); }); }); r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined); });
    assert.equal((await req('/api/lipi/scripts')).json.length, 26);
    const conv = await req('/api/lipi/convert', 'POST', { text: 'आपका स्वागत है', hindi: true, scripts: ['Brah'] });
    assert.equal(conv.status, 200); assert.equal(conv.json.results[0].text, '𑀆𑀧𑁆𑀓𑀸 𑀲𑁆𑀯𑀸𑀕𑀢 𑀳𑁃');
    assert.equal((await req('/api/lipi/convert', 'POST', { text: '' })).status, 400);
    const ov = (await req('/api/lipi/os')).json; assert.equal(ov.welcome.results.length, 12); assert.equal(ov.registry.total, 69);
    assert.equal((await req('/api/lipi/registry?tier=PILOT')).json.records.every(r => r.tier === 'PILOT'), true);
    assert.equal((await req('/api/lipi/learning')).json.workshops.length, 11);
    const africa = (await req('/api/lipi/chronology?continent=africa')).json; assert.ok(africa.dated.length > 0 && africa.dated.every(e => e.continent === 'africa'));
    const read = await req('/api/lipi/readings', 'POST', { title: 'Rigveda' }); assert.equal(read.status, 201);
    assert.equal((await req('/api/lipi/readings/' + read.json.id, 'PUT', { ...read.json, status: 'reading' })).json.status, 'reading');
    assert.equal((await req('/api/lipi/readings')).json.length, 1);
    assert.equal((await req('/api/lipi/readings/' + read.json.id, 'DELETE')).status, 200);
    assert.equal((await req('/api/lipi/readings/' + read.json.id, 'DELETE')).status, 404);
    assert.equal((await req('/api/lipi/editions', 'POST', { lanes: [{ language: 'Hindi', script: 'Deva', headline: 'नमस्ते' }] })).status, 201);
    assert.equal((await req('/api/lipi/inspect', 'POST', { text: 'नमस्ते' })).json.graphemes, 3);
    const rk = (await req('/api/heritage/rakhigarhi')).json; assert.equal(rk.itinerary.estimate.scheduled, 35137); assert.equal(rk.mounds.length, 7);
    assert.equal((await req('/api/heritage/budget?adults=6')).json.selected.perPerson, 28230);
    assert.deepEqual((await req('/api/heritage/estimate?headcounts=5,99')).json.scenarios.map(s => s.attendees), [5]);
    assert.equal((await req('/api/heritage/itineraries', 'POST', { items: ['local-welcome'] })).json.minutes, 30);
    assert.equal((await req('/api/heritage/providers', 'POST', { name: 'Ravi', roles: 'runner', verified: true, rate: 2000 })).status, 201);
    assert.equal((await req('/api/heritage/providers/match')).json.needs.find(n => n.id === 'runner').proposed.name, 'Ravi');
    const font = await req('/fonts/lipi/noto-sans-brahmi-brahmi-400-normal.woff2'); assert.equal(font.status, 200); assert.equal(font.type, 'font/woff2');
    for (const f of ['/lipi-os.js', '/heritage.js']) assert.equal((await req(f)).status, 200);
  } finally { child.kill('SIGTERM'); }
});
