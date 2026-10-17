/* ===========================================================================
 * Character Studio › Scenes (UI)
 *
 * Several characters on one backdrop: beats, lines with captions and voices,
 * comic effects and camera shots. A local model can direct a scene from a
 * prompt; scripts (TXT, MD, DOCX, SRT) become scenes; scenes record to the
 * Library as MP4 and export SRT. Also: "Drawn poses" for a character, made
 * from a character sheet (a grid of drawings).
 * ========================================================================= */
import { drawScene, frameState, outputSize, STAGE } from './cs-scene.js';

let D = null; // helpers from index.html
const S = { list: [], sel: null, draft: null, dirty: false, t: 0, playing: false, beat: 0, tab: 'direct', cat: null, chars: [], imgs: new Map(), puppets: new Map(), voices: new Map(), ac: null, raf: 0, playFrom: 0, playAt: 0, sources: [], recording: false };
const esc = s => D.escapeHtml(String(s ?? ''));
const F = () => D.FIELD + ';width:100%';
const fmt = t => (Math.round(t * 10) / 10).toFixed(1) + ' s';
const charOf = a => a && a.characterId ? S.chars.find(c => c.id === a.characterId) : null;
function posesOf(c) { if (!c) return []; const cut = (c.cutouts || []).map(p => p.name); const mv = c.puppet ? S.cat.moves : []; return [...new Set([...cut, ...mv])]; }

/* ------------------------------- assets ------------------------------- */
function img(src) {
  if (S.imgs.has(src)) return S.imgs.get(src);
  const i = new Image(); i.crossOrigin = 'anonymous'; i.src = src; S.imgs.set(src, i); return i;
}
function bgImage(scene) {
  const b = scene.background || {};
  if (b.kind === 'media' && b.mediaId) return img(D.mediaUrl(b.mediaId));
  if (b.kind === 'asset') { const a = (S.cat.backdrops || []).find(x => x.id === b.asset); return a ? img(D.apiUrl(a.url)) : null; }
  return null;
}
const PW = 260, PH = 280;
function drawActor(ctx, actor, st, hp) {
  const c = charOf(actor); if (!c) return;
  const cut = (c.cutouts || []).find(p => p.name === st.pose);
  if (cut) {
    const n = cut.frames.length, fi = n > 1 ? Math.floor(st.frameTime * (cut.fps || 8)) % n : 0, im = img(D.mediaUrl(cut.frames[fi]));
    if (!im.complete || !im.naturalWidth) return;
    const k = hp / im.naturalHeight; if (cut.facing === -1) ctx.scale(-1, 1);
    ctx.drawImage(im, -im.naturalWidth * k / 2, -hp, im.naturalWidth * k, hp); return;
  }
  if (!c.puppet) return;
  let cv = S.puppets.get(actor.id); if (!cv) { cv = document.createElement('canvas'); cv.width = PW; cv.height = PH; S.puppets.set(actor.id, cv); }
  const move = st.talking && ['idle', 'stand'].includes(st.pose) ? 'talk' : (S.cat.moves.includes(st.pose) ? st.pose : 'idle');
  D.csDraw(cv.getContext('2d'), c.puppet, D.csPose(move, st.frameTime + actor.id.charCodeAt(1), null), PW, PH, { transparent: true });
  const ground = PH * (490 / 560), k = hp / (PH * 0.78);
  ctx.drawImage(cv, -PW * k / 2, -ground * k, PW * k, PH * k);
}
const envFor = (scene, extra = {}) => ({ background: (() => { const b = bgImage(scene); return b && b.complete && b.naturalWidth ? b : null; })(), drawActor, actorHeight: a => 380 * (a.scale || 1), captions: scene.profile?.captions !== false, labels: Object.fromEntries(scene.actors.map(a => [a.id, a.label])), ...extra });

/* ------------------------------- voices ------------------------------- */
function ac() { if (!S.ac) S.ac = new (window.AudioContext || window.webkitAudioContext)(); return S.ac; }
async function voice(line, scene) {
  const a = scene.actors.find(x => x.id === line.actor), c = charOf(a); if (!c) return null;
  const key = c.id + '|' + c.updatedAt + '|' + line.text;
  if (!S.voices.has(key)) S.voices.set(key, (async () => {
    const r = await fetch(D.apiUrl('/api/characters/preview'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id, text: line.text }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'HTTP ' + r.status); }
    return ac().decodeAudioData(await r.arrayBuffer());
  })().catch(e => { S.voices.delete(key); throw e; }));
  return S.voices.get(key);
}
async function loadVoices(scene, say) {
  const out = new Map(); let failed = 0, first = '';
  for (const [i, l] of scene.dialogue.entries()) { if (say) say(`Preparing voices ${i + 1}/${scene.dialogue.length}…`); try { const b = await voice(l, scene); if (b) out.set(l.id, b); } catch (e) { failed++; first = first || e.message; } }
  return { buffers: out, failed, first };
}
function stopAudio() { for (const s of S.sources) { try { s.stop(); } catch (_) {} } S.sources = []; }
function schedule(buffers, scene, from, dest) {
  const ctx = ac(), now = ctx.currentTime;
  for (const l of scene.dialogue) { const b = buffers.get(l.id); if (!b || l.start + b.duration < from) continue; const src = ctx.createBufferSource(); src.buffer = b; src.connect(dest || ctx.destination); const off = Math.max(0, from - l.start); src.start(now + Math.max(0, l.start - from), off); S.sources.push(src); }
}

/* ------------------------------- data ------------------------------- */
async function load() {
  const [list, cat, chars] = await Promise.all([D.apiGet('/api/scenes'), S.cat ? Promise.resolve(S.cat) : D.apiGet('/api/scenes/catalog'), D.apiGet('/api/characters')]);
  S.list = list; S.cat = cat; S.chars = chars;
  if (S.sel && !list.some(s => s.id === S.sel)) S.sel = null;
  if (!S.sel && list.length) S.sel = list[0].id;
  if (!S.draft || S.draft.id !== S.sel || !S.dirty) { const s = list.find(x => x.id === S.sel); S.draft = s ? JSON.parse(JSON.stringify(s)) : null; S.dirty = false; }
}
function touch() { S.dirty = true; const b = document.getElementById('scSave'); if (b) { b.disabled = false; b.textContent = 'Save'; } }
async function save(quiet) {
  if (!S.draft) return;
  const r = await D.apiPost('/api/scenes/' + encodeURIComponent(S.draft.id), S.draft, 'PUT');
  const notes = r.notes || []; delete r.notes; S.draft = r; S.dirty = false; const i = S.list.findIndex(x => x.id === r.id); if (i >= 0) S.list[i] = r;
  const b = document.getElementById('scSave'); if (b) { b.disabled = true; b.textContent = 'Saved'; }
  if (notes.length) say('Fixed while saving: ' + notes.slice(0, 4).join(' ')); else if (!quiet) D.toast('Scene saved.');
}
function say(t) { const e = document.getElementById('scStatus'); if (e) e.textContent = t; }

