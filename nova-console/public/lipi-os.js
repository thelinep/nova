/* ===========================================================================
 * Lipi OS — a language layer by Maataa
 *
 * Welcome in twelve scripts, a many-script converter, the script registry,
 * the learning library (courses, catalogues, reading desk), workshop plans,
 * the multi-script newsroom, the Ashokan text atlas and a sourced chronology.
 * Absorbed from the owner's Rakhigarhi / Lipi OS prototype; the data and its
 * caveats live in lib/heritage-data/lipi-os.json and are served by
 * lib/heritage.js. Everything people make here is saved in Maataa.
 * ========================================================================= */

export const FONTS = {
  Brah: ['brahmi', 'Noto Sans Brahmi'], 'Brah+': ['brahmi', 'Maataa Lipi Brahmi'], Khar: ['kharoshthi', 'Noto Sans Kharoshthi'], Bhks: ['bhaiksuki', 'Noto Sans Bhaiksuki'],
  Shrd: ['sharada', 'Noto Sans Sharada'], Sidd: ['siddham', 'Noto Sans Siddham'], Gran: ['grantha', 'Noto Sans Grantha'],
  Nand: ['nandinagari', 'Noto Sans Nandinagari'], Newa: ['newa', 'Noto Sans Newa'], Tirh: ['tirhuta', 'Noto Sans Tirhuta'],
  Takr: ['takri', 'Noto Sans Takri'], Modi: ['modi', 'Noto Sans Modi'], Kthi: ['kaithi', 'Noto Sans Kaithi'],
  Dogr: ['dogra', 'Noto Serif Dogra'], Sind: ['khudawadi', 'Noto Sans Khudawadi'], Diak: ['dives-akuru', 'Noto Serif Dives Akuru'], Kawi: ['kawi', 'Noto Sans Kawi'],
};
const FONT_FILE = { Dogr: 'noto-serif-dogra-dogra', Diak: 'noto-serif-dives-akuru-dives-akuru' };
// Maataa's own builds (tools/build-lipi-conjunct-fonts.py): Noto plus the stacked conjuncts its fonts lack.
const MAATAA_FONT = { 'Brah+': 'maataa-lipi-brahmi', Shrd: 'maataa-lipi-sharada', Diak: 'maataa-lipi-dives-akuru' };
let FONT_V = 0; // bumped after the conjunct editor rebuilds the fonts, so the browser loads the new files
const fontUrl = (c, slug) => MAATAA_FONT[c] ? `/fonts/lipi/${MAATAA_FONT[c]}.woff2${FONT_V ? '?v=' + FONT_V : ''}` : `/fonts/lipi/${FONT_FILE[c] || 'noto-sans-' + slug + '-' + slug}-400-normal.woff2`;
const fontFaces = () => Object.entries(FONTS).map(([c, [slug]]) => `@font-face{font-family:'Lipi ${c}';src:url('${fontUrl(c, slug)}') format('woff2');font-display:swap}`).join('\n');
export const fontStyle = code => FONTS[code] ? `font-family:'Lipi ${code}','${FONTS[code][1]}',var(--font-ui);` : '';
export const dirOf = code => (code === 'Khar' ? 'rtl' : 'ltr');
const INDIC = /[\u{0900}-\u{0dff}\u{11000}-\u{11fff}]/u;

const CSS = `
.lo-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:16px;align-items:start}
@media(max-width:1000px){.lo-hero{grid-template-columns:1fr}}
.lo-big{font-size:46px;line-height:1.1;margin:6px 0}
.lo-roman{color:var(--muted);font-size:15px;margin-bottom:10px}
.lo-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.lo-card{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px;cursor:pointer;text-align:left;color:var(--ink);min-width:0}
.lo-card[aria-pressed="true"]{border-color:var(--amber);box-shadow:0 0 0 1px var(--amber-line)}
.lo-card .n{font:11px var(--font-mono);color:var(--muted)}
.lo-card .r{font-size:22px;margin:6px 0;overflow-wrap:anywhere}
.lo-card .l{font-size:13px}
.lo-card .t{font:10px var(--font-mono);color:var(--muted);letter-spacing:.05em}
.lo-focus{font-size:34px;padding:14px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;margin:8px 0;overflow-wrap:anywhere}
.lo-note{font-size:12px;color:var(--muted);line-height:1.5}
.lo-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lo-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
@media(max-width:900px){.lo-grid2{grid-template-columns:1fr}}
.lo-res{display:grid;grid-template-columns:170px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line-soft)}
.lo-res .s{font-size:22px;overflow-wrap:anywhere}
.lo-res .m{font-size:11px;color:var(--amber)}
.bg-imgwrap{position:relative;width:100%}
.bg-imgwrap img{display:block;width:100%;height:auto;max-height:none!important;object-fit:fill!important;border-radius:8px}
.bg-ov{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.bg-ov polygon{vector-effect:non-scaling-stroke;fill:none}
.bg-ov .ak{stroke:#94a3b8;stroke-width:.75;stroke-opacity:.7}
.bg-ov .f{stroke:var(--c);stroke-width:2;fill:var(--c);fill-opacity:.14;pointer-events:all;cursor:pointer}
.bg-ov .f.poss{stroke-dasharray:4 3;fill-opacity:.06}
.bg-ov .f.hl{stroke-width:4;fill-opacity:.35}
.bg-layer i,.bg-fh i,.bg-rh i{display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--c);margin-right:5px}
.bg-fg{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:4px 0}
.bg-fh{font-size:12px;font-weight:600;min-width:120px}
.bg-find{background:none;border:1px dashed var(--line);border-radius:6px;padding:2px 7px;font-size:13px;color:var(--ink);cursor:pointer}
.bg-find.sure{border-style:solid}
.bg-find.on{border-color:var(--amber);background:var(--amber-soft)}
.bg-report{display:grid;gap:10px;margin-top:10px}
.bg-rcard{border:1px solid var(--line);border-left:3px solid var(--c);border-radius:8px;padding:10px 12px;min-width:0;overflow-x:auto}
.bg-rh{display:flex;gap:10px;align-items:center;margin-bottom:6px}
.bg-rt{border-collapse:collapse;width:100%;font-size:13px;min-width:620px}
.bg-rt th,.bg-rt td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}
.bg-rt th{color:var(--muted);font-weight:500}
.bg-rt td.w{font-size:15px;white-space:nowrap}
.bg-bars{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:3px 16px}
.bg-bar{display:grid;grid-template-columns:28px 1fr 44px;gap:6px;align-items:center;font-size:14px}
.bg-bar .bt{display:block;height:8px;background:var(--panel2);border-radius:4px;overflow:hidden}
.bg-bar .bv{display:block;height:100%;background:#94a3b8;border-radius:4px}
.bg-bar .bn{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.bg-ocr{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}
.bg-pill{font-size:11.5px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
.bg-pill.ok{border-color:var(--amber-line);color:var(--ink);background:var(--amber-soft)}
.bg-lines{margin:6px 0 4px 18px;padding:0;display:grid;gap:4px}
.bg-lines li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px}
.bg-lines li.dim{opacity:.45}
.bg-lines .b{font-size:22px;line-height:1.5;overflow-wrap:anywhere}
.bg-lines .d{grid-column:1;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.bg-lines .c{grid-column:2;grid-row:1;font-size:11.5px;color:var(--muted)}
.bg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:10px}
.bg-tile{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:0;cursor:pointer;color:var(--ink);text-align:left;overflow:hidden;display:flex;flex-direction:column}
.bg-tile[aria-pressed="true"]{border-color:var(--amber);box-shadow:0 0 0 1px var(--amber-line)}
.bg-tile img{width:100%;height:130px;object-fit:cover;background:#111;display:block}
.bg-tile .t{padding:7px 9px 8px;font-size:12.5px;line-height:1.35}
.bg-tile .d{color:var(--muted);font-size:11.5px}
.bg-detail{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:14px}
.bg-detail img{width:100%;height:auto;max-height:560px;object-fit:contain;background:#111;border-radius:8px}
.bg-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:13px}
.bg-dl dt{color:var(--muted)}
.bg-dl dd{margin:0}
@media (max-width:900px){.bg-detail{grid-template-columns:1fr}}
.lo-chip{background:none;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:3px 9px;font-size:12px;cursor:pointer}
.lo-chip[aria-pressed="true"]{background:var(--amber-soft);border-color:var(--amber-line);color:var(--ink)}
.lo-table{width:100%;border-collapse:collapse;font-size:12.5px}
.lo-table th,.lo-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line-soft);vertical-align:top}
.lo-table th{font:10.5px var(--font-mono);color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.lo-table tr.sel td{background:var(--amber-soft)}
.lo-tier{font:10px var(--font-mono);padding:2px 6px;border-radius:99px;border:1px solid var(--line);white-space:nowrap}
.lo-tier.FLAGSHIP{color:var(--amber);border-color:var(--amber-line)}
.lo-tier.PILOT{color:var(--blue)}
.lo-tier.EXHIBITION_ONLY{color:var(--rose)}
.lo-ok{color:var(--green);font-size:11px}
.lo-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.lo-item{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
.lo-item h4{margin:2px 0 6px;font-size:14px}
.lo-item .k{font:10.5px var(--font-mono);color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.lo-item a{color:var(--amber)}
.lo-cover{padding:14px;min-height:118px;display:flex;flex-direction:column;justify-content:space-between;color:#fff;background:linear-gradient(135deg,var(--c1),var(--c2))}
.lo-cover .k{color:#ffffffcc}
.lo-cover h4{font-size:16px;margin:4px 0}
details.lo-det summary{cursor:pointer;color:var(--amber);font-size:12.5px;margin-top:8px}
.lo-ed{display:grid;grid-template-columns:220px minmax(0,1fr);gap:12px}
@media(max-width:1000px){.lo-ed{grid-template-columns:1fr}}
.lo-lane{border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:8px;background:var(--panel2)}
.lo-lane textarea,.lo-lane input,.lo-lane select,.lo-form input,.lo-form select,.lo-form textarea{width:100%;box-sizing:border-box}
.lo-form{display:grid;gap:6px;align-content:start}
.lo-paper{border-radius:6px;padding:22px;color:#211d17;background:#f4ecdb;font-family:Georgia,serif;box-shadow:0 6px 30px #0006}
.lo-paper .mast{text-align:center;border-bottom:3px double var(--acc);padding-bottom:8px;margin-bottom:12px}
.lo-paper .mast h2{font-size:38px;margin:0;letter-spacing:.04em}
.lo-paper .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.lo-paper .col{border-top:2px solid var(--acc);padding-top:6px;min-width:0}
.lo-paper .col h3{font-size:20px;margin:4px 0;overflow-wrap:anywhere}
.lo-paper .col p{font-size:14px;line-height:1.5;overflow-wrap:anywhere}
.lo-paper .tag{font:10px var(--font-mono);color:#74634e;letter-spacing:.08em}
.lo-vec{perspective:1100px;display:flex;justify-content:center;padding:10px}
.lo-vec>div{transform-style:preserve-3d;transition:transform .2s}
.lo-map{background:var(--panel2);border:1px solid var(--line);border-radius:10px}
.lo-map text{fill:var(--muted);font:10px var(--font-mono)}
.lo-pin{cursor:pointer}
.lo-tl text{fill:var(--muted);font:10px var(--font-mono)}
.lt-wrap{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;align-items:start}
@media(max-width:1100px){.lt-wrap{grid-template-columns:1fr}}
.lt-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.lt-boards{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.lt-board h3{font:600 12px var(--font-sans);color:var(--muted);letter-spacing:.04em;margin:14px 0 6px}
.lt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:6px}
.lt-tile{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:6px 4px 5px;cursor:pointer;color:var(--ink);text-align:center;min-width:0;position:relative}
.lt-tile[aria-pressed="true"]{border-color:var(--amber);box-shadow:0 0 0 1px var(--amber-line)}
.lt-tile .g{font-size:28px;line-height:1.25;min-height:36px}
.lt-tile .g.off{opacity:.28}
.lt-tile .i{font:10.5px var(--font-mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lt-tile .snd{position:absolute;top:3px;right:5px;font-size:9px;color:var(--muted)}
.lt-side{position:sticky;top:12px;display:flex;flex-direction:column;gap:10px;min-width:0}
.lt-big{font-size:96px;line-height:1.15;text-align:center;padding:10px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;overflow-wrap:anywhere}
.lt-kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:5px 10px;font-size:12.5px}
.lt-kv dt{color:var(--muted)}
.lt-kv dd{margin:0}
.lt-tag{display:inline-block;font:10.5px var(--font-mono);border:1px solid var(--line);border-radius:99px;padding:1px 7px;margin:0 4px 4px 0}
.lt-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:5px}
.lt-strip button{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:4px 2px;color:var(--ink);cursor:pointer;min-width:0}
.lt-strip button[aria-pressed="true"]{border-color:var(--amber)}
.lt-strip .g{font-size:24px;line-height:1.3}
.lt-strip .c{font:9.5px var(--font-mono);color:var(--muted)}
.lt-tract text{font:11px var(--font-sans);fill:var(--muted)}
.lt-tract .on text{fill:var(--ink);font-weight:600}
`;

function ensureCss() {
  if (!document.getElementById('lipi-os-fonts')) { const f = document.createElement('style'); f.id = 'lipi-os-fonts'; f.textContent = fontFaces(); document.head.appendChild(f); }
  if (document.getElementById('lipi-os-css')) return;
  const s = document.createElement('style'); s.id = 'lipi-os-css'; s.textContent = CSS; document.head.appendChild(s);
}
function reloadFonts() { FONT_V = Date.now(); const f = document.getElementById('lipi-os-fonts'); if (f) f.textContent = fontFaces(); }

const S = {
  tab: 'welcome', os: null, focus: 'Brah', study: 'Hindi',
  conv: { text: 'आपका स्वागत है', hindi: true, halant: 'joined', sel: null, out: null },
  reg: { q: '', tier: '', data: null, focus: null, sample: null },
  learn: null, readings: null,
  news: null, editions: null, edId: null, view: 'multi', debugLane: 0, rotate: -14,
  chrono: { continent: '', category: '', from: -10000, to: 2026, data: null, sel: null },
  atlasSel: 0,
  let: { data: null, board: '', type: '', region: '', q: '', script: 'Deva', sel: 'क', autoplay: true },
  gal: { data: null, variant: '', q: '', open: '', sort: 'date', ocr: null, fresh: {}, own: null, busy: '', ocrMsg: '', view: 'grid', rep: null, repItem: {}, layers: null, hl: -1 },
  cj: { data: null, code: 'Brah', up: 'क', low: 'त', ov: null, dirty: false, status: '', busy: false, preview: '' },
};
try { const p = JSON.parse(localStorage.getItem('maataa.lipi') || '{}'); if (p.focus) S.focus = p.focus; if (p.study) S.study = p.study; } catch (_) { /* per-browser convenience only */ }
const remember = () => { try { localStorage.setItem('maataa.lipi', JSON.stringify({ focus: S.focus, study: S.study })); } catch (_) { /* ignore */ } };

