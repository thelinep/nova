'use strict';
/* NOVA's helper: help search, model choice, answers with one offered action. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helper = require('../lib/helper');
const characters = require('../lib/characters');
const { openDb, Store } = require('../lib/db');

test('search finds the right guide, and boosts the screen you are on', () => {
  const r = helper.search('how do I qualify a model for coding', 'models');
  assert.equal(r[0].title, 'Models');
  assert.ok(r.every(p => p.text.length <= 900));
  assert.ok(helper.search('allow a website for agents', 'agentbrowser').some(p => /Agent Browser/.test(p.title)));
  assert.deepEqual(helper.terms('How do I make an image?'), ['image']);
});

test('ask: grounded prompt, one action turned into a button, unknown actions dropped, character persona', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-helper-'));
  const { db } = openDb(dir); const store = new Store(db);
  try {
    assert.throws(() => helper.pickModel(store), /Sync from Ollama/);
    store.put('models', { id: 'nomic-embed-text', runtime: 'ollama' });
    store.put('models', { id: 'llama3.2', runtime: 'ollama' });
    assert.equal(helper.pickModel(store), 'llama3.2', 'embedding models are skipped');
    const calls = [];
    let answer = 'Open Models and press Qualify for coding. Want me to show you?\n[tour:qualify-model]';
    const ollama = { async chatFull(model, messages) { calls.push({ model, messages }); return { message: { content: answer } }; } };
    const input = { text: 'How do I let NOVA change my code?', view: 'models', views: [{ id: 'models', label: 'Models' }], tours: [{ id: 'qualify-model', title: 'Qualify a model for coding' }] };
    const r = await helper.ask({ store, ollama, characters }, input);
    assert.equal(r.reply, 'Open Models and press Qualify for coding. Want me to show you?');
    assert.deepEqual(r.action, { type: 'tour', id: 'qualify-model', label: 'Qualify a model for coding' });
    const sys = calls[0].messages[0].content;
    assert.match(sys, /You are Nova/); assert.match(sys, /cannot press buttons/); assert.match(sys, /Help passages:/); assert.match(sys, /qualify-model/);
    answer = 'Sure.\n[go:secret-admin]';
    assert.equal((await helper.ask({ store, ollama, characters }, input)).action, null, 'only listed screens and walkthroughs');
    answer = 'Opening it.\n[go:models]';
    assert.deepEqual((await helper.ask({ store, ollama, characters }, input)).action, { type: 'go', id: 'models', label: 'Models' });
    const c = characters.create(store, { name: 'Meera', tagline: 'a calm first AD' });
    await helper.ask({ store, ollama, characters }, { ...input, characterId: c.id });
    assert.match(calls.at(-1).messages[0].content, /^You are Meera, a calm first AD\./);
    await assert.rejects(() => helper.ask({ store, ollama, characters }, { text: '  ' }), /Ask me something/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
