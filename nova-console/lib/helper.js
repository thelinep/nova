'use strict';
/* ===========================================================================
 * NOVA's helper: a companion that answers "how do I…" where you are
 *
 * ask() gives a local model the screen you are on, the matching passages
 * from the help guides, and the walkthroughs it may offer, and asks for a
 * short spoken-style answer. The model can end its answer with one action
 * tag, which NOVA turns into a button, never into a silent action:
 *   [go:<view>]    open that screen
 *   [tour:<id>]    start that step-by-step walkthrough
 * The helper has no tools: it cannot change settings, files or anything
 * else; it explains, opens screens and shows the way.
 * ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');

const HELP_JSON = path.join(__dirname, '..', 'public', 'help', 'help.json');
let helpCache = null, helpMtime = 0;
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function help() {
  try {
    const m = fs.statSync(HELP_JSON).mtimeMs;
    if (!helpCache || m !== helpMtime) { helpCache = JSON.parse(fs.readFileSync(HELP_JSON, 'utf8')); helpMtime = m; }
  } catch (_) { helpCache = helpCache || { articles: [], faq: [], troubleshooting: [] }; }
  return helpCache;
}

const STOP = new Set('a an and are as at be but by can do does for from how i if in into is it its me my no not of on or so that the this to was what when where which who why will with you your please could would should want need get make show tell'.split(' '));
function terms(text) { return String(text || '').toLowerCase().split(/[^a-z0-9ऀ-ॿ]+/).filter(t => t.length > 1 && !STOP.has(t)); }

/** The most relevant help passages for a question on a screen. */
function search(question, view, limit = 3) {
  const q = terms(question); const h = help();
  const docs = [
    ...h.articles.map(a => ({ kind: 'guide', id: a.id, title: a.title, text: a.text || '', boost: (a.views || []).includes(view) ? 2 : 0, keys: a.keywords || '' })),
    ...h.faq.map(f => ({ kind: 'faq', id: 'faq#' + f.id, title: f.q, text: f.text || '', boost: 0, keys: '' })),
    ...h.troubleshooting.map(f => ({ kind: 'troubleshooting', id: 'troubleshooting#' + f.id, title: f.q, text: f.text || '', boost: 0, keys: '' })),
  ];
  const scored = docs.map(d => {
    const title = d.title.toLowerCase(), body = d.text.toLowerCase(), keys = d.keys.toLowerCase();
    let s = d.boost;
    for (const t of q) { if (title.includes(t)) s += 3; if (keys.includes(t)) s += 2; if (body.includes(t)) s += 1; }
    return { ...d, score: s };
  }).filter(d => d.score > (q.length ? 1 : 0)).sort((a, b) => b.score - a.score).slice(0, limit);
  return scored.map(d => {
    // The part of the text around the first matching word, so passages stay short.
    const body = d.text; const low = body.toLowerCase();
    const at = Math.max(0, Math.min(...q.map(t => { const i = low.indexOf(t); return i < 0 ? Infinity : i; }).concat([0])) - 200);
    return { id: d.id, title: d.title, kind: d.kind, text: body.slice(at, at + 900) };
  });
}

function pickModel(store, wanted) {
  const models = store.all('models').filter(m => m.runtime === 'ollama' && !/embed/i.test(m.id + ' ' + (m.name || '')));
  const m = (wanted && models.find(x => x.id === wanted)) || models.find(x => x.loaded) || models[0];
  if (!m) throw error('The helper needs a chat model. Open Models and press Sync from Ollama.', 412);
  return m.id;
}

const ACTION = /\[(go|tour):([a-z0-9_-]+)\]\s*$/i;

/** One exchange with the helper. Returns { reply, action, sources, model }. */
async function ask({ store, ollama, characters = null }, input = {}) {
  const text = String(input.text || '').trim().slice(0, 2000);
  if (!text) throw error('Ask me something.');
  const view = String(input.view || 'console').slice(0, 40);
  const views = (Array.isArray(input.views) ? input.views : []).map(v => ({ id: String(v.id).slice(0, 40), label: String(v.label).slice(0, 60) })).slice(0, 60);
  const tours = (Array.isArray(input.tours) ? input.tours : []).map(t => ({ id: String(t.id).slice(0, 40), title: String(t.title).slice(0, 100) })).slice(0, 30);
  const passages = search(text, view);
  let persona = 'You are Nova, the friendly helper built into the NOVA app. You talk like a calm, capable colleague sitting next to the person.';
  if (input.characterId && characters) { try { persona = characters.personaPrompt(characters.get(store, input.characterId)); } catch (_) {} }
  const system = [
    persona,
    'You help the person use NOVA, a local AI workspace on their Mac. Answer in 1 to 4 short sentences that sound natural when read aloud: no lists, tables, markdown or code unless they ask. Be concrete: name the exact screen and button.',
    'Use only the help passages and screen notes below for facts about NOVA. If they do not cover the question, say you are not sure and suggest opening Help & Support. Never invent buttons or settings.',
    'You cannot press buttons, change settings or touch files yourself. You can offer ONE of these by ending your answer with a tag on its own:',
    views.length ? '  [go:<screen id>] to open a screen. Screens: ' + views.map(v => `${v.id} (${v.label})`).join(', ') : '',
    tours.length ? '  [tour:<id>] to walk them through it step by step on screen. Walkthroughs: ' + tours.map(t => `${t.id} (${t.title})`).join(', ') : '',
    'Only add a tag when it clearly helps; at most one.',
    `They are on the "${view}" screen.` + (input.viewHelp ? ' About this screen: ' + String(input.viewHelp).slice(0, 600) : ''),
    passages.length ? 'Help passages:\n' + passages.map(p => `--- ${p.title}\n${p.text}`).join('\n') : 'No help passage matched.',
  ].filter(Boolean).join('\n');
  const history = (Array.isArray(input.history) ? input.history : []).slice(-6).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 1200) }));
  const model = pickModel(store, input.model);
  const res = await ollama.chatFull(model, [{ role: 'system', content: system }, ...history, { role: 'user', content: text }], { options: { temperature: 0.4, num_predict: 320 } });
  let reply = String(res?.message?.content || '').trim();
  reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  let action = null;
  const m = ACTION.exec(reply);
  if (m) {
    const kind = m[1].toLowerCase(), id = m[2];
    if (kind === 'go' && views.some(v => v.id === id)) action = { type: 'go', id, label: (views.find(v => v.id === id) || {}).label };
    if (kind === 'tour' && tours.some(t => t.id === id)) action = { type: 'tour', id, label: (tours.find(t => t.id === id) || {}).title };
    reply = reply.replace(ACTION, '').trim();
  }
  reply = reply.replace(/\[(go|tour):[^\]]*\]/gi, '').trim();
  return { reply: reply || 'Sorry, I did not get an answer from the model. Try asking again.', action, sources: passages.map(p => ({ id: p.id, title: p.title })), model };
}

module.exports = { ask, search, terms, pickModel };