const TABS = [['welcome', 'Welcome'], ['letters', 'Letters'], ['convert', 'Convert'], ['conjuncts', 'Conjunct editor'], ['gallery', 'Brahmi gallery'], ['scripts', 'Scripts'], ['learn', 'Learn'], ['workshops', 'Workshops'], ['newsroom', 'Newsroom'], ['atlas', 'Text atlas'], ['chronology', 'Chronology']];
const ALPHABET = 'अ आ इ ई उ ऊ ऋ ए ऐ ओ औ · क ख ग घ ङ च छ ज झ ञ ट ठ ड ढ ण त थ द ध न प फ ब भ म य र ल व श ष स ह · ० १ २ ३ ४ ५ ६ ७ ८ ९';

/** Renders Lipi OS into root. deps: { apiGet, apiPost, toast, escapeHtml, FIELD, web } */
export async function renderLipiOS(root, deps, tab) {
  ensureCss();
  if (tab) S.tab = tab;
  const h = deps.escapeHtml;
  try { if (!S.os) S.os = await deps.apiGet('/api/lipi/os'); } catch (e) { root.innerHTML = `<p class="empty-hint" style="color:var(--red)">Lipi OS could not load: ${h(e.message)}</p>`; return; }
  root.innerHTML = `<div class="view-head"><div><span class="eyebrow">Maataa operating layer · Lipi OS</span><h1 class="view-title">Lipi OS</h1>
    <p class="view-desc">A language layer by Maataa: read and write in twenty-five scripts, browse the script registry, plan study and workshops, and compose multi-script editions. A script is a writing system, not a language.</p></div></div>
    <div class="cs-tabs" role="tablist">${TABS.map(([id, l]) => `<button role="tab" class="cs-tab ${S.tab === id ? 'active' : ''}" aria-selected="${S.tab === id}" data-lo-tab="${id}">${l}</button>`).join('')}</div>
    <div id="loBody" data-no-list-tools></div>`;
  root.querySelectorAll('[data-lo-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.loTab; renderLipiOS(root, deps); });
  const body = root.querySelector('#loBody');
  const fn = { welcome, letters, conjuncts, gallery, convert, scripts, learn, workshops, newsroom, atlas, chronology }[S.tab] || welcome;
  try { await fn(body, deps, () => renderLipiOS(root, deps)); } catch (e) { body.innerHTML = `<p class="empty-hint" style="color:var(--red)">${h(e.message)}</p>`; }
}

// --- welcome ---------------------------------------------------------------------------------------
async function welcome(el, deps, rerender) {
  const h = deps.escapeHtml, w = S.os.welcome, ref = Object.fromEntries((S.os.welcomeReference || []).map(r => [r.id, r.rendering]));
  const cur = w.results.find(r => r.code === S.focus) || w.results[0];
  el.innerHTML = `<div class="lo-hero">
    <div class="panel" style="padding:16px">
      <div class="eyebrow">Maataa operating layer / Lipi OS</div>
      <div class="lo-big" lang="hi">${h(w.hindi)}</div>
      <div class="lo-roman">${h(w.roman)} · ${h(w.english)}</div>
      <p class="lo-note">A modern Hindi welcome, carried across twelve historic scripts. Choose a script to focus it; your choice stays on this computer.</p>
      <div class="lo-row" style="margin-top:10px">
        <label class="lo-note">Study language <select id="loStudy" style="${deps.FIELD}">${S.os.studyLanguages.map(l => `<option value="${h(l.id)}" ${l.id === S.study ? 'selected' : ''}>${h(l.name)} · ${h(l.native)}</option>`).join('')}</select></label>
      </div>
      <div class="lo-focus" dir="${dirOf(cur.code)}" style="${fontStyle(cur.code)}" aria-label="${h(cur.label)} rendering">${h(cur.text)}</div>
      <div class="lo-note">${h(cur.label)} · ${cur.direction === 'rtl' ? 'Right to left' : 'Left to right'} · study language ${h((S.os.studyLanguages.find(l => l.id === S.study) || {}).name || S.study)}${ref[cur.code] && ref[cur.code] !== cur.text ? ' · the prototype wrote <span style="' + fontStyle(cur.code) + '">' + h(ref[cur.code]) + '</span>; Maataa keeps Guru’s length mark for ai in Kharoshthi' : ''}</div>
      <p class="lo-note" style="margin-top:10px">${h(w.note)} Spelled as pronounced: <span lang="hi">${h(w.spelled)}</span>.</p>
      <div class="lo-row" style="margin-top:8px"><button class="btn btn-amber" data-go="convert">Convert your own text</button><button class="btn btn-line" data-go="scripts">Browse ${S.os.registry.total} script records</button><button class="btn btn-line" data-go="learn">Courses and reading desk</button><button class="btn btn-line" data-go="workshops">${S.os.counts.workshops + S.os.counts.futurism} workshop plans</button><button class="btn btn-line" data-go="newsroom">Open the newsroom</button></div>
    </div>
    <div><div class="cap-section-label">A welcome in twelve scripts · बारह लिपियों में स्वागत</div>
      <div class="lo-cards">${w.results.map((r, i) => `<button class="lo-card" aria-pressed="${r.code === cur.code}" data-code="${r.code}"><div class="n">${String(i + 1).padStart(2, '0')}</div><div class="r" dir="${dirOf(r.code)}" style="${fontStyle(r.code)}">${h(r.text)}</div><div class="l">${h(r.label)}</div><div class="t">${r.code.toUpperCase()} · DRAFT RENDERING${r.missing.length ? ' · ' + r.missing.length + ' KEPT' : ''}</div></button>`).join('')}</div>
      <p class="lo-note" style="margin-top:6px">If a card shows boxes, its font did not load; Maataa ships Noto fonts for these scripts.</p></div>
  </div>`;
  el.querySelectorAll('.lo-card').forEach(b => b.onclick = () => { S.focus = b.dataset.code; remember(); rerender(); });
  el.querySelector('#loStudy').onchange = e => { S.study = e.target.value; remember(); rerender(); };
  el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { S.tab = b.dataset.go; rerender(); });
}

// --- letters board ----------------------------------------------------------------------------------
const TRACT = [['कण्ठ', 'throat', 40], ['तालु', 'palate', 120], ['मूर्धा', 'roof', 200], ['दन्त', 'teeth', 270], ['ओष्ठ', 'lips', 330]];
function tractSvg(sthana) {
  const on = new Set();
  const s = sthana || '';
  if (s.includes('कण्ठ')) on.add('कण्ठ'); if (s.includes('तालु')) on.add('तालु'); if (s.includes('मूर्धा')) on.add('मूर्धा');
  if (s.includes('दन्त')) on.add('दन्त'); if (s.includes('ओष्ठ')) on.add('ओष्ठ');
  const nose = s.includes('नासिका');
  return `<svg class="lt-tract" viewBox="0 0 370 112" role="img" aria-label="Place of articulation: ${s || 'not applicable'}">
    <path d="M20 62 C 90 70, 200 30, 352 54" fill="none" stroke="var(--line)" stroke-width="2"/>
    <g class="${nose ? 'on' : ''}"><circle cx="230" cy="14" r="${nose ? 7 : 5}" fill="${nose ? 'var(--amber)' : 'var(--panel2)'}" stroke="var(--line)"/><text x="244" y="18">नासिका · nose</text></g>
    ${TRACT.map(([k, en, x]) => { const y = x < 200 ? 64 - (x - 20) * 0.1 : 46 + (x - 200) * 0.05; const a = on.has(k); return `<g class="${a ? 'on' : ''}"><circle cx="${x}" cy="${y}" r="${a ? 8 : 5}" fill="${a ? 'var(--amber)' : 'var(--panel2)'}" stroke="var(--line)"/><text x="${x}" y="${y + 22}" text-anchor="middle">${k}</text><text x="${x}" y="${y + 34}" text-anchor="middle" style="font-size:9.5px">${en}</text></g>`; }).join('')}
  </svg>`;
}
let letterAudio = null;
function playLetter(l, toast) {
  if (!l || !l.sound || !l.sound.file) return;
  try { if (letterAudio) letterAudio.pause(); letterAudio = new Audio(l.sound.file); const p = letterAudio.play(); if (p && p.catch) p.catch(() => toast && toast('The sound could not play here.')); } catch (_) { toast && toast('The sound could not play here.'); }
}
async function letters(el, deps, rerender) {
  const h = deps.escapeHtml, L = S.let;
  if (!L.data) L.data = await deps.apiGet('/api/lipi/letters');
  const d = L.data, meta = Object.fromEntries(d.scripts.map(s => [s.code, s]));
  const regions = [...new Set(d.scripts.map(s => s.region))];
  const inRegion = l => !L.region || l.scripts.writes.some(c => meta[c] && meta[c].region === L.region);
  const q = L.q.trim().toLowerCase();
  const shown = d.letters.filter(l => (!L.board || l.board === L.board) && (!L.type || l.type === L.type) && inRegion(l)
    && (!q || [l.char, l.sample, l.name, l.hi, l.iast, l.used, (l.grammar.pratyahara || []).join(' ')].join(' ').toLowerCase().includes(q)));
  const cur = d.letters.find(l => l.char === L.sel) || d.letters[0];
  const glyph = l => { const t = L.script === 'Deva' ? l.renders.Deva : l.renders[L.script]; return t ? { t, off: false } : { t: l.renders.Deva, off: true }; };
  const types = [...new Set(d.letters.map(l => l.type))];
  const g = cur.grammar || {};
  const bigText = L.script === 'Deva' ? cur.renders.Deva : cur.renders[L.script];
  el.innerHTML = `<div class="panel" style="padding:12px">
      <div class="lt-filters">
        <label class="lo-note">Preview script <select id="ltScript" style="${deps.FIELD}"><option value="Deva">Devanagari</option>${d.scripts.map(s => `<option value="${s.code}" ${s.code === L.script ? 'selected' : ''}>${h(s.label)}</option>`).join('')}</select></label>
        <label class="lo-note">Type <select id="ltType" style="${deps.FIELD}"><option value="">All types</option>${types.map(t => `<option ${t === L.type ? 'selected' : ''}>${h(t)}</option>`).join('')}</select></label>
        <label class="lo-note">Region <select id="ltRegion" style="${deps.FIELD}"><option value="">All regions</option>${regions.map(r => `<option ${r === L.region ? 'selected' : ''}>${h(r)}</option>`).join('')}</select></label>
        <input id="ltQ" type="search" placeholder="Find a letter, name or pratyahara" value="${h(L.q)}" style="${deps.FIELD};min-width:200px">
        <label class="lo-note"><input type="checkbox" id="ltAuto" ${L.autoplay ? 'checked' : ''}> Play when selected</label>
      </div>
      <div class="lt-boards"><button class="lo-chip" aria-pressed="${!L.board}" data-board="">All boards · ${d.counts.letters}</button>${d.boards.map(b => `<button class="lo-chip" aria-pressed="${L.board === b}" data-board="${h(b)}">${h(b)} · ${d.letters.filter(l => l.board === b).length}</button>`).join('')}</div>
    </div>
    <div class="lt-wrap" style="margin-top:10px">
      <div class="panel" style="padding:4px 12px 12px">
        ${shown.length ? d.boards.filter(b => shown.some(l => l.board === b)).map(b => `<div class="lt-board"><h3>${h(b)}</h3><div class="lt-grid">${shown.filter(l => l.board === b).map(l => { const gl = glyph(l); return `<button class="lt-tile" aria-pressed="${l.char === cur.char}" data-ch="${h(l.char)}" title="${h(l.name)}${gl.off ? ' · not written in this script' : ''}"><span class="snd">${l.sound.file ? '♪' : ''}</span><div class="g ${gl.off ? 'off' : ''}" style="${fontStyle(L.script)}">${h(gl.t)}</div><div class="i">${h(l.iast)}</div></button>`; }).join('')}</div></div>`).join('') : '<p class="empty-hint">No letter matches these filters.</p>'}
        <p class="lo-note" style="margin-top:10px">Faded tiles have no form in the preview script; Lipi OS keeps them in Devanagari when converting. Kharoshthi is left out here until its converter reports missing letters.</p>
      </div>
      <aside class="lt-side">
        <div class="panel" style="padding:12px">
          <div class="lt-big" style="${fontStyle(L.script)}" aria-label="${h(cur.name)}">${h(bigText || cur.renders.Deva)}</div>
          ${!bigText ? `<p class="lo-note" style="color:var(--rose)">${h(meta[L.script] ? meta[L.script].label : 'This script')} has no form for this letter; shown in Devanagari.</p>` : ''}
          <div class="lo-row" style="margin-top:8px;justify-content:space-between">
            <div><strong style="font-size:18px" lang="hi">${h(cur.hi)}</strong> <span class="lo-note">${h(cur.iast)} · ${h(cur.name)}</span></div>
            ${cur.sound.file ? `<button class="btn btn-amber" id="ltPlay">Play ♪</button>` : '<span class="lo-note">No sound</span>'}
          </div>
          ${cur.sound.ipa ? `<p class="lo-note">Sound /${h(cur.sound.ipa)}/${cur.sound.approx ? ' · approximate' : ''} · Hindi pronunciation</p>` : ''}
          ${cur.note ? `<p class="lo-note">${h(cur.note)}</p>` : ''}
        </div>
        <div class="panel" style="padding:12px">
          <div class="cap-section-label">Type and grammar · व्याकरण</div>
          <dl class="lt-kv">
            <dt>Board</dt><dd>${h(cur.board)}</dd><dt>Type</dt><dd>${h(cur.type)}</dd>
            ${g.sthana ? `<dt>Place (स्थान)</dt><dd>${h(g.sthana)} · ${h(g.sthanaEn || '')}</dd>` : ''}
            ${g.prayatna ? `<dt>Effort (प्रयत्न)</dt><dd>${h(g.prayatna)}</dd>` : ''}
            ${g.voicing ? `<dt>Voicing</dt><dd>${h(g.voicing)}</dd>` : ''}
            ${g.aspiration ? `<dt>Breath</dt><dd>${h(g.aspiration)}</dd>` : ''}
            ${g.nasal ? `<dt>Nasal</dt><dd>${h(g.nasal)}</dd>` : ''}
            ${g.length ? `<dt>Length</dt><dd>${h(g.length)}</dd>` : ''}
            ${(g.pratyahara || []).length ? `<dt>Pratyaharas</dt><dd>${g.pratyahara.map(p => `<span class="lt-tag">${h(p)}</span>`).join('')}</dd>` : ''}
            <dt>Unicode</dt><dd style="font-family:var(--font-mono);font-size:11.5px">${h(cur.codepoint)} · ${h(cur.unicodeName)}</dd>
          </dl>
          ${g.sthana ? tractSvg(g.sthana) : ''}
        </div>
        <div class="panel" style="padding:12px">
          <div class="cap-section-label">Region · written in ${cur.scripts.writes.length} of ${d.scripts.length} scripts</div>
          <p class="lo-note" style="margin:0 0 6px">Used in: ${h(cur.used)}</p>
          <div class="lt-strip">${cur.scripts.writes.map(c => `<button data-script="${c}" aria-pressed="${c === L.script}" title="${h((meta[c] || {}).label || c)} · ${h((meta[c] || {}).region || '')}"><div class="g" style="${fontStyle(c)}">${h(cur.renders[c] || '·')}</div><div class="c">${h(((meta[c] || {}).label || c).split(/[ /–-]/)[0])}</div></button>`).join('')}</div>
          ${cur.scripts.lacks.length ? `<p class="lo-note" style="margin-top:6px">No form in: ${cur.scripts.lacks.map(c => h((meta[c] || {}).label || c) + ' (' + h((meta[c] || {}).region || '') + ')').join(', ')}</p>` : ''}
        </div>
        <div class="panel" style="padding:12px">
          <div class="cap-section-label">Resources</div>
          <div style="display:flex;flex-direction:column;gap:4px;font-size:12.5px">${cur.resources.map(r => r.url ? `<a href="${h(r.url)}" target="_blank" rel="noopener" style="color:var(--amber)">${h(r.label)}</a>` : `<button class="lo-chip" data-sutra="${h(r.sutra)}" style="text-align:left">${h(r.label)} · open in Ashtadhyayi</button>`).join('')}
            <button class="lo-chip" id="ltConvert" style="text-align:left">Write ${h(cur.sample)} in every script (Convert)</button></div>
          <p class="lo-note" style="margin-top:8px">${h(d.sources.grammar)} ${h(d.sources.sound)}</p>
        </div>
      </aside>
    </div>`;
  const pick = ch => { L.sel = ch; const l = d.letters.find(x => x.char === ch); if (L.autoplay) playLetter(l, deps.toast); rerender(); };
  el.querySelectorAll('.lt-tile').forEach(b => b.onclick = () => pick(b.dataset.ch));
  el.querySelectorAll('[data-board]').forEach(b => b.onclick = () => { L.board = b.dataset.board; rerender(); });
  el.querySelectorAll('.lt-strip [data-script]').forEach(b => b.onclick = () => { L.script = b.dataset.script; rerender(); });
  el.querySelector('#ltScript').onchange = e => { L.script = e.target.value; rerender(); };
  el.querySelector('#ltType').onchange = e => { L.type = e.target.value; rerender(); };
  el.querySelector('#ltRegion').onchange = e => { L.region = e.target.value; rerender(); };
  el.querySelector('#ltAuto').onchange = e => { L.autoplay = e.target.checked; };
  const qi = el.querySelector('#ltQ'); qi.onchange = () => { L.q = qi.value; rerender(); };
  const play = el.querySelector('#ltPlay'); if (play) play.onclick = () => playLetter(cur, deps.toast);
  el.querySelectorAll('[data-sutra]').forEach(b => b.onclick = () => { if (typeof window.openSutra === 'function') window.openSutra(b.dataset.sutra); else deps.toast('Open the Ashtadhyayi view and look up ' + b.dataset.sutra + '.'); });
  el.querySelector('#ltConvert').onclick = () => { S.conv.text = cur.sample; S.conv.hindi = false; S.conv.out = null; S.tab = 'convert'; rerender(); };
}

