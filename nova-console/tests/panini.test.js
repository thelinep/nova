'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const panini = require('../lib/panini');
const sutraNeurons = require('../lib/sutra-neurons');
const factory = require('../lib/neuron-factory');
const governance = require('../lib/artifact-governance');

function memoryStore() {
  const state = new Map();
  return { all(name){return [...(state.get(name)?.values()||[])];}, get(name,id){return state.get(name)?.get(id)||null;}, put(name,row){if(!state.has(name))state.set(name,new Map());state.get(name).set(row.id,row);return row;} };
}

test('the Ashtadhyayi is complete, ordered and attributed', () => {
  const info = panini.info();
  assert.equal(info.total, 3983);
  assert.equal(info.padas.length, 32);
  assert.equal(info.padas[0].count, 75);
  assert.equal(info.padas.at(-1).count, 68);
  assert.equal(info.source.license, 'MIT');
  assert.match(info.source.attribution, /ambuda\.org/);
  assert.equal(info.dhatus, 2259);
});

test('known sutras read correctly and missing numbers are explained', () => {
  const known = { '1.1.1':'वृद्धिरादैच्', '1.1.2':'अदेङ् गुणः', '6.1.77':'इको यणचि', '6.1.78':'एचोऽयवायावः', '6.1.87':'आद्गुणः', '6.1.88':'वृद्धिरेचि', '6.1.101':'अकः सवर्णे दीर्घः', '8.4.68':'अ अ' };
  for (const [id, text] of Object.entries(known)) assert.equal(panini.get(id).devanagari, text, id);
  assert.equal(panini.get('1.1.101'), null);
  const missing = panini.search('1.1.101');
  assert.equal(missing.kind, 'missing');
  assert.match(missing.message, /75 sutras/);
  assert.equal(panini.get('6.1.77').previous, '6.1.76');
});

test('search works by range, pada and words in any script', () => {
  assert.deepEqual(panini.search('6.1.77-6.1.79').results.map(r => r.id), ['6.1.77', '6.1.78', '6.1.79']);
  assert.equal(panini.search('1.2').results.length, 73);
  for (const q of ['इको यणचि', 'iko yaṇaci', 'iko yaRaci', panini.fromDeva('इको यणचि', 'brahmi'), panini.fromDeva('इको यणचि', 'siddham')]) {
    assert.deepEqual(panini.search(q).results.map(r => r.id), ['6.1.77'], q);
  }
  assert.equal(panini.search('1.1.1', { script:'iast' }).results[0].text, 'vṛddhirādaic');
  assert.equal(panini.search('1.1.1', { script:'brahmi' }).results[0].text, '𑀯𑀾𑀤𑁆𑀥𑀺𑀭𑀸𑀤𑁃𑀘𑁆');
  assert.throws(() => panini.search('1.1.1', { script:'latin' }), /Script must be/);
});

test('Dhatupatha roots are found with or without marker letters', () => {
  assert.equal(panini.dhatu('भू')[0].meaning, 'सत्तायाम्');
  assert.equal(panini.dhatu('गम्')[0].root, 'ग॒मॢँ');
  assert.ok(panini.dhatu('पच्').some(d => d.root === 'डुप॒चँ॑ष्'));
});

test('every sutra neuron preset trains, agrees with its sutra on all 169 vowel pairs, and passes evaluation', () => {
  const presets = sutraNeurons.list();
  assert.deepEqual(presets.map(p => p.sutra), ['6.1.77', '6.1.78', '6.1.87', '6.1.88', '6.1.101']);
  for (const preset of presets) {
    const store = memoryStore();
    const input = sutraNeurons.blueprintInput(preset.id);
    const blueprint = factory.createBlueprint(store, input, { sutra: input.sutra });
    assert.equal(blueprint.status, 'ready');
    assert.equal(blueprint.sutra.id, preset.sutra);
    const { artifact } = factory.trainBlueprint(store, blueprint.id);
    const { evaluation } = governance.evaluate(store, artifact.id);
    assert.equal(evaluation.measured.ruleAgreement.correct, 169, preset.id);
    assert.equal(evaluation.status, 'passed', preset.id);
  }
});

test('a sutra neuron that disagrees with its sutra fails evaluation, and try-it compares with the rule', () => {
  const store = memoryStore();
  const input = sutraNeurons.blueprintInput('sandhi-dirgha');
  input.config.epochs = 3; // undertrained on purpose
  const blueprint = factory.createBlueprint(store, input, { sutra: input.sutra });
  const { artifact } = factory.trainBlueprint(store, blueprint.id);
  const { evaluation } = governance.evaluate(store, artifact.id, { maxFinalLoss: 1 });
  assert.ok(evaluation.measured.ruleAgreement.correct < 169);
  assert.equal(evaluation.status, 'failed');
  const good = memoryStore(), gi = sutraNeurons.blueprintInput('sandhi-yan');
  const gb = factory.createBlueprint(good, gi, { sutra: gi.sutra });
  const trained = factory.trainBlueprint(good, gb.id).artifact;
  const answer = sutraNeurons.tryPair(trained, gb.sutra, 'इ', 'अ');
  assert.deepEqual([answer.neuron, answer.sutra, answer.agrees], ['य्', 'य्', true]);
  assert.throws(() => sutraNeurons.tryPair(trained, gb.sutra, 'क', 'अ'), /Choose two vowels/);
});

test('the request body cannot attach a sutra claim to an ordinary blueprint', () => {
  const store = memoryStore();
  const input = { ...sutraNeurons.blueprintInput('sandhi-yan') };
  const blueprint = factory.createBlueprint(store, input); // generic route: no extra
  assert.equal(blueprint.sutra, undefined);
});
