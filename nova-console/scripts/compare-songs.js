#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * NOVA — compare ACE-Step 1 and ACE-Step 1.5 on the same English and Hindi song.
 *
 * Needs NOVA and ComfyUI running with both engines installed. For each song it
 * asks NOVA to "Compare 1 vs 1.5" (same style, lyrics and seed), then has
 * whisper transcribe each result and scores how many of the sung lyric words
 * it could hear — a rough, objective check of how clearly each engine sings.
 * Listen too: the numbers do not judge melody, voice or mix.
 * Report: data/checks/songs-compare.md (and printed).
 * ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.NOVA_URL || 'http://127.0.0.1:8787';

const SONGS = [
  { title: 'Monsoon Window (English)', language: 'en', bpm: 90, keyscale: 'A minor', seconds: 30,
    style: 'cinematic pop ballad, female vocals, piano, strings, soft drums, 90 bpm',
    lyrics: '[verse]\nRain on the window, city lights below\nYour hand in my hand, we are walking slow\n[chorus]\nStay with me tonight, under monsoon skies\nEvery drop of rain is a light in your eyes' },
  { title: 'Monsoon Window (Hindi)', language: 'hi', bpm: 90, keyscale: 'A minor', seconds: 30,
    style: 'bollywood romantic ballad, female vocals, tabla, sitar, strings, 90 bpm',
    lyrics: '[verse]\nखिड़की पे बारिश, नीचे शहर की रौशनी\nहाथों में हाथ है, धीमी सी ये ज़िंदगी\n[chorus]\nआज रात रुक जा, सावन के आसमान तले\nहर बूँद में तेरी आँखों के दीये जले' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function waitJob(id, minutes) {
  const end = Date.now() + minutes * 60000; let last = '';
  for (;;) {
    const j = await api('GET', '/api/images/jobs/' + id);
    if (j.status === 'done') return j;
    if (j.status !== 'running') throw new Error(j.error || j.status);
    if (j.progress && j.progress !== last) { last = j.progress; console.log('   ' + j.progress); }
    if (Date.now() > end) throw new Error(`still running after ${minutes} min`);
    await sleep(3000);
  }
}
const words = t => String(t).replace(/\[[^\]]*\]/g, ' ').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
function heard(lyrics, transcript) {
  const want = words(lyrics), got = new Set(words(transcript));
  return want.length ? Math.round((want.filter(w => got.has(w)).length / want.length) * 100) : 0;
}
async function transcribe(id, language) {
  await api('POST', '/api/media/' + id + '/transcribe', { language });
  for (let i = 0; i < 200; i++) {
    const m = await api('GET', '/api/media/' + id);
    if (m.transcription?.status === 'done') return m.transcript.text.replace(/\[\d\d:\d\d:\d\d\]\s*/g, '').replace(/\n/g, ' ');
    if (m.transcription?.status === 'failed') throw new Error(m.transcription.error);
    await sleep(2000);
  }
  throw new Error('transcription timed out');
}

(async () => {
  try { await api('GET', '/api/health'); } catch (_) { console.error('NOVA is not running at ' + BASE); process.exit(1); }
  const st = await api('GET', '/api/audio/status');
  if (!st.comfy.music15?.ready) { console.error('ACE-Step 1.5 is not ready: ' + (st.comfy.music15?.missing || []).join('; ')); process.exit(1); }
  if (!st.comfy.music?.ready) { console.error('ACE-Step 1 is not ready: ' + st.comfy.music.missing.join('; ')); process.exit(1); }
  const rows = [];
  for (const song of SONGS) {
    console.log(`\n▶ ${song.title}`);
    const job = await api('POST', '/api/audio/music-compare', { prompt: song.style, lyrics: song.lyrics, title: song.title, language: song.language, bpm: song.bpm, keyscale: song.keyscale, seconds: song.seconds, seed: 20260927 });
    const done = await waitJob(job.id, 60);
    for (const id of done.mediaIds) {
      const m = await api('GET', '/api/media/' + id);
      const engine = m.provenance.engine === 'ace-step-1.5' ? 'ACE-Step 1.5' : 'ACE-Step 1';
      let text = '', score = null;
      try { text = await transcribe(id, song.language); score = heard(song.lyrics, text); } catch (e) { text = '(transcription failed: ' + e.message + ')'; }
      rows.push({ song: song.title, engine, seconds: m.provenance.secondsTaken, score, text, name: m.originalName });
      console.log(`   ${engine}: made in ${m.provenance.secondsTaken}s · lyrics heard ${score ?? '?'}% · "${text.slice(0, 90)}"`);
    }
  }
  const md = `# ACE-Step 1 vs 1.5 · ${new Date().toLocaleString()}\n\nSame style, lyrics and seed for both engines. "Lyrics heard" = share of the lyric words whisper recognised in the song (a rough measure of clear singing; it does not judge melody or voice). Listen to both in Media > Library.\n\n| Song | Engine | Time to make | Lyrics heard | What whisper heard |\n|---|---|---|---|---|\n` +
    rows.map(r => `| ${r.song} | ${r.engine} | ${r.seconds}s | ${r.score ?? '?'}% | ${r.text.slice(0, 140).replace(/\|/g, '/')} |`).join('\n') + '\n';
  const dir = path.join(__dirname, '..', 'data', 'checks'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'songs-compare.md'), md);
  console.log('\n' + md + '\nSaved: ' + path.join(dir, 'songs-compare.md'));
})().catch(e => { console.error(e); process.exit(1); });
