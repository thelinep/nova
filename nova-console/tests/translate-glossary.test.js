'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const translate = require('../skills/translate');

test('glossary accepts an object or "A = B" lines', () => {
  assert.deepEqual(translate.parseGlossary({ Asha: 'आशा' }), [['Asha', 'आशा']]);
  assert.deepEqual(translate.parseGlossary('Asha = आशा\nMarine Drive → मरीन ड्राइव; Ravi: रवि'), [['Asha', 'आशा'], ['Marine Drive', 'मरीन ड्राइव'], ['Ravi', 'रवि']]);
  assert.deepEqual(translate.parseGlossary(''), []);
});

test('the prompt teaches name spelling; a glossary name that comes back wrong gets one correction', async () => {
  const calls = [];
  const host = { generate: async a => { calls.push(a); return { text: calls.length === 1 ? 'अशा समुद्र को देखती है।' : 'आशा समुद्र को देखती है।', model: 'qwen3.5:9b-q4_K_M' }; } };
  const r = await translate.run({ text: 'Asha watches the sea.', targetLang: 'Hindi', glossary: 'Asha = आशा' }, null, host);
  assert.match(calls[0].system, /Meera is मीरा, not मेरा/);
  assert.doesNotMatch(calls[0].system.split('Use exactly')[0], /Asha/, 'the built-in example does not give away the real-model check');
  assert.match(calls[0].system, /Use exactly these spellings: Asha → आशा/);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /must spell these names exactly: Asha → आशा/);
  assert.equal(r.text, 'आशा समुद्र को देखती है।');
  assert.equal(r.namesCorrected, 1);
});

test('no extra call when the names are already right, or when there is no glossary', async () => {
  for (const glossary of ['Asha = आशा', undefined]) {
    const calls = []; const host = { generate: async a => { calls.push(a); return { text: 'आशा समुद्र को देखती है।' }; } };
    const r = await translate.run({ text: 'Asha watches the sea.', targetLang: 'Hindi', glossary }, null, host);
    assert.equal(calls.length, 1); assert.equal(r.namesCorrected, 0);
  }
});

test('a correction that makes things worse is not used', async () => {
  const calls = []; const host = { generate: async a => { calls.push(a); return { text: calls.length === 1 ? 'अशा समुद्र को देखती है।' : 'Sorry, I cannot.' }; } };
  const r = await translate.run({ text: 'Asha watches the sea.', targetLang: 'Hindi', glossary: 'Asha = आशा' }, null, host);
  assert.equal(r.text, 'अशा समुद्र को देखती है।'); assert.equal(r.namesCorrected, 0);
});