// --- conjunct shape editor --------------------------------------------------------------------------
// Draws the upper letter and the reduced lower letter from the outlines the font tool exports, places
// the lower letter by the same edge rule as the font (no edge: middle, one edge: that edge, two or
// more: the right-most), and lets the reader drag or nudge it. Edits are saved per pair (and a size per
// lower letter); "Rebuild fonts" bakes them into the fonts in the data folder.
const CJ_SCRIPTS = [['Brah', 'Brahmi+', 'Brah+'], ['Shrd', 'Sharada', 'Shrd'], ['Diak', 'Dives Akuru', 'Diak']];
const SNAP = 30; // font units: how close a drag must come to an edge or the line to stick to it
function cjOv(code) { const L = S.cj; if (!L.ov[code]) L.ov[code] = { pairs: {}, scale: {} }; return L.ov[code]; }
const BG_COLORS = { akshar: '#94a3b8', sanyukta: '#84cc16', dhatu: '#ef6c3a', sangya: '#3b82f6', sarvanaam: '#a855f7', sankhya: '#f5b014', jyamiti: '#10b981', antariksh: '#06b6d4', anya: '#ec4899' };
const bgKey = f => f.cat + '|' + (f.head || f.deva) + '|' + (f.read || '');
function bgStrip(poly, t0, t1) {
  const [tl, tr, br, bl] = poly, at = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  return [at(tl, tr, t0), at(tl, tr, t1), at(bl, br, t1), at(bl, br, t0)];
}
/* The Brahmi report: every category over all gallery pictures, with where each word was found */
function bgReport(rep, d, h) {
  if (!rep) return '<p class="lo-note" style="margin-top:10px">The report is loading…</p>';
  const title = id => (d.items.find(i => i.id === id) || {}).title || id;
  const L = rep.labels, T = rep.topics || {};
  const imgs = e => e.images.slice(0, 6).map(x => `<button class="lo-chip" data-rgo="${x.id}">${h(title(x.id))}${x.n > 1 ? ' ×' + x.n : ''}</button>`).join('') + (e.images.length > 6 ? `<span class="lo-note">+${e.images.length - 6}</span>` : '');
  const table = (cat, rows, extra) => `<div class="bg-rcard" style="--c:${BG_COLORS[cat]}"><div class="bg-rh"><i></i><strong>${h(L[cat])}</strong><span class="lo-note">${rows.reduce((a, e) => a + e.sure, 0)} sure · ${rows.reduce((a, e) => a + e.possible, 0)} possible</span></div>
    ${rows.length ? `<table class="bg-rt"><thead><tr><th>शब्द</th><th>अर्थ</th>${extra ? '<th>' + extra + '</th>' : ''}<th>पक्का / संभावित</th><th>चित्र</th></tr></thead><tbody>${rows.map(e => `<tr><td class="w">${h(e.key)}</td><td>${h(e.hi)}<br><span class="lo-note">${h(e.en)}</span></td>${extra ? `<td>${cat === 'dhatu' && e.dhatu ? '√' + h(e.dhatu.deva) + (e.dhatu.code ? '<br><span class="lo-note">धातुपाठ ' + h(e.dhatu.code) + ' · ' + h(e.dhatu.artha || '') + '</span>' : '') : h(T[e.topic] || '')}</td>` : ''}<td>${e.sure} / ${e.possible}</td><td><div class="lo-row">${imgs(e)}</div></td></tr>`).join('')}</tbody></table>` : '<p class="lo-note">Nothing found.</p>'}</div>`;
  const C = rep.categories || {};
  const conjAll = (C.sanyukta || []).filter(e => e.valid), conj = conjAll.filter(e => e.sure > 0);
  const slips = (C.sanyukta || []).filter(e => !e.valid).reduce((a, e) => a + e.sure + e.possible, 0);
  const cons = Object.entries(rep.totals.consonants).slice(0, 18), max = cons.length ? cons[0][1] : 1;
  const legible = Object.values(rep.items).filter(i => i.legible).length;
  return `<div class="bg-report">
    <p class="lo-note">From the OCR readings of all ${Object.keys(rep.items).length} pictures (${legible} read clearly). <b>Sure</b> = exact spelling in a line read with at least ${Math.round(rep.sureConfidence * 100)}% confidence, in a script variant the model reads well. <b>Possible</b> = a lead to check. Words come from a list of Ashokan Prakrit vocabulary; verb forms are traced to their dhatu in Panini’s Dhatupatha.</p>
    ${(() => {
      const vs = {};
      for (const it of Object.values(rep.items)) {
        const v = vs[it.variant] || (vs[it.variant] = { n: 0, legible: 0, sure: 0, possible: 0 });
        v.n++; if (it.legible) v.legible++;
        for (const [c, k] of Object.entries(it.counts || {})) if (c !== 'akshar' && c !== 'sanyukta') { v.sure += k.sure; v.possible += k.possible; }
      }
      return `<div class="bg-rcard" style="--c:#64748b"><div class="bg-rh"><i></i><strong>लिपि के रूप · By script variant</strong></div><table class="bg-rt"><thead><tr><th>Variant</th><th>Pictures</th><th>Read clearly</th><th>Words: sure / possible</th></tr></thead><tbody>${Object.entries(d.variants).filter(([k]) => vs[k]).map(([k, l]) => `<tr><td>${h(l)}</td><td>${vs[k].n}</td><td>${vs[k].legible}</td><td>${vs[k].sure} / ${vs[k].possible}</td></tr>`).join('')}</tbody></table><p class="lo-note">Later styles were learned from synthetic letters only, so their words are never counted as sure.</p></div>`;
    })()}
    <div class="bg-rcard" style="--c:${BG_COLORS.akshar}"><div class="bg-rh"><i></i><strong>${h(L.akshar)}</strong><span class="lo-note">${rep.totals.letters} aksharas read in all</span></div>
      <div class="bg-bars">${cons.map(([k, v]) => `<div class="bg-bar"><span class="bk">${h(k)}</span><span class="bt"><span class="bv" style="width:${Math.max(4, Math.round(v / max * 100))}%"></span></span><span class="bn">${v}</span></div>`).join('')}</div>
      <p class="lo-note">Most frequent consonants across all readings (every line, so OCR noise is included).</p></div>
    <div class="bg-rcard" style="--c:${BG_COLORS.sanyukta}"><div class="bg-rh"><i></i><strong>${h(L.sanyukta)}</strong><span class="lo-note">${conj.length} kinds in clearly read lines · ${conjAll.length - conj.length} more only in doubtful lines · ${slips} halant marks that do not form a conjunct (OCR slips)</span></div>
      <div class="lo-row">${conj.slice(0, 40).map(e => `<button class="lo-chip" data-rgo="${e.images[0].id}" title="${e.sure} sure, ${e.possible} possible">${h(e.key)} · ${e.sure}</button>`).join('') || '<span class="lo-note">None.</span>'}</div>
      <p class="lo-note">Ashokan Brahmi seldom writes conjuncts, so many of these are OCR mistakes. Only the sure ones come from clearly read lines.</p></div>
    ${table('dhatu', C.dhatu || [], 'धातु')}
    ${table('sangya', C.sangya || [])}
    ${table('sarvanaam', C.sarvanaam || [])}
    ${table('sankhya', C.sankhya || [])}
    ${table('jyamiti', C.jyamiti || [])}
    ${table('antariksh', C.antariksh || [])}
    ${table('anya', C.anya || [], 'विषय')}
  </div>`;
}

