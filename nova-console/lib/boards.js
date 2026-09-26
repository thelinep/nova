'use strict';
/* ===========================================================================
 * NOVA Runtime — Boards: mood boards, look books and character sheets
 *
 * A board is a free canvas of library images and clips, notes and colour
 * swatches, each with a position and size. Boards live in NOVA's database
 * and point at library items (the media themselves are not copied).
 * ========================================================================= */

const crypto = require('node:crypto');

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def; };
const TYPES = ['media', 'note', 'color'];

function normalise(store, input = {}, existing = null) {
  const now = new Date().toISOString();
  const board = { id: existing ? existing.id : 'board_' + crypto.randomBytes(8).toString('hex'), type: 'board',
    name: String(input.name ?? existing?.name ?? 'Untitled board').trim().slice(0, 120) || 'Untitled board',
    background: /^#[0-9a-f]{6}$/i.test(input.background || '') ? input.background : existing?.background || '#15181d',
    items: [], createdAt: existing?.createdAt || now, updatedAt: now };
  const items = Array.isArray(input.items) ? input.items : existing?.items || [];
  if (items.length > 500) throw error('A board holds up to 500 items.');
  for (const it of items) {
    if (!TYPES.includes(it.type)) continue;
    const x = { id: /^bi_[a-f0-9]{10}$/.test(it.id) ? it.id : 'bi_' + crypto.randomBytes(5).toString('hex'), type: it.type,
      x: num(it.x, -2000, 20000, 40), y: num(it.y, -2000, 20000, 40), w: num(it.w, 40, 4000, 240), h: num(it.h, 30, 4000, 180), z: num(it.z, 0, 100000, 0) };
    if (it.type === 'media') { const m = store.get('media', String(it.mediaId || '')); if (!m) continue; x.mediaId = m.id; x.caption = String(it.caption || '').slice(0, 300); }
    if (it.type === 'note') { x.text = String(it.text || '').slice(0, 4000); x.color = /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#f5d76e'; }
    if (it.type === 'color') { x.color = /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#c0392b'; x.caption = String(it.caption || '').slice(0, 120); }
    board.items.push(x);
  }
  return board;
}

module.exports = { normalise, TYPES };
