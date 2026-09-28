'use strict';
/* ===========================================================================
 * Memory: short notes NOVA keeps about you, in the open
 *
 * Notes are added only when you ask ("remember that I shoot on an FX3"),
 * press Remember on a message, or type one in Settings > Memory. They are
 * shown in Settings, can be deleted one by one, and are given to the model at
 * the start of each chat. Nothing is guessed or collected in the background.
 * ========================================================================= */
const crypto = require('node:crypto');

const MAX_NOTES = 200;
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function list(store) { return store.all('userMemory').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); }

function add(store, text, source = 'you') {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
  if (t.length < 3) throw error('The note is empty.');
  if (t.length > 500) throw error('Keep a memory note under 500 characters.');
  const existing = list(store);
  const dup = existing.find(n => n.text.toLowerCase() === t.toLowerCase());
  if (dup) return dup;
  if (existing.length >= MAX_NOTES) throw error(`Memory holds up to ${MAX_NOTES} notes. Delete some in Settings > Memory first.`, 409);
  const note = { id: 'mem_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), text: t, source, createdAt: new Date().toISOString() };
  store.put('userMemory', note);
  return note;
}

function remove(store, id) { if (!store.get('userMemory', id)) throw error('Unknown note.', 404); store.delete('userMemory', id); return { ok: true }; }

/** Deletes notes that mention `phrase`; returns them. */
function forget(store, phrase) {
  const p = String(phrase || '').toLowerCase().replace(/[.!?]+$/, '').trim();
  if (p.length < 3) return [];
  const gone = list(store).filter(n => n.text.toLowerCase().includes(p));
  for (const n of gone) store.delete('userMemory', n.id);
  return gone;
}

/** Spots an explicit "remember …" / "forget …" at the start of a message. */
function detect(text) {
  const t = String(text || '').trim();
  let m = /^(?:please\s+|hey nova,?\s+|nova,?\s+)?(?:remember|note|keep in mind)(?:\s+that)?[:,]?\s+(.{3,500})$/is.exec(t);
  if (m && !/^(this|what|how|when|where|why|to\b)/i.test(m[1])) return { remember: m[1].trim() };
  m = /^(?:please\s+)?forget(?:\s+that|\s+about)?\s+(.{3,200})$/is.exec(t);
  if (m) return { forget: m[1].trim() };
  return null;
}

function promptText(store, max = 3000) {
  const notes = list(store);
  if (!notes.length) return '';
  let out = 'What you know about the person you are talking to (they asked you to remember these):\n';
  for (const n of notes.slice().reverse()) { const line = '- ' + n.text + '\n'; if (out.length + line.length > max) break; out += line; }
  return out.trim();
}

module.exports = { list, add, remove, forget, detect, promptText };