/* Brahmi gallery: original inscriptions and manuscripts with credits (lib/lipi-brahmi-gallery.json) */
async function gallery(el, deps, rerender) {
  const h = deps.escapeHtml, G = S.gal;
  if (!G.data) G.data = await deps.apiGet('/api/lipi/brahmi-gallery');
  if (!G.ocr) G.ocr = await deps.apiGet('/api/lipi/ocr').catch(() => ({ readings: {}, python: false, model: {} }));
  const d = G.data, needle = G.q.trim().toLowerCase();
  let items = d.items.filter(i => (!G.variant || i.variant === G.variant)
    && (!needle || [i.title, i.site, i.region, i.country, i.language, i.note, i.credit.author].join(' ').toLowerCase().includes(needle)));
  if (G.sort === 'place') items = items.slice().sort((a, b) => (a.country + a.region + a.site).localeCompare(b.country + b.region + b.site));
  const cur = d.items.find(i => i.id === G.open);
  if (!G.layers) G.layers = new Set(['dhatu', 'sangya', 'sarvanaam', 'sankhya', 'jyamiti', 'antariksh', 'anya', 'sanyukta']);
  if (G.view === 'report' && !G.rep) { G.rep = await deps.apiGet('/api/lipi/brahmi-report').catch(() => null); }
  if (cur && !G.repItem[cur.id]) { G.repItem[cur.id] = 'loading'; deps.apiGet('/api/lipi/brahmi-report/' + cur.id).then(r => { G.repItem[cur.id] = r; rerender(); }).catch(() => { G.repItem[cur.id] = null; }); }
  // the analysis of what is on screen: a fresh reading or one's own image brings its own
  const repFor = id => G.fresh[id] && G.fresh[id].analysis ? { ...G.fresh[id].analysis, lines: G.fresh[id].lines, labels: (G.repItem[id] || {}).labels, topics: (G.repItem[id] || {}).topics } : (G.repItem[id] && G.repItem[id] !== 'loading' ? G.repItem[id] : null);
  const LAB = (G.rep && G.rep.labels) || (Object.values(G.repItem).find(x => x && x.labels) || {}).labels || { akshar: 'अक्षर', dhatu: 'धातु', sanyukta: 'संयुक्त अक्षर', sangya: 'संज्ञा', sarvanaam: 'सर्वनाम', sankhya: 'संख्या', jyamiti: 'ज्यामिति और माप', antariksh: 'अंतरिक्ष', anya: 'अन्य विषय' };
  const overlay = (rep, w, hgt) => {
    if (!rep) return '';
    let svg = '';
    if (G.layers.has('akshar')) for (const l of rep.lines || []) if (l.poly) for (const a of l.aksharas || []) svg += `<polygon class="ak" points="${bgStrip(l.poly, a[1], a[2]).map(p => p.join(',')).join(' ')}"/>`;
    rep.finds.forEach((f, i) => {
      if (!f.area || !G.layers.has(f.cat) || (f.cat === 'sanyukta' && !f.valid)) return;
      svg += `<polygon data-fi="${h(bgKey(f))}" class="f ${f.sure ? 'sure' : 'poss'} ${G.hl === bgKey(f) ? 'hl' : ''}" style="--c:${BG_COLORS[f.cat]}" points="${f.area.map(p => p.join(',')).join(' ')}"><title>${h(LAB[f.cat] + ': ' + (f.head || f.deva) + (f.hi ? ' — ' + f.hi : '') + (f.sure ? '' : ' (possible)'))}</title></polygon>`;
    });
    return `<svg class="bg-ov" viewBox="0 0 1 1" preserveAspectRatio="none">${svg}</svg>`;
  };
  const layerChips = rep => rep ? `<div class="lo-row" style="margin-top:6px">${['akshar', 'sanyukta', 'dhatu', 'sangya', 'sarvanaam', 'sankhya', 'jyamiti', 'antariksh', 'anya'].map(c => {
      const n = c === 'akshar' ? rep.letters.total : rep.finds.filter(f => f.cat === c && (c !== 'sanyukta' || f.valid)).length;
      return `<button class="lo-chip bg-layer" data-layer="${c}" aria-pressed="${G.layers.has(c)}" style="--c:${BG_COLORS[c]}"><i></i>${h(LAB[c])} · ${n}</button>`; }).join('')}</div>` : '<p class="lo-note">Detected areas are loading…</p>';
  const findsList = rep => {
    if (!rep) return '';
    const groups = ['dhatu', 'sangya', 'sarvanaam', 'sankhya', 'jyamiti', 'antariksh', 'anya', 'sanyukta'].map(c => {
      const m = new Map();
      for (const f of rep.finds) if (f.cat === c && (c !== 'sanyukta' || f.valid)) {
        const k = bgKey(f), g = m.get(k) || { f, n: 0, sure: false, k };
        g.n++; g.sure = g.sure || f.sure; m.set(k, g);
      }
      return [c, [...m.values()]];
    }).filter(([, l]) => l.length);
    const lt = rep.letters;
    return `<div class="bg-ocr"><div class="cap-section-label">इस चित्र में मिला · Found in this picture</div>
      <p class="lo-note">अक्षर ${lt.total} · स्वर ${Object.values(lt.vowels).reduce((a, b) => a + b, 0)} · सबसे अधिक व्यंजन ${Object.entries(lt.consonants).slice(0, 6).map(([k, v]) => h(k) + ' ' + v).join(', ')}${lt.anusvara ? ' · अनुस्वार ' + lt.anusvara : ''}</p>
      ${groups.length ? groups.map(([c, l]) => `<div class="bg-fg"><span class="bg-fh" style="--c:${BG_COLORS[c]}"><i></i>${h(LAB[c])}</span>${l.map(({ f, n, sure, k }) => `<button class="bg-find ${sure ? 'sure' : ''} ${G.hl === k ? 'on' : ''}" data-hl="${h(k)}" title="${sure ? 'Sure: exact spelling in a clearly read line' : 'Possible: check against a published reading'}">${h(f.read || f.deva)}${f.head && f.head !== f.read ? ` <span class="lo-note">→ ${h(f.head)}</span>` : ''}${f.hi ? ` <span class="lo-note">${h(f.hi)}</span>` : ''}${f.dhatu ? ` <span class="lo-note">√${h(f.dhatu.deva)}${f.dhatu.code ? ' (धातुपाठ ' + h(f.dhatu.code) + ', ' + h(f.dhatu.artha || '') + ')' : ''}</span>` : ''}${n > 1 ? ' <b>×' + n + '</b>' : ''}${sure ? '' : ' <span class="lo-note">?</span>'}</button>`).join('')}</div>`).join('') : '<p class="lo-note">No known words found in the lines read here.</p>'}
      <p class="lo-note">Solid outline: sure (exact spelling, line read with at least ${Math.round(((G.rep && G.rep.sureConfidence) || 0.8) * 100)}% confidence). Dashed: possible. Words are matched against a list of Ashokan Prakrit vocabulary; OCR mistakes can make false finds.</p></div>`;
  };
  const reading = (r, label) => {
    if (!r) return '<p class="lo-note">No machine reading yet.</p>';
    const pct = Math.round((r.confidence || 0) * 100);
    const ok = r.legible !== undefined ? r.legible : r.lines.some(l => l.conf >= (G.ocr.threshold || 0.8) && l.text.length >= 4);
    return `<div class="bg-ocr"><div class="lo-row" style="justify-content:space-between"><span class="cap-section-label">${h(label)}</span><span class="bg-pill ${ok ? 'ok' : ''}">${ok ? (r.verified === false ? 'Unverified reading' : 'Draft reading') : 'Not legible to the model'} · ${pct}%</span></div>
      ${r.lines.length ? `<ol class="bg-lines">${r.lines.map(l => `<li class="${l.legible === false || (l.legible === undefined && l.conf < (G.ocr.threshold || 0.8)) ? 'dim' : ''}"><span class="b" style="${fontStyle('Brah')}">${h(l.text)}</span><span class="d">${h(l.deva || '')}</span><span class="c">${Math.round(l.conf * 100)}%</span></li>`).join('')}</ol>` : '<p class="lo-note">The model found no lines it could read.</p>'}
      ${r.note ? `<p class="lo-note" style="color:var(--amber)">${h(r.note)}</p>` : ''}
      <p class="lo-note">Faded lines are below ${Math.round((G.ocr.threshold || 0.8) * 100)}% confidence. Machine reading by the Lipi OCR model, trained only on synthetic lines. Treat it as a guess to check against a published reading, not as a transcription.</p></div>`;
  };
  const credit = i => { const c = i.credit; const lic = c.licenceUrl ? `<a href="${h(c.licenceUrl)}" target="_blank" rel="noopener">${h(c.licence)}</a>` : h(c.licence); return `${h(c.author)} · ${lic} · via <a href="${h(c.source)}" target="_blank" rel="noopener">${h(c.via)}</a>`; };
  el.innerHTML = `
    <div class="panel" style="padding:12px">
      <div class="lo-row" style="justify-content:space-between">
        <div class="lo-row"><button class="lo-chip" aria-pressed="${!G.variant}" data-gv="">All · ${d.total}</button>${Object.entries(d.variants).map(([k, l]) => `<button class="lo-chip" aria-pressed="${G.variant === k}" data-gv="${k}">${h(l)} · ${d.counts[k]}</button>`).join('')}</div>
        <div class="lo-row"><input id="bgQ" placeholder="Search place, language, ruler…" value="${h(G.q)}" style="${deps.FIELD};width:220px">
          <select id="bgSort" style="${deps.FIELD}"><option value="date" ${G.sort === 'date' ? 'selected' : ''}>Oldest first</option><option value="place" ${G.sort === 'place' ? 'selected' : ''}>By place</option></select>
          <button class="lo-chip" data-gview="grid" aria-pressed="${G.view === 'grid'}">Pictures</button><button class="lo-chip" data-gview="report" aria-pressed="${G.view === 'report'}">Brahmi report</button></div>
      </div>
      ${G.view === 'report' ? bgReport(G.rep, d, h) : ''}
      ${cur ? `<div class="panel" style="padding:12px;margin-top:10px" id="bgDetail">
        <div class="bg-detail">
          <div><div class="bg-imgwrap" style="max-width:${Math.round(560 * (cur.thumbW || 4) / (cur.thumbH || 3))}px"><img src="${h(cur.image)}" alt="${h(cur.title)}">${overlay(repFor(cur.id))}</div>
            ${layerChips(repFor(cur.id))}
            <p class="lo-note" style="margin-top:6px">${credit(cur)}</p>
            ${findsList(repFor(cur.id))}</div>
          <div>
            <div class="lo-row" style="justify-content:space-between"><strong style="font-size:16px">${h(cur.title)}</strong><button class="btn btn-line" id="bgClose">Close</button></div>
            <p style="margin:8px 0">${h(cur.note)}</p>
            <dl class="bg-dl">
              <dt>Variant</dt><dd>${h(d.variants[cur.variant])}</dd>
              <dt>Date</dt><dd>${h(cur.dateLabel)}</dd>
              <dt>Place</dt><dd>${h(cur.site)}, ${h(cur.region)}${cur.country && cur.country !== '—' ? ', ' + h(cur.country) : ''}</dd>
              <dt>Language</dt><dd>${h(cur.language)}</dd>
              <dt>Object</dt><dd>${h(cur.kind)}</dd>
              <dt>Image</dt><dd>${h(cur.credit.author)}</dd>
              <dt>Licence</dt><dd>${cur.credit.licenceUrl ? `<a href="${h(cur.credit.licenceUrl)}" target="_blank" rel="noopener">${h(cur.credit.licence)}</a>` : h(cur.credit.licence)}</dd>
              <dt>Source</dt><dd><a href="${h(cur.credit.source)}" target="_blank" rel="noopener">${h(cur.credit.file)}</a></dd>
              ${cur.credit.commonsCredit ? `<dt>Credit line</dt><dd class="lo-note">${h(cur.credit.commonsCredit)}</dd>` : ''}
            </dl>
            ${reading(G.fresh[cur.id] || G.ocr.readings[cur.id], G.fresh[cur.id] ? 'Machine reading (just now)' : 'Machine reading')}
            <div class="lo-row"><button class="btn btn-line" id="bgReadAgain" ${G.busy ? 'disabled' : ''}>${G.busy === cur.id ? 'Reading…' : 'Read again'}</button>${G.ocrMsg ? `<span class="lo-note">${h(G.ocrMsg)}</span>` : ''}</div>
          </div>
        </div></div>` : ''}
      <div class="lo-row" style="margin-top:10px"><label class="btn btn-line" style="cursor:pointer">Read Brahmi in your own image<input type="file" id="bgOwn" accept="image/png,image/jpeg,image/webp" hidden></label>
        <span class="lo-note">${G.ocr.python ? 'Runs on this computer with the Lipi OCR model.' : 'Needs the OCR tools once: double-click “Lipi - Install OCR.command” in brahmini/launchers.'}${G.ocr.evaluation && G.ocr.evaluation.lumbini ? ' Tested on the Lumbini inscription: ' + Math.round((1 - G.ocr.evaluation.lumbini.CER) * 100) + '% of characters right.' : ''}</span>
        ${G.busy === 'own' ? '<span class="lo-note">Reading…</span>' : ''}</div>
      ${G.own ? `<div class="panel" style="padding:12px;margin-top:10px"><div class="bg-detail"><div><div class="bg-imgwrap"><img src="${G.own.url}" alt="Your image">${G.own.result && G.own.result.analysis ? overlay({ ...G.own.result.analysis, lines: G.own.result.lines }) : ''}</div>${G.own.result && G.own.result.analysis ? layerChips(G.own.result.analysis) + findsList(G.own.result.analysis) : ''}</div><div>${reading(G.own.result, 'Your image')}<button class="btn btn-line" id="bgOwnClose">Close</button></div></div></div>` : ''}
      <div class="bg-grid">${items.map(i => `<button class="bg-tile" data-gi="${i.id}" aria-pressed="${i.id === G.open}"><img loading="lazy" src="${h(i.image)}" alt=""><span class="t">${h(i.title)}<br><span class="d">${h(i.dateLabel)} · ${h(i.country === '—' ? i.site : i.country)}</span></span></button>`).join('') || '<p class="empty-hint">Nothing matches.</p>'}</div>
    </div>
    <div class="lo-grid2" style="margin-top:10px">
      <div class="panel" style="padding:12px"><div class="cap-section-label">Resources</div>
        <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.5">${d.resources.map(r => `<li>${r.url ? `<a href="${h(r.url)}" target="_blank" rel="noopener">${h(r.title)}</a>` : h(r.title)} <span class="lo-note">· ${h(r.kind)}. ${h(r.note)}</span></li>`).join('')}</ul></div>
      <div class="panel" style="padding:12px"><div class="cap-section-label">About these images</div><p class="lo-note" style="margin-top:6px">${h(d.notes)}</p><p class="lo-note">${h(d.source)}. Full credits: public/lipi-brahmi/CREDITS.md. Links open on the web; the images themselves are stored in Maataa and work offline.</p></div>
    </div>`;
  el.querySelectorAll('[data-gv]').forEach(b => b.onclick = () => { G.variant = b.dataset.gv; rerender(); });
  el.querySelectorAll('[data-gi]').forEach(b => b.onclick = () => { G.open = G.open === b.dataset.gi ? '' : b.dataset.gi; G.hl = -1; rerender(); setTimeout(() => { const x = el.querySelector('#bgDetail'); if (x) x.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 0); });
  const close = el.querySelector('#bgClose'); if (close) close.onclick = () => { G.open = ''; G.ocrMsg = ''; rerender(); };
  el.querySelectorAll('[data-gview]').forEach(b => b.onclick = () => { G.view = b.dataset.gview; rerender(); });
  el.querySelectorAll('[data-layer]').forEach(b => b.onclick = () => { const c = b.dataset.layer; if (G.layers.has(c)) G.layers.delete(c); else G.layers.add(c); rerender(); });
  el.querySelectorAll('[data-hl]').forEach(b => b.onclick = () => { const k = b.dataset.hl; G.hl = G.hl === k ? -1 : k; rerender(); });
  el.querySelectorAll('.bg-ov [data-fi]').forEach(p => p.addEventListener('click', () => { const k = p.dataset.fi; G.hl = G.hl === k ? -1 : k; rerender(); }));
  el.querySelectorAll('[data-rgo]').forEach(b => b.onclick = () => { G.open = b.dataset.rgo; G.view = 'grid'; G.hl = -1; rerender(); setTimeout(() => { const x = el.querySelector('#bgDetail'); if (x) x.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 0); });
  const again = el.querySelector('#bgReadAgain');
  if (again) again.onclick = async () => {
    G.busy = cur.id; G.ocrMsg = ''; rerender();
    try { G.fresh[cur.id] = await deps.apiPost('/api/lipi/ocr/read', { gallery: cur.id }); } catch (e) { G.ocrMsg = e.message; }
    G.busy = ''; rerender();
  };
  const own = el.querySelector('#bgOwn');
  own.onchange = () => {
    const f = own.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = async () => {
      G.own = { url: fr.result, result: null }; G.busy = 'own'; rerender();
      try { G.own.result = await deps.apiPost('/api/lipi/ocr/read', { image: fr.result }); } catch (e) { G.own.result = { lines: [], confidence: 0 }; deps.toast(e.message); }
      G.busy = ''; rerender();
    };
    fr.readAsDataURL(f);
  };
  const ownClose = el.querySelector('#bgOwnClose'); if (ownClose) ownClose.onclick = () => { G.own = null; rerender(); };
  const q = el.querySelector('#bgQ'); q.onchange = () => { G.q = q.value; rerender(); };
  el.querySelector('#bgSort').onchange = e => { G.sort = e.target.value; rerender(); };
}

async function conjuncts(el, deps, rerender) {
  const h = deps.escapeHtml, L = S.cj;
  if (!L.data) { L.data = await deps.apiGet('/api/lipi/conjuncts'); L.ov = JSON.parse(JSON.stringify(L.data.overrides || {})); }
  const sc = L.data.scripts[L.code];
  if (!sc) { el.innerHTML = '<p class="empty-hint">No glyph data for this script.</p>'; return; }
  const letters = Object.keys(sc.letters);
  if (!sc.letters[L.up]) L.up = letters[0];
  if (!sc.letters[L.low]) L.low = letters[0];
  const up = sc.letters[L.up], low = sc.letters[L.low], ov = cjOv(L.code);
  const key = L.up + '+' + L.low;
  const nudge = ov.pairs[key] || { dx: 0, dy: 0 };
  const size = ov.scale[L.low] != null ? ov.scale[L.low] : low.sub.scale;
  const [bx0, by0, bx1] = up.base.bounds;
  const targets = [{ x: (bx0 + bx1) / 2, label: 'middle' }, ...up.base.edges.map((x, i) => ({ x, label: 'edge ' + (i + 1) }))];
  const ax = up.base.attach[0], ay = up.base.attach[1];
  const fontCode = (CJ_SCRIPTS.find(s => s[0] === L.code) || [])[2];
  const edited = Object.entries(ov.pairs).filter(([, v]) => v.dx || v.dy);
  const resized = Object.entries(ov.scale);
  const rule = up.base.rule === 'middle' ? 'no edge, so the middle' : up.base.rule === 'edge' ? 'one edge, so that edge' : 'two or more edges, so the right-most';
  el.innerHTML = `<div class="lo-grid2" style="grid-template-columns:minmax(0,1.25fr) minmax(0,1fr)">
    <div class="panel" style="padding:12px">
      <div class="lo-row" style="justify-content:space-between">
        <div class="lo-row">${CJ_SCRIPTS.map(([c, l]) => `<button class="lo-chip" aria-pressed="${c === L.code}" data-cj-code="${c}">${l}</button>`).join('')}</div>
        <span class="lo-note">${h(L.up)} + ${h(L.low)} · ${h(L.up)}्${h(L.low)}</span>
      </div>
      <svg id="cjSvg" viewBox="-300 -1150 1600 2150" style="width:100%;height:auto;max-height:520px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;margin-top:8px;touch-action:none" role="img" aria-label="Conjunct ${h(L.up)} over ${h(L.low)}">
        <g stroke="var(--line)" stroke-width="2">
          <line x1="-300" x2="1300" y1="0" y2="0" stroke="var(--amber-line)" stroke-dasharray="12 10"/>
          <line x1="-300" x2="1300" y1="${-up.base.bounds[3]}" y2="${-up.base.bounds[3]}" stroke-dasharray="4 12"/>
          <line x1="0" x2="0" y1="-1150" y2="1000" stroke-dasharray="4 12"/><line x1="${up.base.adv}" x2="${up.base.adv}" y1="-1150" y2="1000" stroke-dasharray="4 12"/>
        </g>
        <g transform="scale(1,-1)"><path d="${up.base.d}" fill="var(--ink)"/></g>
        ${targets.map((t, i) => `<g data-target="${t.x}"><path d="M${t.x} ${-ay + 18} l-16 26 h32 z" fill="${Math.abs(t.x - (ax + nudge.dx)) < 1 ? 'var(--amber)' : 'var(--muted)'}"/><text x="${t.x}" y="${-ay + 80 + i * 38}" text-anchor="middle" font-size="34" fill="var(--muted)">${t.label}</text></g>`).join('')}
        <g id="cjSub" transform="translate(${ax + nudge.dx},${-(ay + nudge.dy)})" style="cursor:grab;pointer-events:bounding-box">
          <g transform="scale(${size / low.sub.scale},${-size / low.sub.scale})"><path d="${low.sub.d}" fill="var(--amber)"/></g>
          <circle r="22" fill="transparent" stroke="var(--amber)" stroke-width="4"/>
        </g>
      </svg>
      <div class="lo-row" style="margin-top:8px">
        <label class="lo-note">Across <input id="cjDx" type="number" step="5" value="${nudge.dx}" style="${deps.FIELD};width:80px"></label>
        <label class="lo-note">Up/down <input id="cjDy" type="number" step="5" value="${nudge.dy}" style="${deps.FIELD};width:80px"></label>
        <button class="btn btn-line" data-nudge="-10,0" title="Left">←</button><button class="btn btn-line" data-nudge="10,0" title="Right">→</button><button class="btn btn-line" data-nudge="0,10" title="Up">↑</button><button class="btn btn-line" data-nudge="0,-10" title="Down">↓</button>
        <button class="btn btn-line" id="cjAuto">Back to the rule</button>
      </div>
      <div class="lo-row" style="margin-top:6px"><span class="lo-note">Stick to</span>${targets.map(t => `<button class="lo-chip" data-snap="${t.x}" aria-pressed="${Math.abs(t.x - (ax + nudge.dx)) < 1 && !nudge.dy}">${t.label}</button>`).join('')}</div>
      <div class="lo-row" style="margin-top:6px"><label class="lo-note">Size of ${h(L.low)} below other letters <input id="cjSize" type="range" min="0.4" max="1" step="0.01" value="${size}"> <span id="cjSizeV">${Math.round(size * 100)}%</span></label><span class="lo-note">(applies to ${h(L.low)} under every letter)</span></div>
      <p class="lo-note" style="margin-top:6px">Drag the lower letter (amber) or nudge it; it sticks to an edge or the line when it comes within ${SNAP} units. The rule picked ${rule} of ${h(L.up)}. Arrow keys nudge by 10 when the drawing has focus (Shift: 50).</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
      <div class="panel" style="padding:12px">
        <div class="cap-section-label">Upper letter</div>
        <div class="lo-row">${letters.map(c => `<button class="lo-chip" aria-pressed="${c === L.up}" data-cj-up="${h(c)}">${h(c)}</button>`).join('')}</div>
        <div class="cap-section-label" style="margin-top:8px">Lower letter</div>
        <div class="lo-row">${letters.map(c => `<button class="lo-chip" aria-pressed="${c === L.low}" data-cj-low="${h(c)}">${h(c)}${ov.scale[c] != null ? ' ·' : ''}</button>`).join('')}</div>
      </div>
      <div class="panel" style="padding:12px">
        <div class="cap-section-label">In the font now</div>
        <div style="font-size:64px;line-height:1.9;${fontStyle(fontCode)}" id="cjFontPreview">${h(L.preview || '')}</div>
        <p class="lo-note">${L.data.fonts[L.code] && L.data.fonts[L.code].edited ? 'Using your rebuilt font (' + h(new Date(L.data.fonts[L.code].builtAt).toLocaleString()) + ').' : 'Using the font that ships with Maataa.'} Saved edits show here after a rebuild.</p>
      </div>
      <div class="panel" style="padding:12px">
        <div class="cap-section-label">Your edits · ${edited.length} pair${edited.length === 1 ? '' : 's'}, ${resized.length} size${resized.length === 1 ? '' : 's'}</div>
        <div class="lo-row">${edited.map(([k, v]) => `<button class="lo-chip" data-cj-go="${h(k)}" title="across ${v.dx}, up ${v.dy}">${h(k.replace('+', '्'))}</button>`).join('') || '<span class="lo-note">None yet.</span>'}</div>
        ${resized.length ? `<p class="lo-note">Sizes: ${resized.map(([c, v]) => h(c) + ' ' + Math.round(v * 100) + '%').join(', ')}</p>` : ''}
        <div class="lo-row" style="margin-top:8px">
          <button class="btn btn-amber" id="cjSave" ${L.dirty ? '' : 'disabled'}>Save edits</button>
          <button class="btn btn-line" id="cjBuild" ${L.busy ? 'disabled' : ''}>${L.busy ? 'Rebuilding…' : 'Rebuild fonts'}</button>
          <button class="btn btn-line" id="cjShipped">Use shipped fonts</button>
        </div>
        ${L.status ? `<p class="lo-note" style="margin-top:6px">${h(L.status)}</p>` : ''}
        ${L.data.python ? '' : '<p class="lo-note" style="color:var(--amber)">To rebuild, install the font tools once: double-click “Lipi - Install font tools.command” in brahmini/launchers.</p>'}
      </div>
    </div>
  </div>`;
  // the pair in the real font
  deps.apiPost('/api/lipi/convert', { text: L.up + '्' + L.low, scripts: [fontCode] }).then(r => { L.preview = r.results[0].text; const p = el.querySelector('#cjFontPreview'); if (p) p.textContent = L.preview; }).catch(() => {});
  const setNudge = (dx, dy, redraw = true) => {
    dx = Math.round(dx); dy = Math.round(dy);
    if (dx || dy) ov.pairs[key] = { dx, dy }; else delete ov.pairs[key];
    L.dirty = true;
    if (redraw) rerender();
  };
  const svg = el.querySelector('#cjSvg'), sub = el.querySelector('#cjSub');
  const toFont = e => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); return { x: p.x, y: -p.y }; };
  let drag = null;
  sub.addEventListener('pointerdown', e => { e.preventDefault(); sub.setPointerCapture(e.pointerId); const p = toFont(e); drag = { sx: p.x, sy: p.y, dx: nudge.dx, dy: nudge.dy }; sub.style.cursor = 'grabbing'; });
  sub.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = toFont(e);
    let dx = drag.dx + (p.x - drag.sx), dy = drag.dy + (p.y - drag.sy);
    const hit = targets.find(t => Math.abs(ax + dx - t.x) < SNAP);
    if (hit) dx = hit.x - ax;
    if (Math.abs(dy) < SNAP) dy = 0;
    drag.cur = { dx, dy };
    sub.setAttribute('transform', `translate(${ax + dx},${-(ay + dy)})`);
    el.querySelector('#cjDx').value = Math.round(dx); el.querySelector('#cjDy').value = Math.round(dy);
  });
  sub.addEventListener('pointerup', () => { if (drag && drag.cur) setNudge(drag.cur.dx, drag.cur.dy); drag = null; });
  svg.tabIndex = 0;
  svg.addEventListener('keydown', e => {
    const step = e.shiftKey ? 50 : 10, m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (m) { e.preventDefault(); setNudge(nudge.dx + m[0], nudge.dy + m[1]); }
  });
  el.querySelector('#cjDx').onchange = e => setNudge(Number(e.target.value) || 0, nudge.dy);
  el.querySelector('#cjDy').onchange = e => setNudge(nudge.dx, Number(e.target.value) || 0);
  el.querySelectorAll('[data-nudge]').forEach(b => b.onclick = () => { const [x, y] = b.dataset.nudge.split(',').map(Number); setNudge(nudge.dx + x, nudge.dy + y); });
  el.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => setNudge(Number(b.dataset.snap) - ax, 0));
  el.querySelector('#cjAuto').onclick = () => setNudge(0, 0);
  const sizeIn = el.querySelector('#cjSize');
  sizeIn.oninput = () => { el.querySelector('#cjSizeV').textContent = Math.round(sizeIn.value * 100) + '%'; const k = sizeIn.value / low.sub.scale; sub.firstElementChild.setAttribute('transform', `scale(${k},${-k})`); };
  sizeIn.onchange = () => { const v = Number(sizeIn.value); if (Math.abs(v - low.sub.scale) < 0.005) delete ov.scale[L.low]; else ov.scale[L.low] = v; L.dirty = true; rerender(); };
  el.querySelectorAll('[data-cj-code]').forEach(b => b.onclick = () => { L.code = b.dataset.cjCode; L.preview = ''; rerender(); });
  el.querySelectorAll('[data-cj-up]').forEach(b => b.onclick = () => { L.up = b.dataset.cjUp; L.preview = ''; rerender(); });
  el.querySelectorAll('[data-cj-low]').forEach(b => b.onclick = () => { L.low = b.dataset.cjLow; L.preview = ''; rerender(); });
  el.querySelectorAll('[data-cj-go]').forEach(b => b.onclick = () => { [L.up, L.low] = b.dataset.cjGo.split('+'); L.preview = ''; rerender(); });
  el.querySelector('#cjSave').onclick = async () => {
    try { const r = await deps.apiPost('/api/lipi/conjuncts', { scripts: L.ov }); L.ov = JSON.parse(JSON.stringify(r.overrides)); L.dirty = false; L.status = 'Saved. Rebuild the fonts to see the edits in Maataa.'; deps.toast('Conjunct edits saved'); } catch (e) { L.status = e.message; }
    rerender();
  };
  el.querySelector('#cjBuild').onclick = async () => {
    if (L.dirty) { try { const r = await deps.apiPost('/api/lipi/conjuncts', { scripts: L.ov }); L.ov = JSON.parse(JSON.stringify(r.overrides)); L.dirty = false; } catch (e) { L.status = e.message; rerender(); return; } }
    L.busy = true; L.status = 'Rebuilding the fonts. This takes a few seconds.'; rerender();
    try { await deps.apiPost('/api/lipi/conjuncts/rebuild', {}); L.data = await deps.apiGet('/api/lipi/conjuncts'); reloadFonts(); L.status = 'Rebuilt. Maataa now uses your edited fonts.'; deps.toast('Fonts rebuilt'); } catch (e) { L.status = e.message; }
    L.busy = false; L.preview = ''; rerender();
  };
  el.querySelector('#cjShipped').onclick = async () => {
    try { await deps.apiPost('/api/lipi/conjuncts/reset-fonts', {}); L.data = await deps.apiGet('/api/lipi/conjuncts'); reloadFonts(); L.status = 'Back to the shipped fonts. Your saved edits are kept; rebuild to use them again.'; } catch (e) { L.status = e.message; }
    L.preview = ''; rerender();
  };
}

