'use strict';
/* ===========================================================================
 * Character Studio: scenes
 *
 * A scene puts up to four Studio characters on one background for 3–30
 * seconds. Each actor moves in beats (from x to x, a pose, a facing), lines
 * of dialogue are spoken in the character's voice and shown as captions,
 * comic effects pop, and camera shots pan and zoom. The page draws and
 * records the scene; this file keeps the data valid, asks a local model to
 * direct a scene from a prompt, imports scripts (TXT, MD, DOCX, SRT) and
 * exports subtitles.
 *
 * Ideas taken from Toon Studio (Mira & Inchi), rebuilt for Maataa: any
 * characters, Kokoro voices, the Library and the local Ollama models.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('./media');
const puppet = require('./puppet');
const characters = require('./characters');

const STORE = 'scenes';
const W = 1920, H = 1080, X_MIN = 80, X_MAX = 1840, GROUND = 1000;
const LIMITS = { duration: [3, 30], actors: 4, beats: 60, dialogue: 60, shots: 20, scenesPerImport: 40, scriptChars: 100000, scriptLines: 500, lineChars: 500 };
const EFFECTS = ['none', 'bonk', 'dust', 'sparkle'];
const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'];
const BACKDROPS = { courtyard: { label: 'Courtyard (Mira & Inchi)', file: 'cs-assets/toon/courtyard.jpg' } };

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const r3 = n => Math.round(n * 1000) / 1000;
const HEX = /^#[0-9a-f]{6}$/i;
const newId = p => p + crypto.randomBytes(6).toString('hex');

/* ------------------------------- poses ------------------------------- */
/** The poses a character can take in a scene: its cutout poses (drawings) first, then the 2D puppet moves. */
function posesFor(c) {
  const cut = (c && Array.isArray(c.cutouts) ? c.cutouts : []).map(p => p.name);
  const moves = c && c.puppet ? Object.keys(puppet.MOVES) : [];
  return [...new Set([...cut, ...moves])];
}
function defaultPose(c, prefer = []) { const p = posesFor(c); return prefer.find(x => p.includes(x)) || p.find(x => /stand|idle|stop/.test(x)) || p[0] || 'idle'; }

/* ------------------------------- timing repair ------------------------------- */
/** Sorts and clamps intervals, removes overlaps and fills gaps so they cover 0..duration exactly. */
function cover(list, duration, make) {
  const xs = list.map(b => ({ ...b, start: num(b.start, 0, duration, 0), end: num(b.end, 0, duration, 0) })).filter(b => b.end - b.start >= 0.04).sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of xs) {
    const prev = out[out.length - 1];
    if (prev && b.start < prev.end) { if (b.end <= prev.end) continue; b.start = prev.end; }
    if (prev && b.start > prev.end) prev.end = b.start;
    out.push(b);
  }
  if (!out.length) out.push(make(0, duration));
  out[0].start = 0; out[out.length - 1].end = duration;
  return out.map(b => ({ ...b, start: r3(b.start), end: r3(b.end) }));
}

/* ------------------------------- the scene ------------------------------- */
function normaliseProfile(p = {}) {
  return { height: Number(p.height) === 1080 ? 1080 : 720, fps: Number(p.fps) === 30 ? 30 : 24, aspect: p.aspect === '9:16' ? '9:16' : '16:9', captions: p.captions !== false, quality: ['draft', 'standard', 'high'].includes(p.quality) ? p.quality : 'standard' };
}
function normaliseBackground(b = {}) {
  if (b && b.kind === 'media' && b.mediaId) return { kind: 'media', mediaId: clip(b.mediaId, 80), color: HEX.test(b.color) ? b.color.toLowerCase() : '#1e2430' };
  if (b && b.kind === 'asset' && BACKDROPS[b.asset]) return { kind: 'asset', asset: b.asset, color: '#1e2430' };
  return { kind: 'color', color: HEX.test(b && b.color) ? b.color.toLowerCase() : '#1e2430' };
}

/**
 * A clean scene. charsById (optional) lets poses be checked against what each character can do;
 * notes collects what was repaired, so a model's or a script's mistakes are reported, not hidden.
 */