/* ------------------------------- view ------------------------------- */
export async function renderScenes(root, deps) {
  D = deps; stop();
  try { await load(); } catch (e) { root.innerHTML = `<p class="empty-hint" style="color:var(--red)">${esc(e.message)}</p>`; return; }
  const d = S.draft;
  root.innerHTML = `
  <div class="cs-grid sc-grid">
    <aside class="panel cs-list" aria-label="Scenes">
      <button class="btn btn-amber btn-sm" id="scNew" style="width:100%;margin-bottom:6px">New scene</button>
      <button class="btn btn-line btn-sm" id="scStarter" style="width:100%;margin-bottom:10px">Add Mira &amp; Inchi demo</button>
      ${S.list.length ? S.list.map(s => `<button class="cs-item sc-item ${s.id === S.sel ? 'active' : ''}" data-sid="${esc(s.id)}"><span>${esc(s.name)}<small>${fmt(s.duration)} · ${s.actors.length} actor(s) · ${s.dialogue.length} line(s)</small></span></button>`).join('') : '<p class="empty-hint" style="font-size:12px">No scenes yet. Make one, add the Mira &amp; Inchi demo, or import a script.</p>'}
    </aside>
    ${d ? `<section class="panel cs-stage sc-stage">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input id="scName" aria-label="Scene name" value="${esc(d.name)}" style="${D.FIELD};flex:1"><button class="btn btn-amber btn-sm" id="scSave" ${S.dirty ? '' : 'disabled'}>${S.dirty ? 'Save' : 'Saved'}</button><button class="btn btn-ghost btn-sm" id="scDel" aria-label="Delete scene">Delete</button></div>
      <canvas id="scCanvas" width="960" height="540" aria-label="Scene stage" style="width:100%;aspect-ratio:16/9;border-radius:10px;background:#000"></canvas>
      <div class="cs-controls" style="align-items:center"><button class="btn btn-amber btn-sm" id="scPlay">${S.playing ? '❚❚ Pause' : '▶ Play'}</button><input type="range" id="scScrub" min="0" max="${d.duration}" step="0.02" value="${S.t}" style="flex:1" aria-label="Playhead"><span class="mono" id="scTime" style="font-size:11px;min-width:84px">${fmt(S.t)} / ${fmt(d.duration)}</span></div>
      <div class="sc-tl" id="scTl">${timelineHtml(d)}</div>
      <div class="empty-hint" id="scStatus" role="status" style="font-size:11.5px;min-height:16px"></div>
    </section>
    <section class="panel cs-side">
      <div class="cs-tabs" role="tablist">${[['direct', 'Direct'], ['cast', 'Cast'], ['beats', 'Beats'], ['lines', 'Lines'], ['camera', 'Camera'], ['backdrop', 'Backdrop'], ['script', 'Script'], ['render', 'Render']].map(([id, l]) => `<button role="tab" class="cs-tab ${S.tab === id ? 'active' : ''}" aria-selected="${S.tab === id}" data-sctab="${id}">${l}</button>`).join('')}</div>
      <div id="scTab"></div>
    </section>` : `<section class="panel" style="padding:18px;grid-column:span 2"><p class="empty-hint">Choose a scene or make one. A scene puts characters on a backdrop with movement, lines and camera, and records to the Library.</p><div id="scTab"></div></section>`}
  </div>`;
  root.querySelector('#scNew').onclick = async () => { try { const s = await D.apiPost('/api/scenes', { name: 'New scene' }); S.sel = s.id; S.draft = null; S.dirty = false; S.t = 0; S.tab = 'cast'; renderScenes(root, D); } catch (e) { D.toast(e.message); } };
  root.querySelector('#scStarter').onclick = async e => { e.target.disabled = true; try { const r = await D.apiPost('/api/scenes/starter', {}); S.sel = r.scene.id; S.draft = null; S.dirty = false; S.t = 0; S.tab = 'render'; D.toast('Added Mira, Inchi and the demo scene.'); renderScenes(root, D); } catch (er) { e.target.disabled = false; D.toast(er.message); } };
  for (const b of root.querySelectorAll('[data-sid]')) b.onclick = () => { if (S.dirty && !confirm('Leave without saving this scene?')) return; S.sel = b.dataset.sid; S.draft = null; S.dirty = false; S.t = 0; S.beat = 0; renderScenes(root, D); };
  if (!d) { if (S.tab === 'script') scriptTab(root.querySelector('#scTab'), root); return; }
  root.querySelector('#scName').oninput = e => { d.name = e.target.value; touch(); };
  root.querySelector('#scSave').onclick = () => save().catch(e => D.toast(e.message));
  root.querySelector('#scDel').onclick = async () => { if (!confirm('Delete the scene "' + d.name + '"? Recordings in the Library stay.')) return; try { await D.apiPost('/api/scenes/' + encodeURIComponent(d.id), {}, 'DELETE'); S.sel = null; S.draft = null; S.dirty = false; renderScenes(root, D); } catch (e) { D.toast(e.message); } };
  root.querySelector('#scPlay').onclick = () => (S.playing ? pause() : play()).catch(e => D.toast(e.message));
  root.querySelector('#scScrub').oninput = e => { pause(); S.t = Number(e.target.value); paint(); };
  for (const t of root.querySelectorAll('[data-sctab]')) t.onclick = () => { S.tab = t.dataset.sctab; for (const u of root.querySelectorAll('[data-sctab]')) { u.classList.toggle('active', u === t); u.setAttribute('aria-selected', String(u === t)); } renderTab(root); };
  bindTimeline(root);
  renderTab(root);
  loop();
}

function timelineHtml(d) {
  const pc = v => (v / d.duration * 100).toFixed(3) + '%';
  const label = Object.fromEntries(d.actors.map(a => [a.id, a.label]));
  return `<div class="sc-row"><span class="sc-rl">Beats</span><div class="sc-lane">${d.beats.map((b, i) => `<button class="sc-blk ${i === S.beat ? 'on' : ''}" data-beat="${i}" style="left:${pc(b.start)};width:${pc(b.end - b.start)}" title="${fmt(b.start)}–${fmt(b.end)}">${b.effect !== 'none' ? b.effect : ''}</button>`).join('')}</div></div>
    <div class="sc-row"><span class="sc-rl">Lines</span><div class="sc-lane">${d.dialogue.map(l => `<button class="sc-blk sc-line" data-lt="${l.start}" style="left:${pc(l.start)};width:${pc(l.end - l.start)}" title="${esc((label[l.actor] || '—') + ': ' + l.text)}">${esc(label[l.actor] || '—')}</button>`).join('')}</div></div>
    ${d.shots.length ? `<div class="sc-row"><span class="sc-rl">Camera</span><div class="sc-lane">${d.shots.map(s => `<button class="sc-blk sc-shot" data-lt="${s.start}" style="left:${pc(s.start)};width:${pc(s.end - s.start)}">${s.toZoom > s.zoom + 0.05 ? 'zoom in' : s.toZoom < s.zoom - 0.05 ? 'zoom out' : s.zoom > 1.02 ? 'close' : 'wide'}${s.transition === 'fade' ? ' · fade' : ''}</button>`).join('')}</div></div>` : ''}
    <div class="sc-headbox"><div class="sc-head" id="scHead" style="left:${pc(S.t)}"></div></div>`;
}
function bindTimeline(root) {
  const tl = root.querySelector('#scTl'); if (!tl) return;
  for (const b of tl.querySelectorAll('[data-beat]')) b.onclick = e => { e.stopPropagation(); pause(); S.beat = Number(b.dataset.beat); S.t = S.draft.beats[S.beat].start + 0.01; S.tab = 'beats'; refresh(root); };
  for (const b of tl.querySelectorAll('[data-lt]')) b.onclick = e => { e.stopPropagation(); pause(); S.t = Number(b.dataset.lt) + 0.01; paint(); };
  tl.onclick = e => { const lane = tl.querySelector('.sc-lane'); const r = lane.getBoundingClientRect(); if (e.clientX < r.left) return; pause(); S.t = Math.max(0, Math.min(S.draft.duration, (e.clientX - r.left) / r.width * S.draft.duration)); paint(); };
}
function refresh(root) {
  const tl = root.querySelector('#scTl'); if (tl) { tl.innerHTML = timelineHtml(S.draft); bindTimeline(root); }
  const sc = root.querySelector('#scScrub'); if (sc) sc.max = S.draft.duration;
  for (const u of root.querySelectorAll('[data-sctab]')) { const on = u.dataset.sctab === S.tab; u.classList.toggle('active', on); u.setAttribute('aria-selected', String(on)); }
  renderTab(root); paint();
}