// --- convert ---------------------------------------------------------------------------------------
async function convert(el, deps, rerender) {
  const h = deps.escapeHtml, all = S.os.scripts;
  if (!S.conv.sel) S.conv.sel = new Set(all.map(s => s.code));
  const run = async () => { try { S.conv.out = await deps.apiPost('/api/lipi/convert', { text: S.conv.text, hindi: S.conv.hindi, halant: S.conv.halant, scripts: [...S.conv.sel] }); } catch (e) { deps.toast(e.message); S.conv.out = null; } };
  if (!S.conv.out && S.conv.text.trim() && S.conv.sel.size) await run();
  const o = S.conv.out;
  el.innerHTML = `<div class="panel" style="padding:14px">
      <textarea id="loText" aria-label="Text to convert" style="${deps.FIELD};width:100%;min-height:80px;font-size:18px">${h(S.conv.text)}</textarea>
      <div class="lo-row" style="margin-top:8px"><button class="btn btn-amber" id="loGo">Convert</button>
        <label class="lo-note"><input type="checkbox" id="loHindi" ${S.conv.hindi ? 'checked' : ''}> Hindi: spell as pronounced (drops silent inherent vowels; a heuristic)</label>
        <label class="lo-note" title="A halant between two letters normally joins them into a conjunct. Show it instead to see each letter separately."><input type="checkbox" id="loHalant" ${S.conv.halant === 'visible' ? 'checked' : ''}> Show halant (्) instead of conjuncts</label>
        <button class="lo-chip" id="loAll">All scripts</button><button class="lo-chip" id="loNone">None</button></div>
      <div class="lo-row" style="margin-top:8px">${all.map(s => `<button class="lo-chip" aria-pressed="${S.conv.sel.has(s.code)}" data-code="${s.code}" title="${h(s.note || '')}">${h(s.label)}${s.coverage != null && s.coverage < 1 ? ' · ' + Math.round(s.coverage * 100) + '%' : ''}</button>`).join('')}</div>
      <p class="lo-note" style="margin-top:6px">Type Devanagari, any script listed here, or SLP1 in Latin letters. Letters a script has no form for stay in Devanagari and are flagged; nothing is guessed or translated.</p>
    </div>
    ${o ? `<div class="panel" style="margin-top:10px;padding:0">
      <div class="lo-res"><span class="lo-note">Read as Devanagari</span><span class="s" lang="hi">${h(o.devanagari)}</span><span></span></div>
      ${o.spelling === 'hindi-pronunciation' ? `<div class="lo-res"><span class="lo-note">Spelled as pronounced</span><span class="s" lang="hi">${h(o.spelled)}</span><span></span></div>` : ''}
      ${o.iast ? `<div class="lo-res"><span class="lo-note">IAST</span><span class="s" style="font-size:16px">${h(o.iast)}</span><button class="btn btn-line lo-copy" data-t="${h(o.iast)}">Copy</button></div>` : ''}
      ${o.results.map(r => `<div class="lo-res"><span><strong style="font-size:13px">${h(r.label)}</strong><br><span class="lo-note">${h(r.hi || '')}</span></span><span><span class="s" dir="${r.direction}" style="${fontStyle(r.code)}">${h(r.text)}</span>${r.missing.length ? `<br><span class="m">Kept in Devanagari (no form in ${h(r.label)}): ${h(r.missing.join(' '))}</span>` : ''}${S.conv.halant !== 'visible' && r.halantStyle && r.halantStyle !== 'stacked' ? `<br><span class="lo-note">${r.halantStyle === 'partial' ? 'Some conjuncts join; others show the halant.' : 'Shown with a visible halant.'} ${h((all.find(x => x.code === r.code) || {}).halantNote || '')}</span>` : ''}</span><button class="btn btn-line lo-copy" data-t="${h(r.text)}">Copy</button></div>`).join('')}
    </div>` : ''}`;
  const readText = () => { S.conv.text = el.querySelector('#loText').value; };
  el.querySelector('#loGo').onclick = async () => { readText(); await run(); rerender(); };
  el.querySelector('#loHindi').onchange = async e => { S.conv.hindi = e.target.checked; readText(); await run(); rerender(); };
  el.querySelector('#loHalant').onchange = async e => { S.conv.halant = e.target.checked ? 'visible' : 'joined'; readText(); await run(); rerender(); };
  el.querySelector('#loAll').onclick = async () => { readText(); S.conv.sel = new Set(all.map(s => s.code)); await run(); rerender(); };
  el.querySelector('#loNone').onclick = () => { readText(); S.conv.sel = new Set(); S.conv.out = null; rerender(); };
  el.querySelectorAll('.lo-chip[data-code]').forEach(b => b.onclick = async () => { const c = b.dataset.code; S.conv.sel.has(c) ? S.conv.sel.delete(c) : S.conv.sel.add(c); readText(); if (S.conv.sel.size) await run(); else S.conv.out = null; rerender(); });
  el.querySelectorAll('.lo-copy').forEach(b => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.t).then(() => deps.toast('Copied.'), () => deps.toast('Copy was blocked; select the text instead.')); });
}