function normaliseScene(input = {}, prior = null, { charsById = null, notes = [] } = {}) {
  const now = new Date().toISOString();
  const duration = r3(num(input.duration ?? prior?.duration, LIMITS.duration[0], LIMITS.duration[1], 8));
  const ids = new Set();
  const actors = (Array.isArray(input.actors) ? input.actors : prior?.actors || []).slice(0, LIMITS.actors).map((a, i) => {
    let id = /^a[1-9]$/.test(a.id) && !ids.has(a.id) ? a.id : null;
    for (let k = 1; !id; k++) if (!ids.has('a' + k)) id = 'a' + k;
    ids.add(id);
    const c = a.characterId && charsById ? charsById[a.characterId] : null;
    if (a.characterId && charsById && !c) notes.push(`Actor ${a.label || id}: its character is gone, so it is a voice-off actor now.`);
    return { id, characterId: (charsById ? (c ? c.id : null) : clip(a.characterId, 80) || null), label: clip(a.label || c?.name || 'Actor ' + (i + 1), 40), scale: num(a.scale, 0.3, 2.5, 1), y: Math.round(num(a.y, 500, H, GROUND)) };
  });
  const byId = Object.fromEntries(actors.map(a => [a.id, a]));
  const poseOk = (a, pose) => { if (!charsById || !a.characterId) return true; return posesFor(charsById[a.characterId]).includes(pose); };
  const spread = i => Math.round(X_MIN + 200 + (i + 0.5) * (X_MAX - X_MIN - 400) / Math.max(1, actors.length));
  // beats
  const rawBeats = (Array.isArray(input.beats) ? input.beats : prior?.beats || []).slice(0, LIMITS.beats);
  const beats = cover(rawBeats, duration, (s, e) => ({ start: s, end: e, actors: {} }));
  let prev = {};
  for (const b of beats) {
    const st = {};
    for (const [i, a] of actors.entries()) {
      const src = (b.actors && b.actors[a.id]) || {}, p = prev[a.id];
      const x = Math.round(num(src.x, X_MIN, X_MAX, p ? p.to : spread(i)));
      const c = charsById && a.characterId ? charsById[a.characterId] : null;
      let pose = clip(src.pose, 32).toLowerCase() || (p ? p.pose : defaultPose(c));
      if (!poseOk(a, pose)) { notes.push(`${a.label} cannot "${pose}"; used "${p ? p.pose : defaultPose(c)}".`); pose = p ? p.pose : defaultPose(c); }
      st[a.id] = { x, to: Math.round(num(src.to, X_MIN, X_MAX, x)), pose, facing: Number(src.facing) === -1 ? -1 : Number(src.facing) === 1 ? 1 : (p ? p.facing : (x < W / 2 ? 1 : -1)) };
    }
    b.actors = st; b.effect = EFFECTS.includes(b.effect) ? b.effect : 'none';
    b.target = b.target && byId[b.target] ? b.target : null;
    prev = st;
  }
  for (const b of beats) for (const k of Object.keys(b)) if (!['start', 'end', 'actors', 'effect', 'target'].includes(k)) delete b[k];
  // dialogue
  const dialogue = (Array.isArray(input.dialogue) ? input.dialogue : prior?.dialogue || []).map(d => {
    let start = num(d.start, 0, duration, 0), end = num(d.end, 0, duration, start + 2);
    if (end - start < 0.3) end = Math.min(duration, start + 0.3), start = Math.min(start, end - 0.3);
    const text = clip(d.text, LIMITS.lineChars);
    let actor = byId[d.actor] ? d.actor : (actors.find(a => a.label.toLowerCase() === String(d.speaker || d.actor || '').toLowerCase()) || {}).id || null;
    if (!actor && actors.length && (d.actor || d.speaker)) notes.push(`A line for "${d.actor || d.speaker}" was given to nobody (no such actor).`);
    return text ? { id: /^ln_[a-f0-9]{8}$/.test(d.id) ? d.id : 'ln_' + crypto.randomBytes(4).toString('hex'), start: r3(start), end: r3(end), actor, text } : null;
  }).filter(Boolean).sort((a, b) => a.start - b.start);
  if (dialogue.length > LIMITS.dialogue) { notes.push(`Only the first ${LIMITS.dialogue} lines were kept.`); dialogue.length = LIMITS.dialogue; }
  // camera shots (optional; when present they cover the scene)
  const rawShots = (Array.isArray(input.shots) ? input.shots : prior?.shots || []).slice(0, LIMITS.shots);
  const shots = rawShots.length ? cover(rawShots, duration, (s, e) => ({ start: s, end: e })).map(s => {
    const z = num(s.zoom, 1, 3.5, 1), tz = num(s.toZoom, 1, 3.5, z);
    const cx = (v, zz, half) => { const lo = Math.ceil(half / zz), hi = Math.floor(half * 2 - half / zz); return Math.min(hi, Math.max(lo, Math.round(num(v, lo, hi, half)))); };
    return { start: s.start, end: s.end, zoom: z, x: cx(s.x, z, W / 2), y: cx(s.y, z, H / 2), toZoom: tz, toX: cx(s.toX ?? s.x, tz, W / 2), toY: cx(s.toY ?? s.y, tz, H / 2), easing: EASINGS.includes(s.easing) ? s.easing : 'easeInOut', transition: s.transition === 'fade' ? 'fade' : 'cut', transitionDuration: num(s.transitionDuration, 0.1, 2, 0.4) };
  }) : [];
  const src = input.source || prior?.source || {};
  return {
    id: prior?.id || (/^scn_[a-f0-9]{12}$/.test(input.id) ? input.id : newId('scn_')), type: 'scene',
    name: clip(input.name ?? input.title ?? prior?.name, 80) || 'New scene', duration, notes: String(input.notes ?? prior?.notes ?? '').slice(0, 8000),
    background: normaliseBackground(input.background || prior?.background), actors, beats, dialogue, shots,
    profile: normaliseProfile(input.profile || prior?.profile), source: { kind: ['manual', 'director', 'script', 'starter'].includes(src.kind) ? src.kind : 'manual', model: clip(src.model, 80) || null, prompt: clip(src.prompt, 400) || null, script: clip(src.script, 120) || null },
    createdAt: prior?.createdAt || now, updatedAt: now,
  };
}