/* ------------------------------- playback ------------------------------- */
function paint() {
  const cv = document.getElementById('scCanvas'); if (!cv || !S.draft) return false;
  drawScene(cv.getContext('2d'), S.draft, S.t, cv.width, cv.height, envFor(S.draft, { guides: !S.playing }));
  const sc = document.getElementById('scScrub'); if (sc && document.activeElement !== sc) sc.value = S.t;
  const tm = document.getElementById('scTime'); if (tm) tm.textContent = `${fmt(S.t)} / ${fmt(S.draft.duration)}`;
  const hd = document.getElementById('scHead'); if (hd) hd.style.left = (S.t / S.draft.duration * 100) + '%';
  const bi = S.draft.beats.findIndex(b => S.t >= b.start && S.t < b.end); if (S.playing && bi >= 0 && bi !== S.beat) { S.beat = bi; }
  return true;
}
function loop() { cancelAnimationFrame(S.raf); const step = () => { if (!document.getElementById('scCanvas')) { stop(); return; } if (S.playing) { S.t = S.playFrom + (performance.now() - S.playAt) / 1000; if (S.t >= S.draft.duration) { S.t = S.draft.duration; pause(); } } paint(); S.raf = requestAnimationFrame(step); }; S.raf = requestAnimationFrame(step); }
async function play() {
  if (!S.draft) return; if (S.t >= S.draft.duration - 0.05) S.t = 0;
  const b = document.getElementById('scPlay'); if (b) b.textContent = '…';
  const v = await loadVoices(S.draft, say); if (v.failed) say(`${v.failed} line(s) have no voice (${v.first}). Captions still show.`); else say('');
  if (ac().state === 'suspended') await ac().resume();
  S.playFrom = S.t; S.playAt = performance.now(); S.playing = true; schedule(v.buffers, S.draft, S.t);
  if (b) b.textContent = '❚❚ Pause';
}
async function pause() { S.playing = false; stopAudio(); const b = document.getElementById('scPlay'); if (b) b.textContent = '▶ Play'; }
function stop() { cancelAnimationFrame(S.raf); S.playing = false; stopAudio(); }

/* ------------------------------- tabs ------------------------------- */
function renderTab(root) {
  const body = root.querySelector('#scTab'); if (!body) return;
  ({ direct: directTab, cast: castTab, beats: beatsTab, lines: linesTab, camera: cameraTab, backdrop: backdropTab, script: scriptTab, render: renderTabBody }[S.tab] || directTab)(body, root);
}
const sub = t => `<div class="cs-sub">${t}</div>`;