// --- scripts registry --------------------------------------------------------------------------------
async function scripts(el, deps, rerender) {
  const h = deps.escapeHtml;
  S.reg.data = await deps.apiGet(`/api/lipi/registry?q=${encodeURIComponent(S.reg.q)}&tier=${encodeURIComponent(S.reg.tier)}`);
  const d = S.reg.data, f = S.reg.focus && d.records.find(r => r.code === S.reg.focus);
  if (f && f.convertible && (!S.reg.sample || S.reg.sample.code !== f.code)) {
    try { const out = await deps.apiPost('/api/lipi/convert', { text: ALPHABET, scripts: [f.code] }); S.reg.sample = { ...out.results[0] }; } catch (_) { S.reg.sample = null; }
  }
  const meta = f ? S.os.scripts.find(s => s.code === f.code) : null;
  el.innerHTML = `<div class="lo-row" style="margin-bottom:8px"><input id="loQ" placeholder="Search script records" value="${h(S.reg.q)}" style="${deps.FIELD};min-width:240px">
      <select id="loTier" style="${deps.FIELD}"><option value="">All tiers</option>${d.tiers.map(t => `<option value="${t.id}" ${S.reg.tier === t.id ? 'selected' : ''}>${h(t.label)} (${t.count})</option>`).join('')}</select>
      <span class="lo-note">${d.shown} of ${d.total} records · Lipi can write ${d.convertible}</span></div>
    <div class="lo-grid2"><div class="panel" style="padding:0;overflow:auto;max-height:640px"><table class="lo-table"><thead><tr><th>Code</th><th>Script</th><th>Region</th><th>Tier</th><th>Lipi</th></tr></thead><tbody>
      ${d.records.map(r => `<tr class="${r.code === S.reg.focus ? 'sel' : ''}" data-code="${r.code}" style="cursor:pointer"><td class="mono">${r.code}</td><td>${h(r.name)}</td><td>${h(r.region)}</td><td><span class="lo-tier ${r.tier}">${h(r.tierLabel)}</span></td><td>${r.convertible ? '<span class="lo-ok">writes</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <div>${f ? `<div class="panel" style="padding:14px"><div class="eyebrow">${f.code} · ${h(f.tierLabel)}</div><h3 style="margin:4px 0">${h(f.name)}</h3><div class="lo-note">${h(f.region)}</div>
      ${f.exhibitionOnly ? `<p class="lo-note" style="color:var(--rose)">Exhibition only. The Indus / Harappan signs are undeciphered; Lipi makes no decipherment or transliteration claim for them.</p>` : ''}
      ${f.convertible && S.reg.sample ? `<div class="lo-focus" style="font-size:26px;${fontStyle(f.code)}" dir="${dirOf(f.code)}">${h(S.reg.sample.text)}</div>
        <div class="lo-note">${meta?.note ? h(meta.note) + ' ' : ''}${meta?.coverage != null ? 'Covers ' + Math.round(meta.coverage * 100) + '% of the letters Sanskrit and Hindi need.' : ''} ${meta?.missing?.length ? 'No form for: <span lang="hi">' + h(meta.missing.join(' ')) + '</span> (kept in Devanagari).' : ''}</div>
        <div class="lo-row" style="margin-top:8px"><button class="btn btn-line" id="loUse">Convert text into ${h(f.name)}</button></div>`
        : !f.exhibitionOnly ? `<p class="lo-note">Lipi cannot write ${h(f.name)} yet: it is a historical style without its own Unicode block, or its structure differs from Devanagari's. It stays a study record.</p>` : ''}
      </div>` : `<div class="panel" style="padding:14px"><p class="lo-note">Choose a record to see it written out.</p></div>`}
      <p class="lo-note" style="margin-top:8px">${h(d.boundary)} Registry reference: Unicode Technical Standard #24 (Script Property).</p></div></div>`;
  let t; el.querySelector('#loQ').oninput = e => { clearTimeout(t); t = setTimeout(() => { S.reg.q = e.target.value; rerender(); }, 250); };
  el.querySelector('#loTier').onchange = e => { S.reg.tier = e.target.value; rerender(); };
  el.querySelectorAll('tr[data-code]').forEach(r => r.onclick = () => { S.reg.focus = r.dataset.code; rerender(); });
  const use = el.querySelector('#loUse'); if (use) use.onclick = () => { S.conv.sel = new Set(['Deva', f.code]); S.conv.out = null; S.tab = 'convert'; rerender(); };
}

// --- learning library --------------------------------------------------------------------------------
async function learn(el, deps, rerender) {
  const h = deps.escapeHtml;
  if (!S.learn) S.learn = await deps.apiGet('/api/lipi/learning');
  S.readings = await deps.apiGet('/api/lipi/readings');
  const L = S.learn, lang = S.study;
  const courses = L.courses.filter(c => lang === 'Hindi' || c.language === lang);
  const names = S.os.scripts.map(s => s.label);
  el.innerHTML = `<div class="lo-row" style="margin-bottom:8px"><label class="lo-note">Study language <select id="loStudy2" style="${deps.FIELD}">${L.studyLanguages.map(l => `<option value="${h(l.id)}" ${l.id === lang ? 'selected' : ''}>${h(l.name)} · ${h(l.native)}</option>`).join('')}</select></label><span class="lo-note">Hindi shows every course.</span></div>
    <div class="cap-section-label">Language courses · external provider listings (${courses.length})</div>
    <div class="lo-list">${courses.map(c => `<div class="lo-item"><div class="k">${h(c.language)} · ${h(c.provider)}</div><h4>${h(c.title)}</h4><div class="lo-note">${h(c.format)}</div><p style="font-size:13px">${h(c.focus)}</p><div class="lo-note">${h(c.status)}</div><a href="${h(c.url)}" target="_blank" rel="noopener">${h(c.sourceLabel)} ↗</a></div>`).join('') || '<p class="lo-note">No listed course for this language yet.</p>'}</div>
    <p class="lo-note">${h(L.notes.courses)}</p>
    <div class="cap-section-label" style="margin-top:14px">Source catalogues</div>
    <div class="lo-list">${L.catalogs.map(c => `<div class="lo-item"><div class="k">${h(c.kind)}</div><h4>${h(c.name)}</h4><p style="font-size:13px">${h(c.description)}</p><a href="${h(c.url)}" target="_blank" rel="noopener">${h(c.sourceLabel)} ↗</a></div>`).join('')}</div>
    <p class="lo-note">These open external collections. Availability, editions, access and rights vary; Maataa has not imported or verified individual books.</p>
    <div class="cap-section-label" style="margin-top:14px">My reading desk · saved in Maataa (${S.readings.length})</div>
    <div class="lo-grid2"><form class="panel lo-form" id="loReadForm" style="padding:12px">
      <input name="title" required placeholder="Book or text title (required)" style="${deps.FIELD}">
      <input name="author" placeholder="Author, editor or translator" style="${deps.FIELD}">
      <div class="lo-row"><select name="language" style="${deps.FIELD};flex:1">${L.studyLanguages.map(l => `<option ${l.id === lang ? 'selected' : ''}>${h(l.name)}</option>`).join('')}</select>
      <select name="script" style="${deps.FIELD};flex:1"><option value="">Script or edition: not entered</option>${names.map(n => `<option>${h(n)}</option>`).join('')}</select></div>
      <input name="url" placeholder="Source link (optional, https://…)" style="${deps.FIELD}">
      <textarea name="notes" placeholder="Notes: edition, access, rights, what to check" style="${deps.FIELD};min-height:60px"></textarea>
      <button class="btn btn-amber" type="submit">Save reference</button>
      <p class="lo-note">References and rights are not verified by Maataa.</p></form>
      <div>${S.readings.map(r => `<div class="lo-item" style="margin-bottom:8px"><div class="k">${h(r.language || '')}${r.script ? ' · ' + h(r.script) : ''} · ${h(r.status)}</div><h4>${h(r.title)}</h4>${r.author ? `<div class="lo-note">${h(r.author)}</div>` : ''}${r.notes ? `<p style="font-size:12.5px;white-space:pre-wrap">${h(r.notes)}</p>` : ''}${r.url ? `<a href="${h(r.url)}" target="_blank" rel="noopener">Source ↗</a>` : ''}
        <div class="lo-row" style="margin-top:6px">${['to-read', 'reading', 'done'].map(s => `<button class="lo-chip" aria-pressed="${r.status === s}" data-read="${r.id}" data-status="${s}">${s.replace('-', ' ')}</button>`).join('')}<button class="lo-chip" data-del="${r.id}">Delete</button></div></div>`).join('') || '<p class="lo-note">No saved references yet. Add a title to start your reading desk.</p>'}</div></div>`;
  el.querySelector('#loStudy2').onchange = e => { S.study = e.target.value; remember(); rerender(); };
  el.querySelector('#loReadForm').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await deps.apiPost('/api/lipi/readings', f); deps.toast('Saved to your reading desk.'); rerender(); } catch (err) { deps.toast(err.message); } };
  el.querySelectorAll('[data-read]').forEach(b => b.onclick = async () => { const r = S.readings.find(x => x.id === b.dataset.read); await deps.apiPost('/api/lipi/readings/' + r.id, { ...r, status: b.dataset.status }, 'PUT'); rerender(); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await deps.apiPost('/api/lipi/readings/' + b.dataset.del, {}, 'DELETE'); deps.toast('Removed.'); rerender(); });
}