const charMap = store => Object.fromEntries(characters.list(store).map(c => [c.id, c]));
function list(store) { return store.all(STORE).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
function get(store, id) { const s = store.get(STORE, id); if (!s) throw error('Unknown scene.', 404); return s; }
function create(store, input = {}) {
  const chars = charMap(store);
  if (!input.actors) { const pick = characters.list(store).filter(c => c.puppet || (c.cutouts || []).length).slice(0, 2); input = { ...input, actors: pick.map(c => ({ characterId: c.id })) }; }
  return store.put(STORE, normaliseScene(input, null, { charsById: chars }));
}
function update(store, id, input) { const prior = get(store, id); const notes = []; const s = store.put(STORE, normaliseScene({ ...input, id }, prior, { charsById: charMap(store), notes })); return { ...s, notes }; }
function remove(store, id) { get(store, id); store.delete(STORE, id); return { ok: true }; }

/* ------------------------------- director (local model) ------------------------------- */
function directorPrompt(scene, chars) {
  const cast = scene.actors.map(a => { const c = a.characterId ? chars[a.characterId] : null; return `- "${a.id}" = ${a.label}${c ? `: poses ${JSON.stringify(posesFor(c))}` : ' (voice only, not drawn)'}`; }).join('\n');
  return `You direct a short 2D cartoon scene with these actors on one stage:
${cast}
Return ONLY one JSON object:
{"title": string, "duration": number ${LIMITS.duration[0]}..${LIMITS.duration[1]},
 "beats": [{"start": s, "end": s, "effect": "none"|"bonk"|"dust"|"sparkle", "target": actor id or null,
            "actors": {"<actor id>": {"x": 80..1840, "to": 80..1840, "pose": one of that actor's poses, "facing": 1 (right) or -1 (left)}}}],
 "dialogue": [{"start": s, "end": s, "actor": actor id, "text": string}],
 "shots": [{"start": s, "end": s, "x": 960, "y": 540, "zoom": 1..3.5, "toX": 960, "toY": 540, "toZoom": 1..3.5, "transition": "cut"|"fade"}]}
Rules: the stage is 1920 wide; x moves to "to" during the beat. Beats cover the whole duration with no gaps or overlaps; use 1–4 second beats for action. Give every actor a state in every beat. Use only the listed poses. Dialogue may be in Hindi (Devanagari) or English; allow about 2.4 words per second. "bonk" is a comic hit, "dust" puffs behind runners, "sparkle" is a magic shine. "shots" is optional; when given, it covers the whole duration. Keep it gentle and family-friendly. Give concrete movement, not prose.`;
}
function parseJson(text) {
  let s = String(text || '').trim(); if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}
function chatModels(store) {
  return store.all('models').filter(m => m.runtime === 'ollama' && !m.example && !/embed/i.test(m.id + ' ' + (m.name || '')) && !(Array.isArray(m.capabilities) && m.capabilities.length && !m.capabilities.includes('completion'))).map(m => m.id);
}
/** Asks a local model to direct the scene. The scene is changed only when the answer is usable. */
async function direct({ store, ollama }, id, { prompt, model } = {}) {
  const scene = get(store, id), chars = charMap(store);
  const text = clip(prompt, 4000); if (!text) throw error('Write what should happen in the scene.');
  if (!scene.actors.length) throw error('Add at least one actor in Cast first.');
  const models = chatModels(store); const m = model && models.includes(model) ? model : models[0];
  if (!m || !ollama) throw error('No local chat model is installed. Install one in Models (for example qwen3:8b).', 412);
  let res;
  const limitMs = Number(process.env.NOVA_DIRECTOR_TIMEOUT_MS) || 5 * 60 * 1000; // a busy or memory-starved Mac must not leave the page waiting forever
  try { res = await ollama.chatFull(m, [{ role: 'system', content: directorPrompt(scene, chars) }, { role: 'user', content: text }], { format: 'json', options: { temperature: 0.4, num_predict: 2500 }, signal: AbortSignal.timeout(limitMs) }); }
  catch (e) { if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw error(`${m} did not finish within ${Math.round(limitMs / 60000)} minutes. Your scene was not changed. Close other apps to free memory, or try a smaller model.`, 504); throw error(`${m} could not answer: ${String(e.message || e).slice(0, 160)}`, 502); }
  const j = parseJson(res && res.message && res.message.content);
  if (!j || !Array.isArray(j.beats)) throw error(`${m} did not return a usable scene. Your scene was not changed. Try again, a shorter prompt or another model.`, 422);
  const notes = [];
  const next = normaliseScene({ ...scene, name: j.title || scene.name, duration: j.duration, beats: j.beats, dialogue: j.dialogue || [], shots: Array.isArray(j.shots) ? j.shots : [], source: { kind: 'director', model: m, prompt: text } }, scene, { charsById: chars, notes });
  store.put(STORE, next);
  return { ...next, notes, model: m };
}

/* ------------------------------- script import ------------------------------- */
const NOT_SPEAKER = /^(scene|act|int|ext|note|notes|direction|title|chapter|shot|cut|fade|दृश्य|अध्याय)\b/i;
function splitSpeaker(line) {
  const m = /^\s*([^:：]{1,40})[:：]\s*(.+)$/s.exec(line);
  if (!m) return null;
  const name = m[1].trim();
  if (NOT_SPEAKER.test(name) || /\d/.test(name) || name.split(/\s+/).length > 3) return null;
  return { name, text: m[2].trim() };
}
const srtTime = v => { const [h, m, s] = v.replace(',', '.').split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
async function scriptText(buffer, name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.docx') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-script-')), f = path.join(dir, 'script.docx');
    try { fs.writeFileSync(f, buffer); const r = await require('./chat-sources').extractText(f, 'script.docx'); if (!r.text) throw error(r.note || 'Not a readable DOCX script.'); return r.text; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const t = buffer.toString('utf8').replace(/^﻿/, '');
  if (t.includes('�')) throw error('Save the script as UTF-8 text (TXT, MD or SRT), or as DOCX.');
  return t;
}
/**
 * Parses dialogue. Text: "Name: line" (other lines are direction notes); SRT: timed cues, "Name: " optional.
 * Returns { cues:[{start,end,speaker,text}], notes, timed }.
 */
function parseScript(text, name = 'script.txt') {
  if (text.length > LIMITS.scriptChars) throw error('The script must be under 100,000 characters.');
  const srt = /\.srt$/i.test(name) || /^\s*\d+\s*\r?\n\d+:\d+:\d+[,.]\d+\s*-->/.test(text);
  const cues = [], notes = [];
  if (srt) {
    for (const block of text.trim().split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/), i = lines.findIndex(l => l.includes('-->')); if (i < 0) continue;
      const m = /(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/.exec(lines[i]); if (!m) throw error('Invalid SRT timing: ' + lines[i].slice(0, 60));
      const body = lines.slice(i + 1).join(' ').trim(); const sp = splitSpeaker(body);
      const start = srtTime(m[1]), end = srtTime(m[2]); if (end <= start) throw error('SRT cues must end after they start (' + lines[i].slice(0, 40) + ').');
      const t = sp ? sp.text : body; if (t.length > LIMITS.lineChars) throw error('A subtitle cue is longer than 500 characters. Split it first.');
      if (t) cues.push({ start, end, speaker: sp ? sp.name : null, text: t });
    }
  } else {
    let cursor = 0.3;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^[#>*\-\s]+/, '').trim(); if (!line) continue;
      const sp = splitSpeaker(line);
      if (!sp) { notes.push(line); continue; }
      if (sp.text.length > LIMITS.lineChars) throw error(`A line by ${sp.name} is longer than 500 characters. Split it first.`);
      const d = Math.max(1.3, Math.min(12, sp.text.split(/\s+/).length / 2.4 + 0.6));
      cues.push({ start: cursor, end: cursor + d, speaker: sp.name, text: sp.text }); cursor += d + 0.25;
    }
  }
  if (!cues.length) throw error('No dialogue found. Write lines like "Mira: Hello" or "इंची: नमस्ते", or import an SRT file.');
  if (cues.length > LIMITS.scriptLines) throw error('A script can have at most 500 lines of dialogue.');
  return { cues: cues.sort((a, b) => a.start - b.start), notes, timed: srt };
}
/** Groups cues into scenes of up to 30 seconds and 30 lines, keeping timing inside each scene. */
function groupScenes(cues) {
  const groups = []; let g = [], origin = 0;
  const flush = () => { if (!g.length) return; const duration = Math.max(3, Math.max(...g.map(c => c.end)) - origin + 0.4); if (duration > 30.01) throw error(`One line is longer than 29 seconds ("${g[0].text.slice(0, 40)}…"). Split it before importing.`); groups.push({ duration: r3(duration), cues: g.map(c => ({ ...c, start: r3(c.start - origin), end: r3(c.end - origin) })) }); };
  for (const c of cues) {
    if (!g.length) origin = Math.max(0, c.start - 0.3);
    if (g.length && (c.end - origin + 0.4 > 30 || g.length >= 30)) { flush(); g = []; origin = Math.max(0, c.start - 0.3); }
    g.push(c);
  }
  flush();
  return groups;
}
/**
 * Imports a script as scenes. aliases: { "मीरा": characterId, "M": characterId } map speaker names to characters;
 * names that match a character's name are mapped automatically. Other speakers become voice-off actors.
 */
async function importScript(store, buffer, { name = 'script.txt', aliases = {}, title } = {}) {
  if (!buffer || !buffer.length) throw error('The script is empty.');
  if (buffer.length > 16 * 1024 * 1024) throw error('Scripts are limited to 16 MB.');
  const text = await scriptText(buffer, name);
  const { cues, notes, timed } = parseScript(text, name);
  const all = characters.list(store), chars = charMap(store);
  const lookup = new Map(all.map(c => [c.name.toLowerCase(), c.id]));
  for (const [k, v] of Object.entries(aliases || {})) if (chars[v]) lookup.set(String(k).trim().toLowerCase(), v);
  const groups = groupScenes(cues);
  if (groups.length > LIMITS.scenesPerImport) throw error(`This script makes ${groups.length} scenes; the limit is ${LIMITS.scenesPerImport}. Import it in parts.`);
  const base = clip(title || path.basename(name).replace(/\.[a-z0-9]+$/i, ''), 50) || 'Script';
  const unmatched = new Set(), overflow = new Set(), created = [];
  for (const [i, g] of groups.entries()) {
    const speakers = [...new Set(g.cues.map(c => c.speaker || 'Narrator'))];
    const cast = speakers.slice(0, LIMITS.actors), actors = cast.map((sp, k) => { const cid = lookup.get(sp.toLowerCase()) || null; if (!cid) unmatched.add(sp); return { id: 'a' + (k + 1), characterId: cid, label: cid ? chars[cid].name : sp }; });
    speakers.slice(LIMITS.actors).forEach(s => overflow.add(s));
    const idOf = sp => (actors[cast.indexOf(sp)] || {}).id || null;
    const x = k => Math.round(X_MIN + 300 + k * (X_MAX - X_MIN - 600) / Math.max(1, actors.length - 1 || 1));
    const beat = { start: 0, end: g.duration, effect: 'none', actors: Object.fromEntries(actors.map((a, k) => { const c = chars[a.characterId]; const xx = actors.length === 1 ? W / 2 : x(k); return [a.id, { x: xx, to: xx, pose: defaultPose(c, ['stand', 'stop', 'idle', 'talk']), facing: xx < W / 2 ? 1 : -1 }]; })) };
    const scene = normaliseScene({ name: `${base} · ${i + 1}`, duration: g.duration, actors, beats: [beat], dialogue: g.cues.map(c => ({ start: c.start, end: c.end, actor: idOf(c.speaker || 'Narrator'), text: c.text })), notes: i === 0 ? notes.join('\n') : '', source: { kind: 'script', script: path.basename(name) } }, null, { charsById: chars });
    created.push(store.put(STORE, scene));
  }
  return { scenes: created, lines: cues.length, timed, notes: notes.length, unmatched: [...unmatched], overflow: [...overflow], timing: timed ? 'SRT times kept inside each scene.' : 'Times estimated at 2.4 words a second; check them.' };
}

/* ------------------------------- subtitles ------------------------------- */
const srtStamp = s => { const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
function toSrt(scene, { speakers = false } = {}) {
  const label = Object.fromEntries(scene.actors.map(a => [a.id, a.label]));
  return scene.dialogue.map((d, i) => `${i + 1}\n${srtStamp(d.start)} --> ${srtStamp(d.end)}\n${speakers && label[d.actor] ? label[d.actor] + ': ' : ''}${d.text}\n`).join('\n');
}

/* ------------------------------- recording ------------------------------- */
async function saveRecording(store, dataDir, buffer, scene) {
  if (!buffer || buffer.length < 1000) throw error('The recording is empty.');
  const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(f => fs.existsSync(f)) || null;
  if (!ffmpeg) throw error('Saving scenes needs ffmpeg (brew install ffmpeg).', 412);
  const p = scene.profile, w = p.aspect === '9:16' ? p.height : Math.round(p.height * 16 / 9), h = p.aspect === '9:16' ? Math.round(p.height * 16 / 9) : p.height;
  const crf = { draft: 28, standard: 21, high: 17 }[p.quality];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-scene-'));
  try {
    const inp = path.join(dir, 'in.bin'), out = path.join(dir, 'out.mp4'); fs.writeFileSync(inp, buffer);
    await new Promise((resolve, reject) => require('node:child_process').execFile(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', inp, '-vf', `scale=${w - w % 2}:${h - h % 2}:flags=lanczos,fps=${p.fps}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { timeout: 300000 }, e => e ? reject(error('ffmpeg could not convert the recording: ' + String(e.message).slice(0, 200), 500)) : resolve()));
    return media.saveMedia(store, dataDir, { buffer: fs.readFileSync(out), originalName: `${clip(scene.name, 70)}.mp4`, source: 'character-studio', expectKind: 'video', provenance: { generator: 'character-studio-scene', sceneId: scene.id, sceneName: scene.name, profile: p } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ------------------------------- starter: Mira & Inchi ------------------------------- */
// Drawings and courtyard from Toon Studio (made for the Mira–Inchi project). Its bundled Piper voices are
// CC BY-NC-SA (non-commercial) and are not used: the characters speak with Kokoro Hindi voices.
const STARTER = {
  mira: { name: 'Mira', tagline: 'Curious girl with a wooden mallet', language: 'Hindi', voice: { engine: 'kokoro', mix: [{ voice: 'hf_beta', weight: 1 }], speed: 1.05, pitch: 1 },
    poses: [['run', ['mira-0.png', 'mira-1.png']], ['tap', ['mira-2.png']], ['stop', ['mira-3.png']]] },
  inchi: { name: 'Inchi', tagline: 'The learning robot', language: 'Hindi', voice: { engine: 'kokoro', mix: [{ voice: 'hm_psi', weight: 0.6 }, { voice: 'hf_alpha', weight: 0.4 }], speed: 1.1, pitch: 2 },
    poses: [['run', ['inchi-0.png', 'inchi-1.png']], ['flinch', ['inchi-2.png']], ['scared', ['inchi-3.png']]] },
};
const STARTER_DIR = path.join(__dirname, '..', 'public', 'cs-assets', 'toon');
function starterScene(mira, inchi) {
  const A = (m, i, e = 'none') => ({ actors: { a1: m, a2: i }, effect: e });
  const B = [[0, 1.3, { x: 565, to: 565, pose: 'stop', facing: 1 }, { x: 970, to: 970, pose: 'scared', facing: 1 }], [1.3, 1.8, { x: 565, to: 565, pose: 'tap', facing: 1 }, { x: 970, to: 970, pose: 'flinch', facing: 1 }, 'bonk'],
    [1.8, 4.8, { x: 565, to: 1160, pose: 'run', facing: 1 }, { x: 970, to: 1620, pose: 'run', facing: 1 }, 'dust'], [4.8, 7.7, { x: 1620, to: 820, pose: 'run', facing: -1 }, { x: 1170, to: 370, pose: 'run', facing: -1 }, 'dust'],
    [7.7, 11.4, { x: 300, to: 1160, pose: 'run', facing: 1 }, { x: 720, to: 1620, pose: 'run', facing: 1 }, 'dust'], [11.4, 16, { x: 960, to: 960, pose: 'stop', facing: 1 }, { x: 1450, to: 1450, pose: 'scared', facing: -1 }]];
  return { name: 'Mira & Inchi · The runaway robot', duration: 16, background: { kind: 'asset', asset: 'courtyard' },
    actors: [{ id: 'a1', characterId: mira.id, label: 'Mira', scale: 1, y: 985 }, { id: 'a2', characterId: inchi.id, label: 'Inchi', scale: 0.92, y: 985 }],
    beats: B.map(([s, e, m, i, fx]) => ({ start: s, end: e, ...A(m, i, fx), target: fx === 'bonk' ? 'a2' : null })),
    dialogue: [{ start: 1.5, end: 4.5, actor: 'a2', text: 'आई! आई! लग गई, लग गई!' }, { start: 5.2, end: 7.8, actor: 'a1', text: 'अरे, रुक जा भाई!' }, { start: 8.2, end: 11.4, actor: 'a2', text: 'आई! आई! लग गई, लग गई!' }, { start: 12, end: 15, actor: 'a1', text: 'अच्छा, अब डरो मत। चलो, साथ में देखते हैं।' }],
    shots: [{ start: 0, end: 1.8, zoom: 1.35, x: 800, y: 600, toZoom: 1.25, toX: 800, toY: 600, transition: 'fade' }, { start: 1.8, end: 11.4, zoom: 1, x: 960, y: 540, toZoom: 1, toX: 960, toY: 540, transition: 'cut' }, { start: 11.4, end: 16, zoom: 1, x: 960, y: 540, toZoom: 1.3, toX: 1180, toY: 640, transition: 'cut' }],
    source: { kind: 'starter' } };
}
/** Adds Mira and Inchi (drawn poses in the Library) and the demo scene. Existing characters with those names get the poses added. */
function addStarter(store, dataDir) {
  const out = {};
  for (const [key, s] of Object.entries(STARTER)) {
    const cutouts = s.poses.map(([poseName, files]) => ({ name: poseName, fps: 8, facing: 1, frames: files.map(f => media.saveMedia(store, dataDir, { buffer: fs.readFileSync(path.join(STARTER_DIR, f)), originalName: `${s.name} — ${poseName} (${f}).png`, source: 'character-studio', expectKind: 'image', provenance: { generator: 'toon-studio-starter', character: s.name } }).id) }));
    const existing = characters.list(store).find(c => c.name.toLowerCase() === s.name.toLowerCase() && !c.builtin);
    out[key] = existing ? characters.update(store, existing.id, { cutouts: [...(existing.cutouts || []).filter(c => !s.poses.some(([n]) => n === c.name)), ...cutouts] })
      : characters.create(store, { name: s.name, tagline: s.tagline, language: s.language, voice: s.voice, cutouts });
  }
  const scene = create(store, starterScene(out.mira, out.inchi));
  return { characters: [out.mira, out.inchi], scene };
}

function catalog() { return { limits: LIMITS, effects: EFFECTS, easings: EASINGS, backdrops: Object.entries(BACKDROPS).map(([id, b]) => ({ id, label: b.label, url: '/' + b.file })), stage: { width: W, height: H, xMin: X_MIN, xMax: X_MAX, ground: GROUND }, moves: Object.keys(puppet.MOVES) }; }

const normaliseCutouts = puppet.normaliseCutouts;
module.exports = { list, get, create, update, remove, normaliseScene, normaliseCutouts, posesFor, defaultPose, cover, direct, directorPrompt, parseJson, chatModels, parseScript, groupScenes, importScript, splitSpeaker, toSrt, saveRecording, addStarter, catalog, LIMITS, EFFECTS, STORE };
