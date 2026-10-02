'use strict';
/* ===========================================================================
 * VoiceStudio (optional): extra voices, cloned voices and 600+ languages
 *
 * VoiceStudio (github.com/debpalash/VoiceStudio) is a separate desktop app
 * with a local API on http://localhost:3900. NOVA only talks to that API; no
 * VoiceStudio code is included in NOVA (it is AGPL-licensed). Voice cloning
 * happens inside VoiceStudio, which asks for the speaker's permission and
 * watermarks what it makes. NOVA lists the voice profiles and asks for speech.
 *
 * Only loopback addresses are accepted, so text never leaves this computer.
 * ========================================================================= */
const DEFAULT_URL = 'http://127.0.0.1:3900';

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
let fetchImpl = (...a) => fetch(...a);
function setFetch(fn) { const prev = fetchImpl; fetchImpl = fn; return prev; }

function baseUrl() {
  const raw = process.env.VOICESTUDIO_URL || DEFAULT_URL;
  let u; try { u = new URL(raw); } catch (_) { throw error('VOICESTUDIO_URL is not a valid address.', 500); }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname) || u.protocol !== 'http:') throw error('VoiceStudio must run on this computer (http://127.0.0.1).', 403);
  return u.origin;
}

async function call(path, init = {}, timeoutMs = 4000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetchImpl(baseUrl() + path, { ...init, signal: c.signal });
    if (!r.ok) throw error(`VoiceStudio ${path} answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`, 502);
    return r;
  } catch (e) {
    if (e.statusCode) throw e;
    throw error('VoiceStudio is not running. Open the VoiceStudio app, then try again.', 503);
  } finally { clearTimeout(t); }
}

/** Voices from the response of GET /v1/audio/voices, whatever shape it has. */
function normaliseVoices(body) {
  const list = Array.isArray(body) ? body : body?.voices || body?.profiles || body?.data || [];
  return list.map(v => typeof v === 'string' ? { id: v, name: v, language: null, engine: null, cloned: false } : {
    id: String(v.id || v.voice_id || v.profile_id || v.name || ''),
    name: String(v.name || v.label || v.id || 'Voice'),
    language: v.language || v.lang || null,
    engine: v.engine || v.model || null,
    cloned: Boolean(v.cloned || v.type === 'clone' || v.source === 'clone'),
  }).filter(v => v.id);
}

async function status() {
  try {
    const r = await call('/v1/audio/voices');
    const voices = normaliseVoices(await r.json().catch(() => ({})));
    return { reachable: true, url: baseUrl(), voices };
  } catch (e) {
    return { reachable: false, url: (() => { try { return baseUrl(); } catch (_) { return null; } })(), error: e.message, voices: [] };
  }
}

/** Speech for text with a VoiceStudio voice profile; returns a WAV buffer. */
async function speak(text, { voice, model = null } = {}) {
  if (!voice) throw error('Choose a VoiceStudio voice first.');
  const body = { input: String(text).slice(0, 6000), voice: String(voice), response_format: 'wav', ...(model ? { model } : {}) };
  const r = await call('/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 180000);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw error('VoiceStudio returned no audio.', 502);
  return buf;
}

module.exports = { status, speak, baseUrl, normaliseVoices, setFetch, DEFAULT_URL };
