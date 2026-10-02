'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const aai = require('../lib/aai');
const slp1 = require('../lib/slp1');
const panini = require('../lib/panini');

aai.configure({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aai-')) });
let engine = false;
test('engine status reports the principle, texts and licences', async () => {
  const st = await aai.status();
  engine = st.engine.installed;
  assert.match(st.principle, /nothing is called correct unless the rules confirm it/);
  assert.equal(st.texts.total, 3983);
  assert.equal(st.texts.dhatus, 2229);
  assert.ok(st.licences.some(l => /Vidyut/.test(l)));
});

test('SLP1 conversion matches every sutra in both directions', () => {
  const data = require('../lib/panini-data.json');
  for (const [id, deva, iast, s] of data.sutras) {
    assert.equal(slp1.toDevanagari(s), deva, id);
    assert.equal(slp1.toIast(s), iast, id);
    if (!s.includes('≍')) assert.equal(slp1.fromDevanagari(deva), s, id);
  }
});

test('Lipi converts any supported script into all of them', () => {
  const r = aai.lipi({ text: 'इको यणचि' });
  assert.equal(r.iast, 'iko yaṇaci');
  assert.equal(r.slp1, 'iko yaRaci');
  assert.equal(aai.lipi({ text: r.siddham }).devanagari, 'इको यणचि');
  assert.equal(aai.lipi({ text: r.brahmi }).devanagari, 'इको यणचि');
  assert.equal(aai.lipi({ text: 'vfdDirAdEc' }).devanagari, 'वृद्धिरादैच्');
  assert.throws(() => aai.lipi({ text: r.kharoshthi }), /not read yet/);
});

test('citation checks catch wrong numbers and misattributed quotes', () => {
  const got = Object.fromEntries(panini.checkCitations('6.1.77 इको यणचि। 6.1.87 इको यणचि। 1.1.101। अदेङ्गुणः (1.1.2)').map(c => [c.id, c.status]));
  assert.deepEqual(got, { '6.1.77': 'ok', '6.1.87': 'mismatch', '1.1.101': 'unknown', '1.1.2': 'ok' });
});

test('ask: the model proposes, the sutras decide the verdict', async () => {
  const fake = text => ({ chatFull: async (_model, messages) => { fake.last = messages; return { message: { content: text } }; } });
  const wrong = await aai.ask({ ollama: fake('यह 6.1.87 इको यणचि से होता है।'), question: 'भवति में 6.1.78 कैसे लगता है?', model: 'm' });
  assert.equal(wrong.verdict, 'contradicted');
  assert.match(fake.last[0].content, /6\.1\.78 एचोऽयवायावः/); // the exact sutra text was given to the model
  const right = await aai.ask({ ollama: fake('6.1.78 एचोऽयवायावः से ओ का अव् होता है।'), question: 'भवति में 6.1.78?', model: 'm' });
  assert.equal(right.verdict, 'citations-verified');
  const none = await aai.ask({ ollama: fake('मुझे नहीं पता।'), question: 'कुछ भी?', model: 'm' });
  assert.equal(none.verdict, 'unverified');
  await assert.rejects(aai.ask({ ollama: fake('x'), question: 'प्रश्न', model: 'm', killSwitch: { isHalted: () => true } }), /halted/);
});

test('derivations cite a sutra at every step (needs the engine)', async (t) => {
  if (!engine) return t.skip('derivation engine not installed on this computer');
  const v = await aai.deriveVerb({ code: '01.0001', lakara: 'Lat' });
  assert.deepEqual(v.forms.map(f => f.text), ['भवति']);
  const steps = v.forms[0].steps;
  assert.ok(steps.every(s => s.code));
  assert.ok(steps.some(s => s.code === '6.1.78' && s.sutra === 'एचोऽयवायावः'));
  assert.equal(steps.at(-1).result, 'भव् + अ + ति');
  const g = await aai.paradigm({ code: '08.0010', lakara: 'Lat' });
  assert.deepEqual(g.grid[0][0], ['कुरुते', 'करोति']);
  const n = await aai.declension({ stem: 'राम', linga: 'Pum' });
  assert.deepEqual(n.grid[5][2], ['रामाणाम्']);
  assert.equal((await aai.checkForm({ code: '01.0001', lakara: 'Lat', form: 'भवन्ति' })).derivable, true);
  assert.equal((await aai.checkForm({ code: '01.0001', lakara: 'Lat', form: 'भवाति' })).derivable, false);
  const pra = await aai.deriveVerb({ code: '01.0001', lakara: 'Lat', prefixes: ['pra'] });
  assert.equal(pra.forms[0].text, 'प्रभवति');
  await assert.rejects(aai.deriveVerb({ code: '01.0001', lakara: 'Nope' }), /Unknown lakara/);
  await assert.rejects(aai.deriveVerb({ code: '01.0001', prefixes: ['zzz'] }), /Unknown prefix/);
  await assert.rejects(aai.deriveVerb({ code: '99.9999' }), /No Dhatupatha entry/);
});