// --- workshops --------------------------------------------------------------------------------------
const COVERS = [['#8a4b1f', '#c98a3c'], ['#2f5d50', '#6aa38c'], ['#3b3f78', '#7d84c9'], ['#6b2f4a', '#b86a8c'], ['#4a5a23', '#93a650'], ['#244a6b', '#5f97c4'], ['#5c3b1e', '#a8743f'], ['#334d4d', '#6f9c9c'], ['#5a2e2e', '#a35d5d'], ['#2e4a2e', '#6c9a6c'], ['#40305c', '#8670b0']];
const hm = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const inr = n => '₹' + Number(n).toLocaleString('en-IN');
async function workshops(el, deps) {
  const h = deps.escapeHtml;
  if (!S.learn) S.learn = await deps.apiGet('/api/lipi/learning');
  const L = S.learn, b = L.futurism.priceBasis;
  el.innerHTML = `<div class="cap-section-label">Maataa · Lipi OS workshops · ${L.workshops.length} draft manuals</div>
    <div class="lo-list">${L.workshops.map((w, i) => `<div class="lo-item" style="padding:0;overflow:hidden"><div class="lo-cover" style="--c1:${COVERS[i % 11][0]};--c2:${COVERS[i % 11][1]}"><div class="k">MAATAA · LIPI OS · ${String(i + 1).padStart(2, '0')} / ${L.workshops.length}</div><div><h4>${h(w.title)}</h4><div style="font-size:12.5px">${h(w.subtitle)}</div></div></div>
      <div style="padding:12px"><div class="k">${h(w.track)} · ${hm(w.plannedMinutes)} · ${h(w.format)}</div><p style="font-size:12.5px">${h(w.objective)}</p><div class="lo-note">Audience: ${h(w.audience)} · Study language: ${h(S.study)}</div>
      <details class="lo-det"><summary>Timed itinerary · ${hm(w.plannedMinutes)} total</summary><table class="lo-table">${w.sessions.map((s, j) => `<tr><td class="mono">${String(j + 1).padStart(2, '0')}</td><td class="mono">+${hm(s.start)}</td><td><strong>${h(s.title)}</strong><br><span class="lo-note">${h(s.activity)}</span></td><td class="mono">${s.minutes} min</td></tr>`).join('')}</table><p class="lo-note">Scheduled time: ${hm(w.plannedMinutes)}. Breaks are not included.</p></details>
      ${w.qa ? `<details class="lo-det"><summary>QA checkpoints & completion evidence</summary><ul style="font-size:12.5px;padding-left:18px">${w.qa.checks.map(c => `<li>${h(c)}</li>`).join('')}</ul><p class="lo-note"><strong>Evidence to review:</strong> ${h(w.qa.evidence)}</p></details>` : ''}
      <p class="lo-note" style="margin-top:6px">Proposed outline. Price, instructor, venue, materials, enrollment and delivery are unconfirmed.</p></div></div>`).join('')}</div>
    <p class="lo-note">${h(L.notes.workshops)} No accredited or externally recognised certification is confirmed; a non-credit completion record is only a proposal.</p>
    <div class="cap-section-label" style="margin-top:16px">Maataa · Futurism workshop series · researching the future through evidence</div>
    <div class="lo-list">${L.futurism.workshops.map((w, i) => { const c = w.computed; return `<div class="lo-item" style="padding:0;overflow:hidden"><div class="lo-cover" style="--c1:${COVERS[(i + 4) % 11][0]};--c2:${COVERS[(i + 4) % 11][1]}"><div class="k">MAATAA · FUTURISM · ${String(i + 1).padStart(2, '0')} / 09</div><h4>${h(w.title)}</h4></div>
      <div style="padding:12px"><p style="font-size:12.5px">${h(w.focus)}</p><table class="lo-table"><tr><td>Duration</td><td>${w.days} ${w.days === 1 ? 'day' : 'days'} · ${w.hours} contact hours</td></tr><tr><td>Draft price</td><td>${inr(w.price)} per participant ${c.perParticipant === w.price ? '<span class="lo-ok">recomputed ✓</span>' : `<span style="color:var(--amber)">model gives ${inr(c.perParticipant)}</span>`}</td></tr></table>
      <details class="lo-det"><summary>Full index, staffing and price basis</summary><ol style="font-size:12.5px;padding-left:18px">${w.index.map(x => `<li>${h(x.replace(/^\d+ · /, ''))}</li>`).join('')}</ol>
        <div class="lo-note"><strong>Lead lecturer:</strong> ${h(w.lecturer)}; one lead for preparation and delivery.<br><strong>Researcher:</strong> ${h(w.researcher)}; source checking and one preparation day.</div>
        <table class="lo-table" style="margin-top:6px"><tr><td>Lecturer + researcher (${w.days} delivery + 1 prep day each)</td><td class="mono">${inr(c.people)}</td></tr><tr><td>Producer, AV assistant, venue × ${w.days} day(s)</td><td class="mono">${inr(c.production)}</td></tr><tr><td>Materials · ${b.cohort} people × ${w.days} day(s)</td><td class="mono">${inr(c.materials)}</td></tr><tr><td>Platform management ${Math.round(b.platformCharge * 100)}%</td><td class="mono">${inr(c.platform)}</td></tr><tr><td><strong>Total for a cohort of ${b.cohort}</strong></td><td class="mono"><strong>${inr(c.total)}</strong></td></tr></table>
        <p class="lo-note">Rounded up to the next ₹100 per participant. Excluded: ${h(b.excluded)}</p></details></div></div>`; }).join('')}</div>
    <p class="lo-note">${h(L.notes.futurism)} Historical or scientific claims need source review; the series does not imply that ancient methods are automatically equivalent or superior to modern engineering.</p>`;
}

// --- newsroom -----------------------------------------------------------------------------------------
async function newsroom(el, deps, rerender) {
  const h = deps.escapeHtml;
  if (!S.news) S.news = await deps.apiGet('/api/lipi/newsroom');
  S.editions = await deps.apiGet('/api/lipi/editions');
  const N = S.news;
  if (!S.editions.some(e => e.id === S.edId)) S.edId = S.editions[0]?.id || null;
  const ed = S.editions.find(e => e.id === S.edId);
  const theme = ed ? N.themes.find(t => t.id === ed.theme) || N.themes[0] : N.themes[0];
  const langOpts = cur => N.studyLanguages.map(l => `<option value="${h(l.id)}" ${l.id === cur ? 'selected' : ''}>${h(l.native)} · ${h(l.name)}</option>`).join('');
  const scriptOpts = cur => [...N.scripts, { code: 'Latn', label: 'Roman' }].map(s => `<option value="${s.code}" ${s.code === cur ? 'selected' : ''}>${h(s.label)}</option>`).join('');
  const views = [...N.views, { id: 'print', label: 'Print preview' }];
  el.innerHTML = `<div class="lo-ed"><div><button class="btn btn-amber" id="loNewEd" style="width:100%">New edition</button><div class="cap-section-label">Editions</div>
      ${S.editions.map(e => `<button class="lo-card" style="width:100%;margin-bottom:6px" aria-pressed="${e.id === S.edId}" data-ed="${e.id}"><div class="l">${h(e.masthead)}</div><div class="t">${e.lanes.length} LANES · ${h(new Date(e.updatedAt).toLocaleDateString())}</div></button>`).join('') || '<p class="lo-note">No editions yet.</p>'}
      <p class="lo-note">Workspace controls are in English; language content is yours. Nothing is translated, transliterated or published automatically.</p></div>
    <div style="min-width:0">${!ed ? `<div class="panel" style="padding:16px"><h3>Multi-script, multilingual newspaper</h3><p class="lo-note">Compose an edition: choose language lanes and script records independently, write each headline in its intended script, and inspect the text at each stage. ${N.languages.length} newsroom language profiles, ${N.scripts.length} writable scripts.</p></div>` : `
      <div class="panel lo-form" style="padding:12px">
        <div class="lo-row"><input id="loMast" value="${h(ed.masthead)}" style="${deps.FIELD};flex:2" aria-label="Masthead"><select id="loTheme" style="${deps.FIELD};flex:1" aria-label="Theme">${N.themes.map(t => `<option value="${t.id}" ${t.id === ed.theme ? 'selected' : ''}>${h(t.name)}</option>`).join('')}</select>
          <select id="loStory" style="${deps.FIELD};flex:2" aria-label="Sample story"><option value="">Sample story…</option>${N.stories.map(s => `<option value="${s.id}">${h(s.theme)} · ${h(s.title)}</option>`).join('')}</select></div>
        <input id="loSrcH" value="${h(ed.source.headline)}" placeholder="Source headline" style="${deps.FIELD}">
        <textarea id="loSrcB" placeholder="Source text" style="${deps.FIELD};min-height:50px">${h(ed.source.body)}</textarea>
        <div class="lo-row"><button class="btn btn-amber" id="loSave">Save edition</button><button class="btn btn-line" id="loAddLane">Add language lane</button><button class="btn btn-line" id="loDelEd">Delete edition</button></div>
      </div>
      <div class="cs-tabs" style="margin-top:10px">${views.map(v => `<button class="cs-tab ${S.view === v.id ? 'active' : ''}" data-view-id="${v.id}">${h(v.label)}</button>`).join('')}</div>
      <div id="loView"></div>`}
    </div></div>`;
  el.querySelector('#loNewEd').onclick = async () => { const e = await deps.apiPost('/api/lipi/editions', { masthead: 'Vaigyaaniq Times', lanes: [{ language: 'Hindi', script: 'Deva' }, { language: 'Sanskrit', script: 'Brah' }] }); S.edId = e.id; rerender(); };
  el.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => { S.edId = b.dataset.ed; rerender(); });
  if (!ed) return;
  const collect = () => {
    ed.masthead = el.querySelector('#loMast').value; ed.theme = el.querySelector('#loTheme').value;
    ed.source = { headline: el.querySelector('#loSrcH').value, body: el.querySelector('#loSrcB').value };
    el.querySelectorAll('[data-lane]').forEach(div => { const l = ed.lanes[+div.dataset.lane]; if (!l) return; l.language = div.querySelector('[name=language]').value; l.script = div.querySelector('[name=script]').value; l.headline = div.querySelector('[name=headline]').value; l.body = div.querySelector('[name=body]').value; });
  };
  const save = async (msg, fresh = true) => { if (fresh) collect(); Object.assign(ed, await deps.apiPost('/api/lipi/editions/' + ed.id, ed, 'PUT')); if (msg) deps.toast(msg); };
  el.querySelector('#loSave').onclick = async () => { await save('Edition saved.'); rerender(); };
  el.querySelector('#loAddLane').onclick = async () => { collect(); ed.lanes.push({ language: 'Pali', script: 'Brah', headline: '', body: '' }); await save(null, false); rerender(); };
  el.querySelector('#loDelEd').onclick = async () => { await deps.apiPost('/api/lipi/editions/' + ed.id, {}, 'DELETE'); S.edId = null; deps.toast('Edition deleted.'); rerender(); };
  el.querySelector('#loStory').onchange = e => { const s = N.stories.find(x => x.id === e.target.value); if (!s) return; el.querySelector('#loSrcH').value = s.title; el.querySelector('#loSrcB').value = s.body; };
  el.querySelectorAll('[data-view-id]').forEach(b => b.onclick = () => { if (S.view === 'multi') collect(); S.view = b.dataset.viewId; rerender(); });
  const v = el.querySelector('#loView');
  const laneBox = (l, i) => `<div class="lo-lane" data-lane="${i}"><div class="lo-row"><select name="language" style="${deps.FIELD};flex:1" aria-label="Language">${langOpts(l.language)}</select><select name="script" style="${deps.FIELD};flex:1" aria-label="Script">${scriptOpts(l.script)}</select>
      <button class="btn btn-line" data-tl="${i}" title="Write the source text in this script">Write from source</button><button class="lo-chip" data-rm="${i}">Remove</button></div>
      <input name="headline" value="${h(l.headline)}" placeholder="Edition headline in this script" dir="${dirOf(l.script)}" style="${deps.FIELD};margin-top:6px;font-size:17px;${fontStyle(l.script)}">
      <textarea name="body" placeholder="Edition text" dir="${dirOf(l.script)}" style="${deps.FIELD};margin-top:6px;min-height:50px;${fontStyle(l.script)}">${h(l.body)}</textarea>
      <div class="lo-note">${l.method === 'transliterated' ? 'Machine transliteration from the source; review before use.' : l.headline ? 'Typed by you.' : 'No text yet.'}</div></div>`;
  if (S.view === 'multi') {
    v.innerHTML = ed.lanes.map(laneBox).join('') || '<p class="lo-note">Add a language lane to start.</p>';
    v.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { collect(); ed.lanes.splice(+b.dataset.rm, 1); await save(null, false); rerender(); });
    v.querySelectorAll('[data-tl]').forEach(b => b.onclick = async () => {
      collect(); const l = ed.lanes[+b.dataset.tl];
      if (!INDIC.test(ed.source.headline + ed.source.body)) { deps.toast('The source is not in an Indic script, so there is nothing to transliterate. Type this lane yourself.'); return; }
      if (l.script === 'Latn') { deps.toast('Roman: use the Convert tab for IAST, then paste it here.'); return; }
      try {
        const one = async t => t.trim() ? (await deps.apiPost('/api/lipi/convert', { text: t, scripts: [l.script] })).results[0].text : '';
        Object.assign(l, { headline: await one(ed.source.headline), body: await one(ed.source.body), method: 'transliterated' });
        await save('Written from the source; check it before use.', false); rerender();
      } catch (e) { deps.toast(e.message); }
    });
  } else if (S.view === 'debug') {
    const lane = ed.lanes[S.debugLane] || ed.lanes[0];
    const text = lane ? lane.headline : ed.source.headline;
    let ins = null; try { ins = await deps.apiPost('/api/lipi/inspect', { text }); } catch (_) { ins = null; }
    v.innerHTML = `<div class="panel" style="padding:12px"><label class="lo-note">Inspect lane <select id="loDbgLane" style="${deps.FIELD}">${ed.lanes.map((l, i) => `<option value="${i}" ${i === S.debugLane ? 'selected' : ''}>${h(l.language)} · ${h(l.script)}</option>`).join('')}</select></label>
      <div class="lo-focus" style="font-size:22px;${fontStyle(lane?.script)}" dir="auto">${h(text || 'Empty headline')}</div>
      ${ins ? `<table class="lo-table"><tr><td>Code points</td><td>${ins.codePoints}</td></tr><tr><td>Grapheme clusters</td><td>${ins.graphemes}</td></tr><tr><td>NFC</td><td>${ins.nfc ? 'Already normalized' : 'Not NFC'}</td></tr><tr><td>Unicode blocks</td><td>${ins.scripts.map(s => h(s.name) + ' ×' + s.count).join(', ') || '—'}</td></tr></table>
      <div class="mono lo-note" style="margin-top:6px;overflow-wrap:anywhere">${[...(text || '')].slice(0, 80).map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')}</div><p class="lo-note">${h(ins.note)}</p>` : ''}</div>`;
    const s = v.querySelector('#loDbgLane'); if (s) s.onchange = e => { S.debugLane = +e.target.value; rerender(); };
  } else if (S.view === 'glue') {
    const split = t => String(t || '').split(/(?<=[.!?।॥])\s+/).map(x => x.trim()).filter(Boolean);
    const src = [ed.source.headline, ...split(ed.source.body)];
    v.innerHTML = `<p class="lo-note">Glue view pairs source segments with each lane's text. It is alignment only: it does not translate or transliterate.</p>${ed.lanes.map(l => { const tgt = [l.headline, ...split(l.body)]; const n = Math.max(src.length, tgt.length); return `<div class="panel" style="padding:10px;margin-bottom:8px"><div class="eyebrow">${h(l.language)} · ${h(l.script)} · ${src.length === tgt.length ? 'segments align' : `${src.length} source vs ${tgt.length} target segments`}</div><table class="lo-table">${Array.from({ length: n }, (_, i) => `<tr><td class="mono">${String(i + 1).padStart(2, '0')}</td><td>${h(src[i] || '—')}</td><td dir="${dirOf(l.script)}" style="${fontStyle(l.script)}">${h(tgt[i] || '—')}</td></tr>`).join('')}</table></div>`; }).join('')}`;
  } else if (S.view === 'vector') {
    const first = ed.lanes[0] || { headline: ed.source.headline, script: 'Deva' };
    v.innerHTML = `<p class="lo-note">A 3D page-layout preview made from vector shapes and browser text. It does not make glyph outlines or check font shaping.</p>
      <input type="range" id="loRot" min="-40" max="40" value="${S.rotate}" aria-label="Rotate" style="width:240px">
      <div class="lo-vec"><div style="transform:rotateX(6deg) rotateY(${S.rotate}deg) rotateZ(-2deg)"><svg viewBox="0 0 720 500" width="620" role="img" aria-label="Vector newspaper layout preview">
        <rect x="8" y="8" width="704" height="484" rx="4" fill="#f4ecdb"/><path d="M32 55H688M32 101H688" stroke="${theme.accent}" stroke-width="3"/>
        <text x="36" y="42" fill="#74634e" font-size="12" letter-spacing="4">LIPI OS · ${h(ed.masthead.toUpperCase())}</text>
        <text x="36" y="88" fill="#211d17" font-size="${(first.headline || '').length > 38 ? 20 : 30}" font-family="Georgia,serif" style="${fontStyle(first.script)}">${h((first.headline || 'Your headline will appear here').slice(0, 60))}</text>
        ${[0, 1, 2].map(c => `<rect x="${36 + c * 220}" y="125" width="200" height="120" fill="${theme.accent}" opacity=".18"/>${[0, 1, 2, 3, 4, 5, 6, 7].map(r => `<rect x="${36 + c * 220}" y="${262 + r * 24}" width="${200 - (r % 3) * 26}" height="8" fill="#211d17" opacity=".22"/>`).join('')}`).join('')}
      </svg></div></div>`;
    v.querySelector('#loRot').oninput = e => { S.rotate = +e.target.value; v.querySelector('.lo-vec>div').style.transform = `rotateX(6deg) rotateY(${S.rotate}deg) rotateZ(-2deg)`; };
  } else {
    v.innerHTML = `<div class="lo-paper" style="--acc:${theme.accent}"><div class="mast"><div class="tag">LIPI OS · EDITION · ${h(theme.name.toUpperCase())}</div><h2>${h(ed.masthead)}</h2><div class="tag">${h(new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }))} · MULTI-LANGUAGE · MULTI-SCRIPT</div></div>
      <div class="cols">${ed.lanes.map(l => `<div class="col"><div class="tag">${h(l.language.toUpperCase())} · ${h((N.scripts.find(s => s.code === l.script) || { label: 'Roman' }).label.toUpperCase())}</div><h3 dir="${dirOf(l.script)}" style="${fontStyle(l.script)}">${h(l.headline || '—')}</h3><p dir="${dirOf(l.script)}" style="${fontStyle(l.script)}">${h(l.body)}</p></div>`).join('')}</div>
      <p class="tag" style="margin-top:14px">Manually authored draft · review text and font coverage before use</p></div>`;
  }
}

