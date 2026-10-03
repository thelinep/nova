'use strict';
/* Brahmi Notepad notes for the Workstation (store 'brahmiNotes').
 * A note keeps what the user typed (Roman, Devanagari or Brahmi) and the "ch"/"sh"
 * reading; the Brahmi is derived with lib/brahmi-pad.js whenever it is shown or exported. */
const crypto = require('node:crypto');
const pad = require('./brahmi-pad');

const STORE = 'brahmiNotes';
const SCHEMES = ['auto', 'itrans', 'iast'];
const MAX = 100000;

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function clean(input = {}) {
  const src = String(input.src ?? '');
  if (src.length > MAX) throw error(`A note can hold at most ${MAX.toLocaleString()} characters.`);
  const scheme = SCHEMES.includes(input.scheme) ? input.scheme : 'auto';
  return { src, scheme };
}
function view(note) {
  const brahmi = pad.toBrahmi(note.src, { scheme: note.scheme });
  return { ...note, brahmi, reading: pad.toIast(brahmi), readAs: pad.scheme(note.src, note.scheme), title: pad.toBrahmi(note.src.split('\n')[0].slice(0, 40), { scheme: note.scheme }) };
}

function list(store) { return store.all(STORE).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(view); }
function get(store, id) { const n = store.get(STORE, String(id || '')); if (!n) throw error('Unknown note.', 404); return n; }
function create(store, input = {}) {
  const now = new Date().toISOString();
  const note = { id: 'bn_' + crypto.randomBytes(6).toString('hex'), ...clean(input), createdAt: now, updatedAt: now };
  store.put(STORE, note);
  return view(note);
}
function update(store, id, input = {}) {
  const old = get(store, id);
  const note = { ...old, ...clean({ src: input.src ?? old.src, scheme: input.scheme ?? old.scheme }), updatedAt: new Date().toISOString() };
  store.put(STORE, note);
  return view(note);
}
function remove(store, id) { get(store, id); store.delete(STORE, String(id)); return { ok: true }; }
/** Plain-text export: the Brahmi, or the Brahmi with the reading under each line. */
function exportText(store, id, format = 'brahmi') {
  const n = view(get(store, id));
  if (format === 'both') return n.src.split('\n').map(line => { const b = pad.toBrahmi(line, { scheme: n.scheme }); return b + '\n' + pad.toIast(b); }).join('\n\n') + '\n';
  return n.brahmi + '\n';
}
function convert(input = {}) {
  const { src, scheme } = clean({ src: input.text, scheme: input.scheme });
  const brahmi = pad.toBrahmi(src, { scheme });
  return { brahmi, reading: pad.toIast(brahmi), readAs: pad.scheme(src, scheme) };
}

module.exports = { STORE, list, get, create, update, remove, exportText, convert };