function directTab(body, root) {
  const d = S.draft, models = S.cat.models || [];
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">Describe what happens, in Hindi or English. A local model writes the beats, lines and camera for this cast; you can change everything afterwards. It plans movement only: it does not draw new pictures.</p>
    ${models.length ? `<label class="cs-field"><span>Model</span><select id="scModel" style="${F()}">${models.map(m => `<option ${m === S.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : '<div class="panel" style="padding:10px;font-size:12.5px">No local chat model is installed. Install one in <b>Models</b> (for example qwen3:8b), then come back.</div>'}
    <label class="cs-field" style="margin-top:6px"><span>Direction</span><textarea id="scPrompt" rows="6" style="${F()};resize:vertical" placeholder="Mira taps Inchi with her mallet. Inchi runs away shouting “आई! आई!”, Mira chases him round the courtyard, then calms him down.">${esc(S.prompt || d.source?.prompt || '')}</textarea></label>
    <div class="cs-sub">Cast this model can use</div>
    <div style="font-size:12px">${d.actors.length ? d.actors.map(a => `<div><b>${esc(a.label)}</b>: ${esc(posesOf(charOf(a)).join(', ') || 'voice only')}</div>`).join('') : '<span class="empty-hint">No actors yet: add them in Cast.</span>'}</div>
    <div class="cs-chips" style="margin-top:8px"><button class="btn btn-amber btn-sm" id="scDirect" ${models.length && d.actors.length ? '' : 'disabled'}>Direct the scene</button></div>
    <p class="empty-hint" style="font-size:11px">Your current beats, lines and camera are replaced only when the model's answer is usable. Small models may need a shorter prompt or a second try.</p>`;
  const p = body.querySelector('#scPrompt'); p.oninput = () => { S.prompt = p.value; };
  if (body.querySelector('#scModel')) body.querySelector('#scModel').onchange = e => { S.model = e.target.value; };
  body.querySelector('#scDirect').onclick = async e => {
    const btn = e.target; btn.disabled = true; btn.textContent = 'Directing…'; say('Asking the local model… this can take a minute.');
    try {
      if (S.dirty) await save(true);
      const r = await D.apiPost('/api/scenes/' + encodeURIComponent(d.id) + '/direct', { prompt: p.value, model: body.querySelector('#scModel')?.value });
      const notes = r.notes || []; delete r.notes; delete r.model; S.draft = r; S.dirty = false; S.t = 0; S.beat = 0;
      say(`Directed by ${r.source.model}: ${r.beats.length} beats, ${r.dialogue.length} lines${r.shots.length ? ', ' + r.shots.length + ' shots' : ''}.${notes.length ? ' Fixed: ' + notes.slice(0, 3).join(' ') : ''}`);
      renderScenes(root, D);
    } catch (er) { say(er.message); btn.disabled = false; btn.textContent = 'Direct the scene'; }
  };
}

function castTab(body, root) {
  const d = S.draft, chars = S.chars.filter(c => c.puppet || (c.cutouts || []).length);
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">Up to four actors. A character needs a 2D puppet or drawn poses to appear; "voice only" speaks off-screen with captions.</p>
    ${d.actors.map(a => `<div class="panel sc-actor" style="padding:8px;margin-bottom:8px">
      <div class="cs-two"><label class="cs-field"><span>Character</span><select data-ac="${a.id}" data-k="characterId" style="${F()}"><option value="">Voice only (not drawn)</option>${chars.map(c => `<option value="${esc(c.id)}" ${c.id === a.characterId ? 'selected' : ''}>${esc(c.name)}${(c.cutouts || []).length ? ' · drawn' : ''}</option>`).join('')}</select></label>
        <label class="cs-field"><span>Name in the scene</span><input data-ac="${a.id}" data-k="label" value="${esc(a.label)}" style="${F()}"></label></div>
      <div class="cs-two"><label class="cs-field"><span>Size</span><input type="range" min="0.3" max="2.5" step="0.02" data-ac="${a.id}" data-k="scale" value="${a.scale}"></label><label class="cs-field"><span>Ground line</span><input type="range" min="600" max="1080" step="5" data-ac="${a.id}" data-k="y" value="${a.y}"></label></div>
      <button class="btn btn-ghost btn-sm" data-acdel="${a.id}">Remove ${esc(a.label)}</button></div>`).join('')}
    ${d.actors.length < 4 ? `<button class="btn btn-line btn-sm" id="scAddActor">Add actor</button>` : ''}
    <p class="empty-hint" style="font-size:11px;margin-top:8px">To give a character drawn poses from a character sheet, open <b>Characters</b> above, choose the character and use <b>Drawn poses</b>.</p>`;
  for (const el of body.querySelectorAll('[data-ac]')) el.oninput = () => {
    const a = d.actors.find(x => x.id === el.dataset.ac), k = el.dataset.k; let v = el.value;
    if (k === 'scale' || k === 'y') v = Number(v);
    if (k === 'characterId') { v = v || null; const c = S.chars.find(x => x.id === v); if (c && (!a.label || /^Actor \d/.test(a.label) || S.chars.some(x => x.name === a.label))) a.label = c.name; S.puppets.delete(a.id); const poses = posesOf(c); for (const b of d.beats) if (b.actors[a.id] && !poses.includes(b.actors[a.id].pose)) b.actors[a.id].pose = poses.find(p => /stand|idle|stop/.test(p)) || poses[0] || 'idle'; }
    a[k] = v; touch(); if (k === 'characterId') { refresh(root); } else paint();
  };
  for (const b of body.querySelectorAll('[data-acdel]')) b.onclick = () => { const id = b.dataset.acdel; d.actors = d.actors.filter(a => a.id !== id); for (const be of d.beats) delete be.actors[id]; d.dialogue = d.dialogue.map(l => l.actor === id ? { ...l, actor: null } : l); touch(); refresh(root); };
  if (body.querySelector('#scAddActor')) body.querySelector('#scAddActor').onclick = () => {
    let id = null; for (let k = 1; !id; k++) if (!d.actors.some(a => a.id === 'a' + k)) id = 'a' + k;
    const c = chars.find(x => !d.actors.some(a => a.characterId === x.id)) || null;
    d.actors.push({ id, characterId: c ? c.id : null, label: c ? c.name : 'Actor ' + id.slice(1), scale: 1, y: 1000 });
    const pose = (posesOf(c).find(p => /stand|idle|stop/.test(p)) || posesOf(c)[0] || 'idle'), x = 300 + (d.actors.length - 1) * 420;
    for (const b of d.beats) b.actors[id] = { x, to: x, pose, facing: x < 960 ? 1 : -1 };
    touch(); refresh(root);
  };
}

function beatsTab(body, root) {
  const d = S.draft; S.beat = Math.min(S.beat, d.beats.length - 1); const b = d.beats[S.beat];
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">A beat moves each actor from one place to another in one pose. Click a beat on the timeline, or split one at the playhead.</p>
    <div class="cs-chips">${d.beats.map((x, i) => `<button class="btn btn-sm ${i === S.beat ? 'btn-amber' : 'btn-line'}" data-bsel="${i}">${i + 1}</button>`).join('')}</div>
    <div class="cs-two" style="margin-top:8px"><label class="cs-field"><span>Starts</span><input type="number" step="0.1" id="scBs" value="${b.start}" ${S.beat === 0 ? 'disabled' : ''} style="${F()}"></label><label class="cs-field"><span>Ends</span><input type="number" step="0.1" id="scBe" value="${b.end}" ${S.beat === d.beats.length - 1 ? 'disabled' : ''} style="${F()}"></label></div>
    <div class="cs-two"><label class="cs-field"><span>Effect</span><select id="scFx" style="${F()}">${S.cat.effects.map(e => `<option ${e === b.effect ? 'selected' : ''}>${e}</option>`).join('')}</select></label><label class="cs-field"><span>On</span><select id="scFxT" style="${F()}"><option value="">(automatic)</option>${d.actors.map(a => `<option value="${a.id}" ${a.id === b.target ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label></div>
    ${d.actors.map(a => { const st = b.actors[a.id] || { x: 960, to: 960, pose: 'idle', facing: 1 }; const poses = posesOf(charOf(a)); return `<div class="panel" style="padding:8px;margin-top:8px"><b style="font-size:12.5px">${esc(a.label)}</b>
      <div class="cs-two"><label class="cs-field"><span>Pose</span><select data-bk="${a.id}" data-f="pose" style="${F()}">${(poses.length ? poses : ['idle']).map(p => `<option ${p === st.pose ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
        <label class="cs-field"><span>Facing</span><select data-bk="${a.id}" data-f="facing" style="${F()}"><option value="1" ${st.facing === 1 ? 'selected' : ''}>Right →</option><option value="-1" ${st.facing === -1 ? 'selected' : ''}>← Left</option></select></label></div>
      <div class="cs-two"><label class="cs-field"><span>From x <span class="mono" data-v="${a.id}x">${st.x}</span></span><input type="range" min="80" max="1840" step="5" data-bk="${a.id}" data-f="x" value="${st.x}"></label><label class="cs-field"><span>To x <span class="mono" data-v="${a.id}to">${st.to}</span></span><input type="range" min="80" max="1840" step="5" data-bk="${a.id}" data-f="to" value="${st.to}"></label></div></div>`; }).join('')}
    <div class="cs-chips" style="margin-top:8px"><button class="btn btn-line btn-sm" id="scSplit">Split at playhead</button>${d.beats.length > 1 ? '<button class="btn btn-ghost btn-sm" id="scBdel">Delete beat</button>' : ''}</div>
    <div class="cs-two" style="margin-top:8px"><label class="cs-field"><span>Scene length (3–30 s)</span><input type="number" min="3" max="30" step="0.5" id="scDur" value="${d.duration}" style="${F()}"></label></div>`;
  for (const x of body.querySelectorAll('[data-bsel]')) x.onclick = () => { S.beat = Number(x.dataset.bsel); S.t = d.beats[S.beat].start + 0.01; refresh(root); };
  const setT = (i, k, v) => { const lo = i > 0 ? d.beats[i - 1].start + 0.1 : 0, bb = d.beats[i]; if (k === 'start') { const nv = Math.min(bb.end - 0.1, Math.max(lo, v)); bb.start = nv; d.beats[i - 1].end = nv; } else { const hi = i < d.beats.length - 1 ? d.beats[i + 1].end - 0.1 : d.duration; const nv = Math.max(bb.start + 0.1, Math.min(hi, v)); bb.end = nv; d.beats[i + 1].start = nv; } touch(); refresh(root); };
  body.querySelector('#scBs').onchange = e => setT(S.beat, 'start', Number(e.target.value));
  body.querySelector('#scBe').onchange = e => setT(S.beat, 'end', Number(e.target.value));
  body.querySelector('#scFx').onchange = e => { b.effect = e.target.value; touch(); refresh(root); };
  body.querySelector('#scFxT').onchange = e => { b.target = e.target.value || null; touch(); paint(); };
  for (const el of body.querySelectorAll('[data-bk]')) el.oninput = () => {
    const st = b.actors[el.dataset.bk] || (b.actors[el.dataset.bk] = { x: 960, to: 960, pose: 'idle', facing: 1 }), f = el.dataset.f;
    st[f] = f === 'pose' ? el.value : Number(el.value);
    if (f === 'x' || f === 'to') { const v = body.querySelector(`[data-v="${el.dataset.bk}${f}"]`); if (v) v.textContent = el.value; S.t = f === 'x' ? b.start + 0.01 : Math.max(b.start, b.end - 0.02); }
    touch(); paint();
  };
  body.querySelector('#scSplit').onclick = () => {
    const i = d.beats.findIndex(x => S.t > x.start + 0.1 && S.t < x.end - 0.1); if (i < 0) return say('Move the playhead inside a beat (not at its edge) to split it.');
    const x = d.beats[i], t = Math.round(S.t * 100) / 100, k = (t - x.start) / (x.end - x.start);
    const mid = Object.fromEntries(Object.entries(x.actors).map(([id, s]) => [id, Math.round(s.x + (s.to - s.x) * k)]));
    const second = { start: t, end: x.end, effect: 'none', target: null, actors: Object.fromEntries(Object.entries(x.actors).map(([id, s]) => [id, { ...s, x: mid[id] }])) };
    for (const [id, s] of Object.entries(x.actors)) s.to = mid[id];
    x.end = t; d.beats.splice(i + 1, 0, second); S.beat = i + 1; touch(); refresh(root);
  };
  if (body.querySelector('#scBdel')) body.querySelector('#scBdel').onclick = () => { const i = S.beat; if (i === 0) { d.beats[1].start = 0; } else d.beats[i - 1].end = d.beats[i].end; d.beats.splice(i, 1); S.beat = Math.max(0, i - 1); touch(); refresh(root); };
  body.querySelector('#scDur').onchange = e => { const v = Math.min(30, Math.max(3, Number(e.target.value) || d.duration)); const last = d.beats[d.beats.length - 1]; if (v <= last.start + 0.1) { say('Shorten or delete the last beat first.'); e.target.value = d.duration; return; } d.duration = v; last.end = v; d.dialogue = d.dialogue.filter(l => l.start < v).map(l => ({ ...l, end: Math.min(v, l.end) })); if (d.shots.length) { d.shots = d.shots.filter(s => s.start < v - 0.05); d.shots[d.shots.length - 1].end = v; } S.t = Math.min(S.t, v); touch(); refresh(root); };
}

function linesTab(body, root) {
  const d = S.draft;
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">Each line is spoken in the character's voice and shown as a caption. Hindi in Devanagari works.</p>
    ${d.dialogue.map(l => `<div class="panel" style="padding:8px;margin-bottom:6px"><div class="cs-two"><select data-ln="${l.id}" data-f="actor" style="${F()}"><option value="">(caption only)</option>${d.actors.map(a => `<option value="${a.id}" ${a.id === l.actor ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>
      <div style="display:flex;gap:4px"><input type="number" step="0.1" data-ln="${l.id}" data-f="start" value="${l.start}" style="${D.FIELD};width:70px" aria-label="Start"><input type="number" step="0.1" data-ln="${l.id}" data-f="end" value="${l.end}" style="${D.FIELD};width:70px" aria-label="End"><button class="btn btn-ghost btn-sm" data-lndel="${l.id}" aria-label="Delete line">✕</button></div></div>
      <textarea data-ln="${l.id}" data-f="text" rows="2" style="${F()};margin-top:4px">${esc(l.text)}</textarea></div>`).join('') || '<p class="empty-hint" style="font-size:11.5px">No lines yet.</p>'}
    <div class="cs-chips"><button class="btn btn-line btn-sm" id="scAddLn">Add line at playhead</button>${d.dialogue.length ? '<button class="btn btn-line btn-sm" id="scFit">Time lines to their voices</button>' : ''}</div>
    <p class="empty-hint" style="font-size:11px">"Time lines to their voices" makes each line as long as its voice takes (Kokoro), so the end is not cut off.</p>`;
  for (const el of body.querySelectorAll('[data-ln]')) el.onchange = () => { const l = d.dialogue.find(x => x.id === el.dataset.ln), f = el.dataset.f; l[f] = f === 'start' || f === 'end' ? Math.max(0, Math.min(d.duration, Number(el.value))) : f === 'actor' ? (el.value || null) : el.value.slice(0, 500); if (l.end - l.start < 0.3) l.end = Math.min(d.duration, l.start + 0.3); d.dialogue.sort((a, b) => a.start - b.start); touch(); refresh(root); };
  for (const b of body.querySelectorAll('[data-lndel]')) b.onclick = () => { d.dialogue = d.dialogue.filter(l => l.id !== b.dataset.lndel); touch(); refresh(root); };
  body.querySelector('#scAddLn').onclick = () => { const st = Math.min(d.duration - 0.5, Math.round(S.t * 10) / 10); d.dialogue.push({ id: 'ln_' + Math.random().toString(16).slice(2, 10).padEnd(8, '0'), start: st, end: Math.min(d.duration, st + 2.5), actor: d.actors[0]?.id || null, text: 'नमस्ते!' }); d.dialogue.sort((a, b) => a.start - b.start); touch(); refresh(root); };
  if (body.querySelector('#scFit')) body.querySelector('#scFit').onclick = async e => {
    e.target.disabled = true; let n = 0, fail = 0;
    for (const l of d.dialogue) { try { const b = await voice(l, d); if (b) { l.end = Math.min(d.duration, Math.round((l.start + b.duration + 0.15) * 100) / 100); n++; } } catch (_) { fail++; } say(`Timing lines… ${n + fail}/${d.dialogue.length}`); }
    const late = d.dialogue.filter(l => l.end >= d.duration - 0.01).length;
    touch(); refresh(root); say(`Timed ${n} line(s) to their voices${fail ? `; ${fail} had no voice` : ''}${late ? `; ${late} reach the end of the scene — lengthen the scene if a line is cut` : ''}.`);
  };
}

function cameraTab(body, root) {
  const d = S.draft;
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">Without shots the camera shows the whole stage. Shots pan and zoom (1 = whole stage, up to 3.5) and start with a cut or a fade from black.</p>
    ${d.shots.map((s, i) => `<div class="panel" style="padding:8px;margin-bottom:6px"><b style="font-size:12px">Shot ${i + 1} · ${fmt(s.start)}–${fmt(s.end)}</b>
      <div class="sc-cam">${[['zoom', 'Zoom', 1, 3.5, 0.05], ['x', 'Centre x', 0, 1920, 10], ['y', 'Centre y', 0, 1080, 10]].map(([k, l, lo, hi, st]) => `<label class="cs-field"><span>${l}: start → end</span><span style="display:flex;gap:4px"><input type="number" min="${lo}" max="${hi}" step="${st}" data-sh="${i}" data-f="${k}" value="${s[k]}" style="${D.FIELD};width:50%"><input type="number" min="${lo}" max="${hi}" step="${st}" data-sh="${i}" data-f="to${k[0].toUpperCase() + k.slice(1)}" value="${s['to' + k[0].toUpperCase() + k.slice(1)]}" style="${D.FIELD};width:50%"></span></label>`).join('')}</div>
      <div class="cs-two"><select data-sh="${i}" data-f="transition" style="${F()}"><option value="cut" ${s.transition === 'cut' ? 'selected' : ''}>Cut</option><option value="fade" ${s.transition === 'fade' ? 'selected' : ''}>Fade from black</option></select><select data-sh="${i}" data-f="frame" style="${F()}"><option value="">Frame an actor…</option>${d.actors.map(a => `<option value="${a.id}">${esc(a.label)}</option>`).join('')}</select></div></div>`).join('')}
    <div class="cs-chips"><button class="btn btn-line btn-sm" id="scShotSplit">${d.shots.length ? 'Split shot at playhead' : 'Add camera (split at playhead)'}</button>${d.shots.length ? '<button class="btn btn-ghost btn-sm" id="scShotClear">Remove camera</button>' : ''}</div>`;
  for (const el of body.querySelectorAll('[data-sh]')) el.onchange = () => {
    const s = d.shots[Number(el.dataset.sh)], f = el.dataset.f;
    if (f === 'transition') s.transition = el.value;
    else if (f === 'frame') { const a = d.actors.find(x => x.id === el.value); if (!a) return; const st = frameState(d, (s.start + s.end) / 2).actors.find(x => x.actor.id === a.id); s.zoom = s.toZoom = 1.8; s.x = s.toX = Math.round(st.x); s.y = s.toY = Math.round((a.y || 1000) - 190 * (a.scale || 1)); }
    else s[f] = Number(el.value);
    touch(); refresh(root);
  };
  body.querySelector('#scShotSplit').onclick = () => {
    const t = Math.round(S.t * 100) / 100;
    if (!d.shots.length) { if (t < 0.3 || t > d.duration - 0.3) { d.shots = [{ start: 0, end: d.duration, zoom: 1, x: 960, y: 540, toZoom: 1.2, toX: 960, toY: 540, easing: 'easeInOut', transition: 'cut', transitionDuration: 0.4 }]; } else d.shots = [{ start: 0, end: t, zoom: 1, x: 960, y: 540, toZoom: 1, toX: 960, toY: 540, easing: 'easeInOut', transition: 'fade', transitionDuration: 0.4 }, { start: t, end: d.duration, zoom: 1.4, x: 960, y: 600, toZoom: 1.4, toX: 960, toY: 600, easing: 'easeInOut', transition: 'cut', transitionDuration: 0.4 }]; }
    else { const i = d.shots.findIndex(s => t > s.start + 0.2 && t < s.end - 0.2); if (i < 0) return say('Move the playhead inside a shot to split it.'); const s = d.shots[i]; d.shots.splice(i + 1, 0, { ...s, start: t, transition: 'cut' }); s.end = t; }
    touch(); refresh(root);
  };
  if (body.querySelector('#scShotClear')) body.querySelector('#scShotClear').onclick = () => { d.shots = []; touch(); refresh(root); };
}

async function backdropTab(body, root) {
  const d = S.draft, b = d.background;
  let images = []; try { images = (await D.apiGet('/api/media')).filter(m => m.kind === 'image').slice(0, 200); } catch (_) {}
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">The backdrop fills the 16:9 stage.</p>
    <label class="cs-check"><input type="radio" name="scBg" value="color" ${b.kind === 'color' ? 'checked' : ''}> Plain colour <input type="color" id="scBgCol" value="${b.color || '#1e2430'}"></label>
    ${(S.cat.backdrops || []).map(x => `<label class="cs-check" style="margin-top:6px"><input type="radio" name="scBg" value="asset:${x.id}" ${b.kind === 'asset' && b.asset === x.id ? 'checked' : ''}> ${esc(x.label)}</label>`).join('')}
    <label class="cs-field" style="margin-top:8px"><span>Picture from the Library</span><select id="scBgImg" style="${F()}"><option value="">Choose…</option>${images.map(m => `<option value="${esc(m.id)}" ${b.kind === 'media' && b.mediaId === m.id ? 'selected' : ''}>${esc(m.originalName)}</option>`).join('')}</select></label>`;
  for (const r of body.querySelectorAll('[name=scBg]')) r.onchange = () => { if (r.value === 'color') d.background = { kind: 'color', color: body.querySelector('#scBgCol').value }; else d.background = { kind: 'asset', asset: r.value.slice(6), color: '#1e2430' }; touch(); paint(); };
  body.querySelector('#scBgCol').oninput = e => { d.background = { kind: 'color', color: e.target.value }; touch(); paint(); };
  body.querySelector('#scBgImg').onchange = e => { if (!e.target.value) return; d.background = { kind: 'media', mediaId: e.target.value, color: '#1e2430' }; touch(); paint(); };
}

function scriptTab(body, root) {
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">Turn a script into scenes of up to 30 seconds. Write dialogue as <b>Name: line</b> (for example <b>Mira: रुको!</b>); other lines are kept as direction notes. SRT subtitles keep their timing. Speakers whose names match a character become that character; others speak off-screen.</p>
    <label class="cs-field"><span>Script file (TXT, MD, DOCX or SRT)</span><input type="file" id="scScriptFile" accept=".txt,.md,.docx,.srt,text/plain"></label>
    <label class="cs-field" style="margin-top:6px"><span>…or paste it</span><textarea id="scScriptText" rows="6" style="${F()}" placeholder="Mira: अरे, रुक जा भाई!&#10;Inchi: आई! आई! लग गई!"></textarea></label>
    <label class="cs-field" style="margin-top:6px"><span>Other names for characters (optional)</span><input id="scAliases" style="${F()}" placeholder="मीरा=Mira, इंची=Inchi"></label>
    <div class="cs-chips" style="margin-top:8px"><button class="btn btn-amber btn-sm" id="scImport">Import as scenes</button></div>
    <div class="empty-hint" id="scImportState" style="font-size:11.5px;margin-top:6px"></div>`;
  body.querySelector('#scImport').onclick = async e => {
    const st = body.querySelector('#scImportState'), f = body.querySelector('#scScriptFile').files[0], text = body.querySelector('#scScriptText').value;
    if (!f && !text.trim()) { st.textContent = 'Choose a file or paste a script.'; return; }
    const aliases = {}; for (const pair of body.querySelector('#scAliases').value.split(',')) { const [k, v] = pair.split('=').map(x => (x || '').trim()); const c = S.chars.find(x => x.name.toLowerCase() === (v || '').toLowerCase()); if (k && c) aliases[k] = c.id; }
    e.target.disabled = true; st.textContent = 'Importing…';
    try {
      const name = f ? f.name : 'Pasted script.txt';
      const r = await fetch(D.apiUrl('/api/scenes/import-script?name=' + encodeURIComponent(name) + '&aliases=' + encodeURIComponent(JSON.stringify(aliases))), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f || new Blob([text], { type: 'text/plain' }) });
      const dd = await r.json().catch(() => ({})); if (!r.ok) throw new Error(dd.error || 'HTTP ' + r.status);
      S.sel = dd.scenes[0].id; S.draft = null; S.dirty = false; S.t = 0; S.tab = 'cast';
      D.toast(`Imported ${dd.lines} line(s) as ${dd.scenes.length} scene(s).`);
      await renderScenes(root, D);
      say(`${dd.timing}${dd.unmatched.length ? ' Off-screen speakers (no matching character): ' + dd.unmatched.join(', ') + '.' : ''}${dd.overflow.length ? ' More than four speakers in a scene; not cast: ' + dd.overflow.join(', ') + '.' : ''}`);
    } catch (er) { st.textContent = er.message; e.target.disabled = false; }
  };
}

function checks(d) {
  const out = [];
  if (!d.actors.length) out.push(['warn', 'No actors.']);
  for (const a of d.actors) { const c = charOf(a); if (a.characterId && !c) out.push(['warn', `${a.label}: character is gone.`]); else if (!c) out.push(['info', `${a.label} is voice only (not drawn).`]); }
  const noActor = d.dialogue.filter(l => !l.actor).length; if (noActor) out.push(['info', `${noActor} line(s) are captions with no voice.`]);
  for (const a of d.actors) { const ls = d.dialogue.filter(l => l.actor === a.id); for (let i = 1; i < ls.length; i++) if (ls[i].start < ls[i - 1].end) out.push(['warn', `${a.label} has two lines at once (${fmt(ls[i].start)}).`]); }
  if (!d.dialogue.length) out.push(['info', 'No lines: the recording will be silent.']);
  if (!out.length) out.push(['ok', 'Ready to record.']);
  return out;
}
function renderTabBody(body, root) {
  const d = S.draft, p = d.profile, sz = outputSize(p);
  body.innerHTML = `<div class="cs-two"><label class="cs-field"><span>Size</span><select data-pf="height" style="${F()}"><option value="720" ${p.height === 720 ? 'selected' : ''}>720p</option><option value="1080" ${p.height === 1080 ? 'selected' : ''}>1080p</option></select></label>
      <label class="cs-field"><span>Frames a second</span><select data-pf="fps" style="${F()}"><option ${p.fps === 24 ? 'selected' : ''}>24</option><option ${p.fps === 30 ? 'selected' : ''}>30</option></select></label></div>
    <div class="cs-two"><label class="cs-field"><span>Shape</span><select data-pf="aspect" style="${F()}"><option value="16:9" ${p.aspect === '16:9' ? 'selected' : ''}>16:9 landscape</option><option value="9:16" ${p.aspect === '9:16' ? 'selected' : ''}>9:16 portrait (fitted)</option></select></label>
      <label class="cs-field"><span>Quality</span><select data-pf="quality" style="${F()}">${['draft', 'standard', 'high'].map(q => `<option value="${q}" ${p.quality === q ? 'selected' : ''}>${q[0].toUpperCase() + q.slice(1)}</option>`).join('')}</select></label></div>
    <label class="cs-check"><input type="checkbox" data-pf="captions" ${p.captions ? 'checked' : ''}> Captions in the video</label>
    <p class="empty-hint" style="font-size:11px">Output ${sz.w}×${sz.h}, H.264 MP4 with AAC sound. Portrait shows the whole 16:9 stage with bars above and below; captions sit in the lower bar.</p>
    <div class="cs-sub">Before recording</div>${checks(d).map(([k, t]) => `<div style="font-size:12px;color:${k === 'warn' ? 'var(--amber)' : k === 'ok' ? 'var(--green)' : 'var(--muted)'}">${k === 'warn' ? '⚠ ' : k === 'ok' ? '✓ ' : '• '}${esc(t)}</div>`).join('')}
    <div class="cs-chips" style="margin-top:10px"><button class="btn btn-amber btn-sm" id="scRec" ${S.recording ? 'disabled' : ''}>● Record to Library</button><a class="btn btn-line btn-sm" id="scSrt" href="${D.apiUrl('/api/scenes/' + encodeURIComponent(d.id) + '/srt?speakers=1')}" download>Download SRT</a></div>
    <div class="empty-hint" id="scRecState" role="status" style="font-size:11.5px;margin-top:6px"></div>`;
  for (const el of body.querySelectorAll('[data-pf]')) el.onchange = () => { const k = el.dataset.pf; p[k] = k === 'captions' ? el.checked : (k === 'height' || k === 'fps') ? Number(el.value) : el.value; touch(); renderTab(root); paint(); };
  body.querySelector('#scSrt').onclick = async ev => { if (S.dirty) { ev.preventDefault(); await save(true); location.href = ev.target.href; } };
  body.querySelector('#scRec').onclick = () => record(root).catch(e => { S.recording = false; stopAudio(); renderTab(root); const s = document.getElementById('scRecState'); if (s) s.textContent = 'Not saved: ' + e.message; D.toast(e.message); });
}

/* ------------------------------- recording ------------------------------- */
async function record(root) {
  const d = S.draft, st = t => { const e = document.getElementById('scRecState'); if (e) e.textContent = t; };
  if (S.dirty) await save(true);
  pause(); S.recording = true; renderTab(root);
  const sz = outputSize(d.profile), cv = document.createElement('canvas'); cv.width = sz.w; cv.height = sz.h;
  // Chrome only captures frames from a canvas that is in the page; keep it off-screen.
  cv.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none'; cv.setAttribute('aria-hidden', 'true'); document.body.appendChild(cv);
  try { return await recordOn(root, d, cv, sz, st); } finally { cv.remove(); }
}
async function recordOn(root, d, cv, sz, st) {
  if (!cv.captureStream || !window.MediaRecorder) throw new Error('This window cannot record video.');
  // wait for pictures
  st('Loading pictures…'); const pics = [bgImage(d), ...d.actors.flatMap(a => (charOf(a)?.cutouts || []).flatMap(p => p.frames.map(f => img(D.mediaUrl(f)))))].filter(Boolean);
  await Promise.all(pics.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
  const v = await loadVoices(d, st);
  const ctx = ac(); if (ctx.state === 'suspended') await ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  // keep the audio track flowing even when no line is speaking (an idle track stalls the recorder)
  const hush = ctx.createConstantSource(); hush.offset.value = 0; hush.connect(dest); hush.start();
  const stream = new MediaStream([...cv.captureStream(d.profile.fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const chunks = [], rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: sz.h >= 1080 ? 9e6 : 5e6 } : undefined);
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const env = envFor(d), g = cv.getContext('2d'), preview = document.getElementById('scCanvas');
  drawScene(g, d, 0, sz.w, sz.h, env);
  rec.start(250); const t0 = performance.now(); schedule(v.buffers, d, 0, dest);
  await new Promise(resolve => {
    const step = () => { const t = (performance.now() - t0) / 1000; drawScene(g, d, Math.min(t, d.duration), sz.w, sz.h, env); S.t = Math.min(t, d.duration); if (preview) { const pg = preview.getContext('2d'); drawScene(pg, d, S.t, preview.width, preview.height, envFor(d)); } st(`Recording ${fmt(Math.min(t, d.duration))} / ${fmt(d.duration)}${v.failed ? ` · ${v.failed} line(s) without voice` : ''}`); if (t < d.duration + 0.25) requestAnimationFrame(step); else resolve(); };
    requestAnimationFrame(step);
  });
  await new Promise(r => { rec.onstop = r; rec.stop(); }); stopAudio(); try { hush.stop(); hush.disconnect(); } catch (_) {}
  st('Saving to the Library…');
  const r = await fetch(D.apiUrl('/api/scenes/' + encodeURIComponent(d.id) + '/recording'), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob(chunks, { type: mime || 'video/webm' }) });
  const out = await r.json().catch(() => ({})); if (!r.ok) throw new Error(out.error || 'HTTP ' + r.status);
  S.recording = false; renderTab(root);
  const e = document.getElementById('scRecState'); if (e) e.textContent = `Saved to the Library: ${out.originalName}${v.failed ? ` (${v.failed} line(s) had no voice)` : ''}.`;
  D.toast('Scene saved to the Library.');
}

/* ------------------------------- drawn poses (characters) ------------------------------- */
/**
 * The "Drawn poses" tab for a character: import a character sheet (a grid of drawings), pick cells, name them
 * as poses (same name twice = frames of one moving pose), crop and trim transparent margins on this Mac.
 */
export async function cutoutsTab(body, deps, draft, onChange) {
  D = deps;
  const cut = draft.cutouts || (draft.cutouts = []);
  let images = []; try { images = (await D.apiGet('/api/media')).filter(m => m.kind === 'image').slice(0, 200); } catch (_) {}
  const G = cutoutsTab.g || (cutoutsTab.g = { mediaId: null, cols: 4, rows: 2, cells: {} });
  body.innerHTML = `<p class="empty-hint" style="padding:0 0 8px">Drawn poses are pictures of this character used in <b>Scenes</b> (for example run, tap, scared). Import them from a character sheet: one drawing per grid cell, a whole figure facing right, ideally on a transparent background.</p>
    ${cut.length ? `<div class="cs-sub">Poses</div><div class="sc-cuts">${cut.map(p => `<div class="sc-cut"><div class="sc-cut-img">${p.frames.map(f => `<img src="${D.mediaUrl(f)}" alt="">`).join('')}</div><div style="font-size:12px"><b>${esc(p.name)}</b> <span class="mono" style="font-size:10px;color:var(--muted)">${p.frames.length > 1 ? p.frames.length + ' frames' : ''}</span></div><button class="btn btn-ghost btn-sm" data-cutdel="${esc(p.id)}" aria-label="Remove pose">✕</button></div>`).join('')}</div>` : ''}
    <div class="cs-sub">Import a character sheet</div>
    <div class="cs-two"><label class="cs-field"><span>Sheet from the Library</span><select id="cuPick" style="${F()}"><option value="">Choose…</option>${images.map(m => `<option value="${esc(m.id)}" ${m.id === G.mediaId ? 'selected' : ''}>${esc(m.originalName)}</option>`).join('')}</select></label><label class="cs-field"><span>…or add one</span><input type="file" id="cuFile" accept="image/png,image/webp,image/jpeg" style="font-size:11.5px"></label></div>
    ${G.mediaId ? `<div class="cs-two"><label class="cs-field"><span>Columns</span><input type="number" min="1" max="12" id="cuCols" value="${G.cols}" style="${F()}"></label><label class="cs-field"><span>Rows</span><input type="number" min="1" max="12" id="cuRows" value="${G.rows}" style="${F()}"></label></div>
      <canvas id="cuGrid" width="560" height="300" style="width:100%;background:#0d1016;border-radius:8px;margin-top:6px;cursor:pointer" aria-label="The sheet, with numbered cells. Click a cell to choose it."></canvas>
      <p class="empty-hint" style="font-size:11px">Click cells to choose them, then name each one. Give two cells the same name (for example "run") to make a moving pose.</p>
      <div id="cuCells"></div>
      <div class="cs-chips" style="margin-top:6px"><button class="btn btn-amber btn-sm" id="cuGo" ${Object.keys(G.cells).length ? '' : 'disabled'}>Add ${Object.keys(G.cells).length} pose picture(s)</button></div>` : ''}
    <div class="empty-hint" id="cuState" style="font-size:11.5px;margin-top:6px"></div>`;
  for (const b of body.querySelectorAll('[data-cutdel]')) b.onclick = () => { draft.cutouts = cut.filter(p => p.id !== b.dataset.cutdel); onChange(true); };
  const pick = id => { G.mediaId = id || null; G.cells = {}; onChange(false); };
  body.querySelector('#cuPick').onchange = e => pick(e.target.value);
  body.querySelector('#cuFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await fetch(D.apiUrl('/api/media'), { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name) }, body: f }); const dd = await r.json().catch(() => ({})); if (!r.ok) throw new Error(dd.error || 'HTTP ' + r.status); pick(dd.id); } catch (er) { D.toast(er.message); } };
  if (!G.mediaId) return;
  const sheet = new Image(); sheet.crossOrigin = 'anonymous'; sheet.src = D.mediaUrl(G.mediaId);
  try { await sheet.decode(); } catch (_) { body.querySelector('#cuState').textContent = 'Could not read that picture.'; return; }
  const cv = body.querySelector('#cuGrid'), g = cv.getContext('2d');
  const k = Math.min(cv.width / sheet.naturalWidth, 1000 / sheet.naturalHeight); cv.height = Math.round(sheet.naturalHeight * k);
  const draw = () => {
    g.clearRect(0, 0, cv.width, cv.height); g.drawImage(sheet, 0, 0, cv.width, cv.height);
    const cw = cv.width / G.cols, ch = cv.height / G.rows; g.font = '600 13px system-ui';
    for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) { const n = r * G.cols + c + 1, on = G.cells[n] !== undefined; g.strokeStyle = on ? '#ffb000' : 'rgba(255,255,255,0.35)'; g.lineWidth = on ? 3 : 1; g.strokeRect(c * cw + 1, r * ch + 1, cw - 2, ch - 2); g.fillStyle = on ? '#ffb000' : 'rgba(0,0,0,0.6)'; g.fillRect(c * cw + 4, r * ch + 4, 26, 18); g.fillStyle = on ? '#000' : '#fff'; g.fillText(String(n), c * cw + 9, r * ch + 18); }
  };
  const cells = () => { const box = body.querySelector('#cuCells'); box.innerHTML = Object.keys(G.cells).sort((a, b) => a - b).map(n => `<div class="cs-row" style="gap:6px"><span class="mono" style="font-size:11px;width:28px">#${n}</span><input data-cell="${n}" value="${esc(G.cells[n])}" placeholder="pose name, e.g. run" style="${D.FIELD};flex:1"></div>`).join(''); for (const i of box.querySelectorAll('[data-cell]')) i.oninput = () => { G.cells[i.dataset.cell] = i.value; }; const go = body.querySelector('#cuGo'); go.disabled = !Object.keys(G.cells).length; go.textContent = `Add ${Object.keys(G.cells).length} pose picture(s)`; };
  draw(); cells();
  for (const [id, key] of [['#cuCols', 'cols'], ['#cuRows', 'rows']]) body.querySelector(id).onchange = e => { G[key] = Math.max(1, Math.min(12, Math.round(Number(e.target.value) || 1))); G.cells = {}; draw(); cells(); };
  cv.onclick = e => { const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * cv.width, y = (e.clientY - r.top) / r.height * cv.height; const n = Math.floor(y / (cv.height / G.rows)) * G.cols + Math.floor(x / (cv.width / G.cols)) + 1; if (G.cells[n] !== undefined) delete G.cells[n]; else G.cells[n] = ['run', 'run', 'tap', 'stop', 'run', 'run', 'flinch', 'scared'][Object.keys(G.cells).length] || 'pose ' + n; draw(); cells(); };
  body.querySelector('#cuGo').onclick = async ev => {
    const st = body.querySelector('#cuState'); ev.target.disabled = true;
    try {
      const W = sheet.naturalWidth / G.cols, H = sheet.naturalHeight / G.rows, added = [];
      for (const n of Object.keys(G.cells).map(Number).sort((a, b) => a - b)) {
        const name = String(G.cells[n] || '').trim().toLowerCase() || 'pose ' + n; st.textContent = `Cutting cell ${n}…`;
        const c = document.createElement('canvas'); c.width = Math.round(W); c.height = Math.round(H); const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(sheet, -Math.round(((n - 1) % G.cols) * W), -Math.round(Math.floor((n - 1) / G.cols) * H));
        const t = trim(x, c.width, c.height); const o = document.createElement('canvas'); o.width = t.w; o.height = t.h; o.getContext('2d').drawImage(c, -t.x, -t.y);
        const blob = await new Promise(r => o.toBlob(r, 'image/png'));
        const r = await fetch(D.apiUrl('/api/media'), { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-file-name': encodeURIComponent(`${draft.name} — ${name} (cell ${n}).png`) }, body: blob });
        const dd = await r.json().catch(() => ({})); if (!r.ok) throw new Error(dd.error || 'HTTP ' + r.status);
        added.push({ name, frames: [dd.id], fps: 8, facing: 1 });
      }
      for (const a of added) { const same = draft.cutouts.find(p => p.name === a.name); if (same) same.frames = [...same.frames, ...a.frames].slice(0, 8); else draft.cutouts.push(a); }
      G.cells = {}; st.textContent = `Added ${added.length} picture(s). Press Save to keep them.`; onChange(true);
    } catch (er) { st.textContent = er.message; ev.target.disabled = false; }
  };
}
/** The box around non-transparent pixels (or around pixels unlike the corner colour, for opaque sheets). */
function trim(x, w, h) {
  const d = x.getImageData(0, 0, w, h).data, opaque = d[3] > 200 && d[(w * h - 1) * 4 + 3] > 200, c0 = [d[0], d[1], d[2]];
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) for (let xx = 0; xx < w; xx += 2) { const i = (y * w + xx) * 4; const on = opaque ? Math.abs(d[i] - c0[0]) + Math.abs(d[i + 1] - c0[1]) + Math.abs(d[i + 2] - c0[2]) > 60 : d[i + 3] > 24; if (!on) continue; if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  const p = 4; x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p); x1 = Math.min(w - 1, x1 + p); y1 = Math.min(h - 1, y1 + p);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
export function stopScenes() { stop(); }