// --- atlas --------------------------------------------------------------------------------------------
const INDIA = { lon0: 66, lon1: 98, lat0: 6, lat1: 37.5, w: 420, h: 440 };
export function project(lat, lon, box = INDIA) { return [((lon - box.lon0) / (box.lon1 - box.lon0)) * box.w, ((box.lat1 - lat) / (box.lat1 - box.lat0)) * box.h]; }
export function graticule(box = INDIA, step = 5) {
  let s = '';
  for (let lon = Math.ceil(box.lon0 / step) * step; lon <= box.lon1; lon += step) { const [x] = project(box.lat0, lon, box); s += `<line x1="${x}" y1="0" x2="${x}" y2="${box.h}" stroke="var(--line-soft)"/><text x="${x + 2}" y="${box.h - 4}">${lon}°E</text>`; }
  for (let lat = Math.ceil(box.lat0 / step) * step; lat <= box.lat1; lat += step) { const [, y] = project(lat, box.lon0, box); s += `<line x1="0" y1="${y}" x2="${box.w}" y2="${y}" stroke="var(--line-soft)"/><text x="2" y="${y - 2}">${lat}°N</text>`; }
  return s;
}
async function atlas(el, deps, rerender) {
  const h = deps.escapeHtml, sites = S.os.atlas, s = sites[S.atlasSel] || sites[0];
  const short = x => x.title.split('· ')[1] || x.title;
  el.innerHTML = `<div class="lo-grid2"><div><svg class="lo-map" viewBox="0 0 ${INDIA.w} ${INDIA.h}" width="100%" role="img" aria-label="Inscription site pointers">${graticule()}
      ${sites.map((x, i) => { const [px, py] = project(x.coordinates.latitude, x.coordinates.longitude); return `<g class="lo-pin" data-i="${i}"><circle cx="${px}" cy="${py}" r="${i === S.atlasSel ? 8 : 6}" fill="${i === S.atlasSel ? 'var(--amber)' : 'var(--blue)'}" stroke="var(--panel)" stroke-width="2"/><text x="${px + 10}" y="${py + 4}" style="fill:var(--ink)">${h(short(x))}</text></g>`; }).join('')}</svg>
      <p class="lo-note">Points show inscription sites, not historical borders or the spread of a text. Coordinates come from the cited site list; no transcription or translation is given. Drawn offline; no map tiles are loaded.</p>
      <div class="lo-row">${sites.map((x, i) => `<button class="lo-chip" aria-pressed="${i === S.atlasSel}" data-i="${i}">◉ ${h(short(x))} · ${x.coordinates.latitude.toFixed(4)}°N ${x.coordinates.longitude.toFixed(4)}°E</button>`).join('')}</div></div>
    <div class="panel" style="padding:14px"><div class="eyebrow">${h(s.period)}</div><h3 style="margin:4px 0">${h(s.title)}</h3><div class="lo-note">${h(s.place)}</div>
      <table class="lo-table" style="margin-top:8px"><tr><td>Script · लिपि</td><td>${h(s.script)}</td></tr><tr><td>Language · भाषा</td><td>${h(s.language)}</td></tr><tr><td>Coordinates</td><td class="mono">${s.coordinates.latitude}, ${s.coordinates.longitude} · WGS84 · ${h(s.coordinates.precision)}</td></tr></table>
      <p class="lo-note">${h(s.recordNote)}</p>
      ${deps.web ? `<figure style="margin:8px 0"><img src="${h(s.imageUrl)}" alt="${h(s.imageAlt)}" style="max-width:100%;border-radius:8px" loading="lazy" onerror="this.closest('figure').remove()"><figcaption class="lo-note">${h(s.imageCredit)} · <a href="${h(s.imageSourceUrl)}" target="_blank" rel="noopener">${h(s.imageSourceLabel)} ↗</a></figcaption></figure>` : `<p class="lo-note">Photograph: ${h(s.imageCredit)} — <a href="${h(s.imageSourceUrl)}" target="_blank" rel="noopener">${h(s.imageSourceLabel)} ↗</a>. Turn on network access in Settings to show it here.</p>`}
      <div class="lo-row"><a class="btn btn-line" href="${h(s.siteSourceUrl)}" target="_blank" rel="noopener">${h(s.siteSourceLabel)} ↗</a><a class="btn btn-line" href="${h(s.contextSourceUrl)}" target="_blank" rel="noopener">${h(s.contextSourceLabel)} ↗</a></div></div></div>`;
  el.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { S.atlasSel = +b.dataset.i; rerender(); });
}

// --- chronology -----------------------------------------------------------------------------------------
const TICKS = [-10000, -5000, -3000, -1000, 0, 500, 1000, 1500, 1800, 2000, 2026];
export function timeX(year, width) {
  const seg = width / (TICKS.length - 1), y = Math.max(TICKS[0], Math.min(TICKS[TICKS.length - 1], year));
  for (let i = 0; i < TICKS.length - 1; i++) if (y <= TICKS[i + 1]) return seg * (i + (y - TICKS[i]) / (TICKS[i + 1] - TICKS[i]));
  return width;
}
const CAT_COLOR = { languages: 'var(--blue)', scripts: 'var(--amber)', books: 'var(--violet)', cities: 'var(--cyan)', universities: 'var(--green)', markets: 'var(--rose)', trades: 'var(--rose)', inventions: 'var(--red)', people: 'var(--ink-dim)', places: 'var(--muted)' };
async function chronology(el, deps, rerender) {
  const h = deps.escapeHtml, c = S.chrono;
  c.data = await deps.apiGet(`/api/lipi/chronology?continent=${c.continent}&category=${c.category}&from=${c.from}&to=${c.to}`);
  const d = c.data, W = 880, H = 170, O = 52;
  const lanes = d.categories.map((k, i) => [k, 18 + i * 13]);
  const cap = k => k[0].toUpperCase() + k.slice(1);
  el.innerHTML = `<div class="lo-row" style="margin-bottom:8px"><select id="loCont" style="${deps.FIELD}" aria-label="Continent"><option value="">All continents (${d.total})</option>${d.continents.map(x => `<option value="${x.id}" ${x.id === c.continent ? 'selected' : ''}>${h(x.name)} (${x.count})</option>`).join('')}</select>
      <select id="loCat" style="${deps.FIELD}" aria-label="Category"><option value="">All categories</option>${d.categories.map(k => `<option value="${k}" ${k === c.category ? 'selected' : ''}>${cap(k)}</option>`).join('')}</select>
      <label class="lo-note">From <input id="loFrom" type="number" value="${c.from}" min="-10000" max="2026" step="100" style="${deps.FIELD};width:90px"></label><label class="lo-note">to <input id="loTo" type="number" value="${c.to}" min="-10000" max="2026" step="100" style="${deps.FIELD};width:90px"></label>
      <span class="lo-note">${d.shown} matching records · negative years are BCE</span></div>
    <div class="panel" style="padding:8px;overflow-x:auto"><svg class="lo-tl" viewBox="0 0 ${W + O + 24} ${H + 30}" width="100%" style="min-width:700px" role="img" aria-label="Timeline of dated records">
      ${TICKS.map(t => `<line x1="${O + timeX(t, W)}" y1="10" x2="${O + timeX(t, W)}" y2="${H}" stroke="var(--line-soft)"/><text x="${O + timeX(t, W)}" y="${H + 14}" text-anchor="middle">${t === 0 ? '1 CE' : t < 0 ? (-t) + ' BCE' : t}</text>`).join('')}
      ${d.dated.map(e => { const cat = (e.entityTypes || [])[0] || 'places', y = (lanes.find(l => l[0] === cat) || lanes[9])[1], x0 = e.dateStartSort != null ? timeX(e.dateStartSort, W) : null, x1 = e.dateEndSort != null ? timeX(e.dateEndSort, W) : null, x = timeX(e.dateSort, W);
        return `<g class="lo-pin" data-ev="${e.id}">${x0 != null && x1 != null ? `<line x1="${O + x0}" y1="${y}" x2="${O + x1}" y2="${y}" stroke="${CAT_COLOR[cat]}" stroke-width="3" opacity=".4"/>` : ''}<circle cx="${O + x}" cy="${y}" r="${e.id === c.sel ? 6 : 4}" fill="${CAT_COLOR[cat]}"><title>${h(e.dateLabel)} · ${h(e.title)}</title></circle></g>`; }).join('')}
      ${lanes.map(([k, y]) => `<text x="2" y="${y + 3}" font-size="8">${cap(k)}</text>`).join('')}
    </svg><p class="lo-note">Horizontal positions use sortable years on a stretched scale; ranges show as bars and dates stay on each card. ${h(d.note)}</p></div>
    <div class="lo-list" style="margin-top:10px">${[...d.dated, ...d.undated].map(e => `<div class="lo-item" id="ev-${e.id}" style="${e.id === c.sel ? 'border-color:var(--amber)' : ''}"><div class="k">${h(e.dateLabel)}</div><h4>${h(e.title)}</h4><div class="lo-note">${h(e.region)}</div><p style="font-size:12.5px">${h(e.summary)}</p>
      <div class="lo-row">${(e.entityTypes || []).map(t => `<span class="lo-tier" style="color:${CAT_COLOR[t]}">${t.toUpperCase()}</span>`).join('')}</div>
      <table class="lo-table">${d.categories.filter(k => (e.entities?.[k] || []).length).map(k => `<tr><td>${cap(k)}</td><td>${h(e.entities[k].join(' · '))}</td></tr>`).join('')}</table>
      <p class="lo-note">${h(e.evidenceNote)}</p><a href="${h(e.sourceUrl)}" target="_blank" rel="noopener" style="color:var(--amber);font-size:12.5px">${h(e.sourceLabel)} ↗</a>${e.dateSort == null ? '<div class="lo-note" style="color:var(--rose)">Undated or unplaced · review before chronological claims</div>' : ''}</div>`).join('')}</div>`;
  el.querySelector('#loCont').onchange = e => { c.continent = e.target.value; rerender(); };
  el.querySelector('#loCat').onchange = e => { c.category = e.target.value; rerender(); };
  el.querySelector('#loFrom').onchange = e => { c.from = +e.target.value; rerender(); };
  el.querySelector('#loTo').onchange = e => { c.to = +e.target.value; rerender(); };
  el.querySelectorAll('[data-ev]').forEach(g => g.onclick = () => { c.sel = g.dataset.ev; rerender(); setTimeout(() => document.getElementById('ev-' + c.sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60); });
}

export const _test = { timeX, project };
