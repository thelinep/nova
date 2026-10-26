/* ===========================================================================
 * Rakhigarhi heritage platform, inside Maataa
 *
 * Source notes, site and India maps (drawn offline, points only), proposed
 * activities and packages, a seven-day program, the two-day field visit with
 * its call sheet and budgets, a provider registry with auto-matching, and a
 * synthetic 3D model viewer. Absorbed from the owner's concept prototype;
 * every caveat travels with the data (lib/heritage-data/rakhigarhi.json).
 * Nothing here books, sends or publishes anything.
 * ========================================================================= */
import { project, graticule } from './lipi-os.js';

const CSS = `
.hr-banner{background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:10px;padding:10px 12px;font-size:12.5px;margin-bottom:10px}
.hr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.hr-card{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
.hr-card h4{margin:4px 0 6px;font-size:14px}
.hr-k{font:10.5px var(--font-mono);color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.hr-note{font-size:12px;color:var(--muted);line-height:1.5}
.hr-demo{font:10px var(--font-mono);color:var(--rose);border:1px solid var(--rose);border-radius:99px;padding:1px 6px}
.hr-art{height:92px;border-radius:8px;margin:-2px 0 8px;display:flex;align-items:flex-end;padding:8px;color:#fff;font:10px var(--font-mono);background:linear-gradient(135deg,var(--c1),var(--c2))}
.hr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hr-table{width:100%;border-collapse:collapse;font-size:12.5px}
.hr-table th,.hr-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line-soft);vertical-align:top}
.hr-table th{font:10.5px var(--font-mono);color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.hr-table td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.hr-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
@media(max-width:1000px){.hr-two{grid-template-columns:1fr}}
.hr-map{background:var(--panel2);border:1px solid var(--line);border-radius:10px}
.hr-map text{fill:var(--muted);font:10px var(--font-mono)}
.hr-pin{cursor:pointer}
.hr-chip{background:none;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:3px 9px;font-size:12px;cursor:pointer}
.hr-chip[aria-pressed="true"]{background:var(--amber-soft);border-color:var(--amber-line);color:var(--ink)}
.hr-form{display:grid;gap:6px;align-content:start}
.hr-form input,.hr-form select,.hr-form textarea{width:100%;box-sizing:border-box}
details.hr-det summary{cursor:pointer;color:var(--amber);font-size:12.5px;margin-top:6px}
.hr-3d{width:100%;height:360px;border-radius:10px;background:radial-gradient(circle at 50% 40%,var(--panel3),var(--panel));cursor:grab;display:block}
`;
function ensureCss() { if (document.getElementById('heritage-css')) return; const s = document.createElement('style'); s.id = 'heritage-css'; s.textContent = CSS; document.head.appendChild(s); }

const S = { tab: 'home', data: null, family: '', period: '', q: '', siteSel: null, mound: 0, draftId: null, drafts: null, headcount: 5, usd: { days: 1, sel: new Set() }, budget: { adults: 1, mealsPerDay: 1200, vehiclePerDay: 8000, learningPerPerson: 4500, seatsPerVehicle: 6 }, model: 0, editProv: null };
const TABS = [['home', 'Home'], ['sources', 'Sources'], ['news', 'News'], ['site', 'The site'], ['india', 'India map'], ['research', 'Research'], ['activities', 'Activities'], ['itinerary', 'Itinerary'], ['packages', 'Packages'], ['providers', 'Providers'], ['gallery', '3D gallery']];
const ART = { 'Native / local': ['#7a4a22', '#c2884a'], 'Ancestral / Indus interpretation': ['#5b3a2a', '#a8735a'], 'Modern rural': ['#3d5a2a', '#86a85a'], Research: ['#2b4560', '#6a92b8'] };
const inr = n => (n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const usd = n => '$' + Number(n).toLocaleString('en-US');
const mins = m => (m == null ? 'Overnight' : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);

/** deps: { apiGet, apiPost, toast, escapeHtml, FIELD, web } */
export async function renderRakhigarhi(root, deps, tab) {
  ensureCss();
  if (tab) S.tab = tab;
  const h = deps.escapeHtml;
  try { if (!S.data) S.data = await deps.apiGet('/api/heritage/rakhigarhi'); } catch (e) { root.innerHTML = `<p class="empty-hint" style="color:var(--red)">The Rakhigarhi platform could not load: ${h(e.message)}</p>`; return; }
  root.innerHTML = `<div class="view-head"><div><span class="eyebrow">Heritage · digital heritage concept</span><h1 class="view-title">Rakhigarhi</h1>
    <p class="view-desc">Explore Rakhigarhi through evidence, place and perspective: source notes, maps, proposed activities, a visit planner with budgets, and a provider registry. Planning drafts stay in Maataa on this computer.</p></div></div>
    <div class="cs-tabs" role="tablist">${TABS.map(([id, l]) => `<button role="tab" class="cs-tab ${S.tab === id ? 'active' : ''}" aria-selected="${S.tab === id}" data-hr-tab="${id}">${l}</button>`).join('')}</div>
    <div id="hrBody" data-no-list-tools></div>`;
  root.querySelectorAll('[data-hr-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.hrTab; renderRakhigarhi(root, deps); });
  const body = root.querySelector('#hrBody'), rerender = () => renderRakhigarhi(root, deps);
  const fn = { home, sources, news, site, india, research, activities, itinerary, packages, providers, gallery }[S.tab] || home;
  try { await fn(body, deps, rerender); } catch (e) { body.innerHTML = `<p class="empty-hint" style="color:var(--red)">${h(e.message)}</p>`; }
}

const banner = (h, text) => `<div class="hr-banner">${h(text)}</div>`;

async function home(el, deps, rerender) {
  const h = deps.escapeHtml, d = S.data;
  el.innerHTML = `${banner(h, d.status)}
    <div class="cap-section-label">Four perspectives, one place</div>
    <div class="hr-grid">${d.activityFamilies.map(f => `<div class="hr-card"><div class="hr-art" style="--c1:${ART[f.name][0]};--c2:${ART[f.name][1]}">${h(f.name.toUpperCase())}</div><h4>${h(f.name)}</h4><p class="hr-note">${h(f.intro)}</p><button class="btn btn-line" data-family="${h(f.name)}">See proposed activities</button></div>`).join('')}</div>
    <div class="cap-section-label" style="margin-top:14px">Explore the concept</div>
    <div class="hr-grid">${d.homeCards.map(c => `<div class="hr-card"><div class="hr-k">${h(c.tag)}</div><h4>${h(c.title)}</h4><p class="hr-note">${h(c.text)}</p><button class="btn btn-line" data-go="${c.route === 'literature' ? 'sources' : c.route}">Open</button></div>`).join('')}</div>
    <p class="hr-note" style="margin-top:10px">Sample notices, synthetic 3D models, illustrative map markers and proposed activity formats are clearly marked. No grant, institutional affiliation, booking, price, excavation result or site permission is claimed. Set the language of your study in Lipi OS.</p>`;
  el.querySelectorAll('[data-family]').forEach(b => b.onclick = () => { S.family = b.dataset.family; S.tab = 'activities'; rerender(); });
  el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { S.tab = b.dataset.go; rerender(); });
}

async function sources(el, deps) {
  const h = deps.escapeHtml, L = S.data.literature;
  const ref = n => { const r = L.references.find(x => x.n === n); return r ? `<a href="${h(r.url)}" target="_blank" rel="noopener" style="color:var(--amber)">[${n}]</a>` : `[${n}]`; };
  el.innerHTML = `<div class="hr-two"><div class="panel" style="padding:16px"><div class="hr-k">Verified source notes</div><h2 style="margin:4px 0 8px">${h(L.title)}</h2><p class="hr-note">${h(L.intro)}</p>
      ${L.sections.map(s => `<h3 style="font-size:16px;margin:14px 0 4px">${h(s.heading)}</h3><p style="font-size:13.5px;line-height:1.6">${h(s.text)} ${s.refs.map(ref).join(' ')}</p>`).join('')}
      <h3 style="font-size:15px;margin:16px 0 6px">References</h3><ol style="font-size:12.5px;padding-left:18px">${L.references.map(r => `<li style="margin-bottom:6px">${h(r.text)} <a href="${h(r.url)}" target="_blank" rel="noopener" style="color:var(--amber)">${h(r.linkLabel)} ↗</a></li>`).join('')}</ol><p class="hr-note">${h(L.reviewed)}</p></div>
    <div><div class="cap-section-label">Research source notes</div>${S.data.blogs.map(b => `<div class="hr-card" style="margin-bottom:8px"><div class="hr-k">${h(b.category)} · ${h(b.date)}</div><h4>${h(b.title)}</h4><p class="hr-note">${h(b.excerpt)}</p><details class="hr-det"><summary>Read note</summary><p style="font-size:13px">${h(b.content)}</p></details></div>`).join('')}
      <p class="hr-note">Short source notes and editorial guidance. No authors or research programs are implied.</p></div></div>`;
}

async function news(el, deps) {
  const h = deps.escapeHtml;
  el.innerHTML = `<div class="hr-k" style="margin-bottom:6px">Demo press layout · all entries are placeholders, not official announcements</div><div class="hr-grid">${S.data.news.map(n => `<div class="hr-card"><span class="hr-demo">${h(n.category)}</span><div class="hr-k" style="margin-top:6px">${h(n.date)}</div><h4>${h(n.title)}</h4><p class="hr-note">${h(n.summary)}</p><div class="hr-note">By ${h(n.author)}</div></div>`).join('')}</div>
    <p class="hr-note" style="margin-top:8px">Replace a card only with a dated, verifiable notice and its source before publishing anything.</p>`;
}

const MOUNDS_BOX = { lon0: 76.1075, lon1: 76.1185, lat0: 29.2845, lat1: 29.2955, w: 420, h: 420 };
async function site(el, deps, rerender) {
  const h = deps.escapeHtml, m = S.data.mounds, sel = m[S.mound] || m[0];
  const mPerDegLon = 111320 * Math.cos(29.29 * Math.PI / 180), px200 = 200 / mPerDegLon / (MOUNDS_BOX.lon1 - MOUNDS_BOX.lon0) * MOUNDS_BOX.w;
  el.innerHTML = `${banner(h, 'Illustrative map markers only. Marker positions and descriptions are not an official survey dataset; verify before use.')}<div class="hr-two">
    <svg class="hr-map" viewBox="0 0 ${MOUNDS_BOX.w} ${MOUNDS_BOX.h}" width="100%" role="img" aria-label="Seven mounds of Rakhigarhi, illustrative">
      ${m.map((x, i) => { const [px, py] = project(x.lat, x.lon, MOUNDS_BOX); return `<g class="hr-pin" data-i="${i}"><circle cx="${px}" cy="${py}" r="${i === S.mound ? 15 : 12}" fill="${i === S.mound ? 'var(--amber)' : 'var(--panel3)'}" stroke="var(--amber)" stroke-width="2"/><text x="${px}" y="${py + 4}" text-anchor="middle" style="fill:var(--ink);font-size:11px">${i + 1}</text></g>`; }).join('')}
      <line x1="20" y1="${MOUNDS_BOX.h - 20}" x2="${20 + px200}" y2="${MOUNDS_BOX.h - 20}" stroke="var(--ink)" stroke-width="2"/><text x="20" y="${MOUNDS_BOX.h - 26}">200 m</text><text x="${MOUNDS_BOX.w - 10}" y="18" text-anchor="end">N ↑</text></svg>
    <div class="panel" style="padding:14px"><div class="hr-k">The seven mounds of Rakhigarhi</div><h3 style="margin:4px 0">${h(sel.code)}</h3><div class="hr-note mono">${sel.lat}, ${sel.lon}</div><p style="font-size:13px">${h(sel.summary)}</p>
      <table class="hr-table"><tr><td>Map status</td><td>Illustrative markers only. Official GIS coordinates and site boundaries are not included.</td></tr><tr><td>Research status</td><td>This concept does not claim to run excavations, hold collections or manage human remains.</td></tr><tr><td>Source notes</td><td>See Sources for the cited literature review and limits.</td></tr></table>
      <div class="hr-row" style="margin-top:8px">${m.map((x, i) => `<button class="hr-chip" aria-pressed="${i === S.mound}" data-i="${i}">${h(x.code)}</button>`).join('')}</div>
      <p class="hr-note">Drawn offline from the marker list; no satellite tiles are loaded.</p></div></div>`;
  el.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { S.mound = +b.dataset.i; rerender(); });
}

const INDIA = { lon0: 66, lon1: 98, lat0: 6, lat1: 37.5, w: 420, h: 440 };
const shortName = n => n.split(',')[0].replace('Group of Monuments at ', '').replace(' Group of Monuments', '').replace(' Rock Shelters', '').replace(' Mahavihara', '');
/** Greedy label placement: right, left, above, below; a label that fits nowhere is left to the tooltip. The selected place goes first. */
function placeLabels(sites, sel) {
  const boxes = sites.map(s => { const [px, py] = project(s.lat, s.lon, INDIA); return [px - 6, py - 6, px + 6, py + 6]; }), out = [];
  for (const s of [...sites].sort((a, b) => (b === sel) - (a === sel))) {
    const [px, py] = project(s.lat, s.lon, INDIA), w = shortName(s.name).length * 6.3 + 4, hgt = 12;
    const tries = [[px + 9, py + 4, 'start'], [px - 9, py + 4, 'end'], [px + 8, py - 9, 'start'], [px + 8, py + 16, 'start'], [px - 8, py - 9, 'end'], [px - 8, py + 16, 'end']];
    let placed = null;
    for (const [lx, ly, anchor] of tries) {
      const x0 = anchor === 'start' ? lx : lx - w, box = [x0, ly - hgt + 2, x0 + w, ly + 2];
      if (box[0] < 0 || box[2] > INDIA.w) continue;
      if (boxes.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      boxes.push(box); placed = { lx, ly, anchor }; break;
    }
    out.push({ s, px, py, ...(placed || { lx: null }) });
  }
  return out;
}
async function india(el, deps, rerender) {
  const h = deps.escapeHtml, all = S.data.indiaSites, periods = [...new Set(all.map(s => s.period))];
  const shown = all.filter(s => (!S.period || s.period === S.period) && (!S.q || `${s.name} ${s.state}`.toLowerCase().includes(S.q.toLowerCase())));
  const sel = shown.find(s => s.id === S.siteSel) || shown[0];
  el.innerHTML = `<div class="hr-row" style="margin-bottom:8px"><input id="hrQ" placeholder="Search places" value="${h(S.q)}" style="${deps.FIELD}"><select id="hrPeriod" style="${deps.FIELD}" aria-label="Period"><option value="">All periods</option>${periods.map(p => `<option ${p === S.period ? 'selected' : ''}>${h(p)}</option>`).join('')}</select><span class="hr-note">${shown.length} of ${all.length} sample places</span></div>
    <div class="hr-two"><svg class="hr-map" viewBox="0 0 ${INDIA.w} ${INDIA.h}" width="100%" role="img" aria-label="Selected heritage locations in India">${graticule(INDIA)}
      ${placeLabels(shown, sel).map(({ s, px, py, lx, ly, anchor }) => `<g class="hr-pin" data-id="${s.id}"><title>${h(s.name)}</title><circle cx="${px}" cy="${py}" r="${s === sel ? 7 : 5}" fill="${s === sel ? 'var(--amber)' : 'var(--cyan)'}" stroke="var(--panel)" stroke-width="2"/>${lx == null ? '' : `<text x="${lx}" y="${ly}" text-anchor="${anchor}" style="fill:var(--ink)">${h(shortName(s.name))}</text>`}</g>`).join('')}</svg>
    ${sel ? `<div class="panel" style="padding:14px"><div class="hr-k">${h(sel.period)} · ${h(sel.era)}</div><h3 style="margin:4px 0">${h(sel.name)}</h3><div class="hr-note">${h(sel.state)} · <span class="mono">${sel.lat}, ${sel.lon}</span></div><p class="hr-note">${h(sel.note)}</p><a class="btn btn-line" href="${h(sel.url)}" target="_blank" rel="noopener">${h(sel.source)} ↗</a></div>` : '<p class="hr-note">No place matches.</p>'}</div>
    <p class="hr-note">Selected examples only. Coordinates identify general listed locations; they do not define site extents, excavation areas, ownership, access or protected boundaries. The Rakhigarhi point is a secondary coordinate record that needs authorised GIS verification.</p>`;
  let t; el.querySelector('#hrQ').oninput = e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; rerender(); }, 250); };
  el.querySelector('#hrPeriod').onchange = e => { S.period = e.target.value; rerender(); };
  el.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { S.siteSel = b.dataset.id; rerender(); });
}

async function research(el, deps) {
  const h = deps.escapeHtml;
  el.innerHTML = `<div class="cap-section-label">Proposed research areas</div><div class="hr-grid">${S.data.research.map((r, i) => `<div class="hr-card"><div class="hr-k">Stream ${String(i + 1).padStart(2, '0')}</div><h4>${h(r.title)}</h4><p class="hr-note">${h(r.desc)}</p></div>`).join('')}</div>
    <div class="cap-section-label" style="margin-top:14px">Proposed capability areas</div><div class="hr-grid">${S.data.services.map(s => `<div class="hr-card"><div class="hr-k">${h(s.id)} · ${h(s.pillar)}</div><h4>${h(s.title)}</h4><p class="hr-note">${h(s.desc)}</p><div class="hr-note">Concept placeholder — no price or enquiry endpoint.</div></div>`).join('')}</div>`;
}

// --- drafts -----------------------------------------------------------------------------------------
async function loadDrafts(deps) { S.drafts = await deps.apiGet('/api/heritage/itineraries'); if (!S.drafts.some(d => d.id === S.draftId)) S.draftId = S.drafts[0]?.id || null; return S.drafts.find(d => d.id === S.draftId) || null; }
async function addToDraft(deps, id) {
  let cur = await loadDrafts(deps);
  if (!cur) cur = await deps.apiPost('/api/heritage/itineraries', { title: 'Rakhigarhi visit draft', items: [] });
  if (cur.items.includes(id)) { deps.toast('Already in your draft.'); return; }
  const saved = await deps.apiPost('/api/heritage/itineraries/' + cur.id, { ...cur, items: [...cur.items, id] }, 'PUT');
  S.draftId = saved.id; deps.toast(`Added to “${saved.title}” (${saved.items.length}).`);
}

async function activities(el, deps, rerender) {
  const h = deps.escapeHtml, fams = S.data.activityFamilies;
  const list = S.data.activities.filter(a => !S.family || a.family === S.family);
  const cur = await loadDrafts(deps);
  el.innerHTML = `${banner(h, 'Proposed visitor concepts · mock catalogue. None is bookable or confirmed; no site access, operator, permission, price or availability is implied.')}
    <div class="hr-row" style="margin-bottom:8px"><button class="hr-chip" aria-pressed="${!S.family}" data-f="">All (${S.data.activities.length})</button>${fams.map(f => `<button class="hr-chip" aria-pressed="${S.family === f.name}" data-f="${h(f.name)}">${h(f.name)}</button>`).join('')}<span class="hr-note">Draft: ${cur ? h(cur.title) + ' · ' + cur.items.length + ' item(s)' : 'none yet'}</span><button class="btn btn-line" data-go="itinerary">Open itinerary planner</button></div>
    ${S.family ? `<p class="hr-note">${h(fams.find(f => f.name === S.family)?.intro || '')}</p>` : ''}
    <div class="hr-grid">${list.map(a => `<div class="hr-card"><div class="hr-art" style="--c1:${ART[a.family][0]};--c2:${ART[a.family][1]}">${h(a.imageNote.toUpperCase())}</div><div class="hr-k">${h(a.category)} · ${mins(a.duration)}</div><h4>${h(a.title)}</h4><p style="font-size:12.5px">${h(a.description)}</p><p class="hr-note">${h(a.requirements)}</p>
      <button class="btn ${cur?.items.includes(a.id) ? 'btn-line' : 'btn-amber'}" data-add="${a.id}">${cur?.items.includes(a.id) ? 'In your draft' : 'Add to draft'}</button></div>`).join('')}</div>
    <p class="hr-note" style="margin-top:8px">The prototype's banners were AI-generated concept visuals; Maataa shows plain colour panels instead. Make your own in Image Studio if you want artwork, and keep it labelled as illustration.</p>`;
  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.family = b.dataset.f; rerender(); });
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { await addToDraft(deps, b.dataset.add); rerender(); });
  el.querySelector('[data-go]').onclick = () => { S.tab = 'itinerary'; rerender(); };
}

async function packages(el, deps, rerender) {
  const h = deps.escapeHtml, P = S.data.packages;
  const cur = await loadDrafts(deps);
  const card = p => `<div class="hr-card"><div class="hr-k">${h(p.kind)} · ${h(p.duration)}</div><h4>${h(p.title)}</h4><div class="hr-note">${h(p.group)}</div><p style="font-size:12.5px">${h(p.summary)}</p>
    ${p.series ? `<table class="hr-table"><tr><td>Series</td><td>${h(p.series.name)}</td></tr><tr><td>Volume</td><td>${h(p.series.volume)}</td></tr><tr><td>Stream</td><td>${h(p.series.stream)}</td></tr><tr><td>Chapter</td><td>${h(p.series.chapter)}</td></tr></table>` : ''}
    <details class="hr-det"><summary>Run of show and inclusions</summary><div class="hr-k" style="margin-top:6px">Blocks</div><ul style="font-size:12.5px;padding-left:18px">${p.blocks.map(b => `<li>${h(b)}</li>`).join('')}</ul><div class="hr-k">Includes</div><ul style="font-size:12.5px;padding-left:18px">${p.includes.map(b => `<li>${h(b)}</li>`).join('')}</ul><div class="hr-k">Required before anything is confirmed</div><ul class="hr-note" style="padding-left:18px">${p.required.map(b => `<li>${h(b)}</li>`).join('')}</ul></details>
    <p class="hr-note"><strong>Price:</strong> ${h(p.price)}</p><button class="btn ${cur?.items.includes(p.id) ? 'btn-line' : 'btn-amber'}" data-add="${p.id}">${cur?.items.includes(p.id) ? 'In your draft' : 'Add to draft'}</button></div>`;
  el.innerHTML = `${banner(h, 'Package concepts: proposed scopes and planning rates, not confirmed providers, quotes, access, permissions or bookings. Workshop capacities and prices are quote-required.')}
    <div class="cap-section-label">Workshop packages</div><p class="hr-note">Select two or three short engagements for a guest visit; plan longer workshops as a dedicated program.</p><div class="hr-grid">${P.filter(p => p.kind === 'Workshop').map(card).join('')}</div>
    <div class="cap-section-label" style="margin-top:14px">Documentary packages</div><div class="hr-grid">${P.filter(p => p.kind === 'Documentary').map(card).join('')}</div>
    <div class="cap-section-label" style="margin-top:14px">Production roles · user-provided planning rates (USD)</div>
    <table class="hr-table">${S.data.packageRoles.map(r => `<tr><td>${h(r.label)}</td><td class="n">${r.low === r.high ? usd(r.low) : usd(r.low) + '–' + usd(r.high)}</td><td class="hr-note">${h(r.unit)}</td></tr>`).join('')}</table>`;
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { await addToDraft(deps, b.dataset.add); rerender(); });
}

// --- itinerary --------------------------------------------------------------------------------------
async function itinerary(el, deps, rerender) {
  const h = deps.escapeHtml, it = S.data.itinerary, fv = it.fieldVisit, cs = it.callSheet;
  const cur = await loadDrafts(deps);
  const byId = Object.fromEntries([...S.data.activities, ...S.data.packages].map(a => [a.id, a]));
  const est = await deps.apiGet('/api/heritage/estimate?headcounts=' + [...new Set([1, 3, 5, 6, 10, 15, 20, S.headcount])].sort((a, b) => a - b).join(','));
  const B = await deps.apiGet('/api/heritage/budget?' + new URLSearchParams(S.budget));
  const roles = it.roles;
  const usdSel = roles.filter(r => S.usd.sel.has(r.id)), usdLow = usdSel.reduce((a, r) => a + r.low * (r.daily ? S.usd.days : 1), 0), usdHigh = usdSel.reduce((a, r) => a + r.high * (r.daily ? S.usd.days : 1), 0);
  const route = 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=28.5562%2C77.1000%3B29.2937%2C76.1147';
  const scen = est.scenarios.find(x => x.attendees === S.headcount);
  const dur = a => (a == null ? '' : typeof a.duration === 'number' ? mins(a.duration) : a.duration == null ? 'Overnight' : String(a.duration));
  el.innerHTML = `${banner(h, 'Private planning draft · no booking. Drafts are saved in Maataa on this computer; nothing is sent to an operator or site authority, and no access is reserved.')}
    <div class="hr-two"><div class="panel hr-form" style="padding:12px"><div class="hr-k">Your draft plans</div>
      <div class="hr-row">${(S.drafts || []).map(d => `<button class="hr-chip" aria-pressed="${d.id === S.draftId}" data-draft="${d.id}">${h(d.title)}</button>`).join('')}<button class="hr-chip" id="hrNewDraft">+ New draft</button></div>
      ${cur ? `<input id="hrTitle" value="${h(cur.title)}" style="${deps.FIELD}" aria-label="Draft title"><div class="hr-row"><label class="hr-note">Possible date <input type="date" id="hrDate" value="${h(cur.date)}" style="${deps.FIELD}"></label><label class="hr-note">Group size (1–20) <input type="number" id="hrGroup" min="1" max="20" value="${cur.group}" style="${deps.FIELD};width:70px"></label></div>
        <table class="hr-table">${cur.items.map((id, i) => `<tr><td>${i + 1}</td><td>${h(byId[id]?.title || id)}<div class="hr-note">${h(byId[id]?.family || byId[id]?.kind || '')} · ${h(dur(byId[id]))}</div></td><td style="white-space:nowrap"><button class="hr-chip" data-mv="${i}" data-d="-1" aria-label="Move up">↑</button><button class="hr-chip" data-mv="${i}" data-d="1" aria-label="Move down">↓</button><button class="hr-chip" data-rm="${i}">Remove</button></td></tr>`).join('') || '<tr><td class="hr-note">Add activities or packages from their tabs.</td></tr>'}</table>
        <div class="hr-note">Estimated activity time: ${cur.minutes} minutes, excluding travel, breaks, queues and access arrangements. Group size: ${cur.group}.</div>
        <textarea id="hrNotes" placeholder="Notes" style="${deps.FIELD};min-height:50px">${h(cur.notes)}</textarea>
        <div class="hr-row"><button class="btn btn-amber" id="hrSaveDraft">Save draft</button><button class="btn btn-line" id="hrDelDraft">Delete draft</button></div>` : '<p class="hr-note">No draft yet. Add activities or start a new draft.</p>'}
      </div>
      <div class="panel" style="padding:12px"><div class="hr-k">Proposed program concept · not an institutional claim</div><h3 style="margin:4px 0">${h(it.program.title)}</h3><p class="hr-note">${h(it.program.summary)}</p><p class="hr-note"><strong>Access conditions:</strong> ${h(it.program.access)}</p>
        <table class="hr-table">${it.days.map(d => `<tr><td class="mono" style="white-space:nowrap">Day ${d.day}</td><td><strong>${h(d.title)}</strong><div style="font-size:12.5px">${h(d.focus)}</div><div class="hr-note">${h(d.format)}</div></td></tr>`).join('')}</table></div></div>

    <div class="cap-section-label" style="margin-top:14px">${h(fv.title)}</div>
    <div class="hr-two"><div class="panel" style="padding:12px"><div class="hr-k">Transport</div><p style="font-size:13px">${h(fv.arrival)}</p>
        <table class="hr-table">${it.cabFares.map(f => `<tr><td>${h(f.name)}${f.selected ? ' <span class="hr-note">· screenshot recommendation</span>' : ''}</td><td class="n">${h(f.fare)}</td><td class="hr-note">${h(f.capacity)}</td></tr>`).join('')}</table><p class="hr-note">${h(fv.faresNote)}</p>
        <div class="hr-k" style="margin-top:8px">Route</div><p style="font-size:13px">Pickup: ${h(fv.pickup)} → ${h(fv.destination)}</p><p class="hr-note">${h(fv.routeNote)}</p><a class="btn btn-line" href="${route}" target="_blank" rel="noopener">Directions in OpenStreetMap ↗</a></div>
      <div class="panel" style="padding:12px"><div class="hr-k">Quote and approval required · coverage</div><ul style="font-size:12.5px;padding-left:18px">${fv.coverage.map(c => `<li>${h(c)}</li>`).join('')}</ul><p class="hr-note">No coverage, insurance or permission is included or priced in the estimate.</p></div></div>

    <div class="panel" style="padding:12px;margin-top:12px"><div class="hr-k">Draft call sheet · subject to confirmation</div><h3 style="margin:4px 0">${h(cs.title)}</h3><div class="hr-note">${h(cs.date)}. ${h(cs.note)}</div>
      <div style="overflow-x:auto"><table class="hr-table"><thead><tr><th>Time</th><th>Production block</th><th>Lead</th><th>Operational gate / notes</th></tr></thead><tbody>${cs.blocks.map(b => `<tr><td class="mono" style="white-space:nowrap">${h(b.time)}</td><td>${h(b.block)}</td><td>${h(b.lead)}</td><td class="hr-note">${h(b.gate)}</td></tr>`).join('')}</tbody></table></div>
      <details class="hr-det"><summary>Capture plan, crew handoff and kit</summary><div class="hr-two"><div><div class="hr-k">Capture plan</div><ul style="font-size:12.5px;padding-left:18px">${cs.capture.map(c => `<li>${h(c)}</li>`).join('')}</ul><div class="hr-k">Crew handoff</div><ul style="font-size:12.5px;padding-left:18px">${cs.handoff.map(([r, t]) => `<li><strong>${h(r)}:</strong> ${h(t)}</li>`).join('')}</ul></div><div><div class="hr-k">Minimum kit and data plan</div><ul style="font-size:12.5px;padding-left:18px">${cs.kit.map(c => `<li>${h(c)}</li>`).join('')}</ul></div></div></details>
      <p class="hr-note"><strong>Go / no-go:</strong> ${h(cs.goNoGo)}</p></div>

    <div class="panel" style="padding:12px;margin-top:12px"><div class="hr-k">All cost heads · two-day field visit (INR)</div><div style="overflow-x:auto"><table class="hr-table"><thead><tr><th>Cost head</th><th>Basis</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${est.rows.map(r => `<tr><td>${h(r.name)}</td><td class="hr-note">${h(r.basis)}</td><td class="n">${r.qty} ${h(r.unit)}</td><td class="n">${inr(r.rate)}</td><td class="n">${r.amount == null ? 'Unpriced' : inr(r.amount)}</td><td class="hr-note">${h(r.status)}</td></tr>`).join('')}
      <tr><td colspan="4"><strong>Priced-scope estimate · five-person schedule + ${Math.round(est.contingency * 100)}% contingency</strong></td><td class="n"><strong>${inr(est.scheduled)}</strong></td><td class="hr-note">Excludes the ${est.unpriced.length} unpriced heads.</td></tr></tbody></table></div>
      <div class="hr-row" style="margin-top:8px"><label class="hr-note">Scenario headcount (1–20) <input type="number" id="hrHead" min="1" max="20" value="${S.headcount}" style="${deps.FIELD};width:70px"></label>${scen ? `<strong>${S.headcount} attendees: ${inr(scen.total)} with contingency · ${inr(scen.perAttendee)} per attendee</strong>` : ''}</div>
      <div style="overflow-x:auto"><table class="hr-table"><thead><tr><th>Attendees</th><th>Accommodation</th><th>Airport transfer</th><th>Meals</th><th>Day 2 staff + vehicle</th><th>Contingency</th><th>Total</th><th>Per attendee</th></tr></thead><tbody>${est.scenarios.map(s => `<tr style="${s.attendees === S.headcount ? 'background:var(--amber-soft)' : ''}"><td class="n">${s.attendees}</td><td class="n">${inr(s.accommodation)}</td><td class="n">${inr(s.transfer)}</td><td class="n">${inr(s.meals)}</td><td class="n">${inr(s.day2)}</td><td class="n">${inr(s.contingency)}</td><td class="n">${inr(s.total)}</td><td class="n">${inr(s.perAttendee)}</td></tr>`).join('')}</tbody></table></div>
      <p class="hr-note">Scenarios assume everyone arrives by airport taxi (three per vehicle), one room per two attendees, ₹740 per person for scheduled meals, one local vehicle package and fixed Day 2 staffing. Comparisons, not quotes.</p></div>

    <div class="hr-two" style="margin-top:12px"><div class="panel" style="padding:12px"><div class="hr-k">Optional service menu · USD planning rates</div><label class="hr-note">Production days (1–30) <input type="number" id="hrDays" min="1" max="30" value="${S.usd.days}" style="${deps.FIELD};width:70px"></label>
        <table class="hr-table">${roles.map(r => `<tr><td><label><input type="checkbox" data-usd="${r.id}" ${S.usd.sel.has(r.id) ? 'checked' : ''}> ${h(r.name)}</label><div class="hr-note">${h(r.status)}</div></td><td class="n">${r.low === r.high ? usd(r.low) : usd(r.low) + '–' + usd(r.high)}</td><td class="hr-note">${h(r.basis)}</td></tr>`).join('')}</table>
        <p><strong>Selected: ${usdLow === usdHigh ? usd(usdLow) : usd(usdLow) + '–' + usd(usdHigh)}</strong> <span class="hr-note">for ${S.usd.days} production day(s); kept separate from the INR budget and not converted.</span></p>
        <details class="hr-det"><summary>Quote required; excluded from the estimate</summary><ul class="hr-note" style="padding-left:18px">${fv.quoteRequired.map(q => `<li>${h(q)}</li>`).join('')}</ul></details></div>
      <div class="panel" style="padding:12px"><div class="hr-k">Editable planning model · INR</div><h3 style="margin:4px 0;font-size:15px">${h(B.title)}</h3>
        <div class="hr-row"><label class="hr-note">Adults <input type="number" id="hrAdults" min="1" max="20" value="${B.inputs.adults}" style="${deps.FIELD};width:64px"></label><label class="hr-note">Meals / person / day <input type="number" id="hrMeals" value="${B.inputs.mealsPerDay}" style="${deps.FIELD};width:84px"></label><label class="hr-note">Vehicle / day (each) <input type="number" id="hrVeh" value="${B.inputs.vehiclePerDay}" style="${deps.FIELD};width:84px"></label><label class="hr-note">Seats / vehicle <input type="number" id="hrSeats" min="1" max="60" value="${B.inputs.seatsPerVehicle}" style="${deps.FIELD};width:64px"></label><label class="hr-note">Learning + materials / person <input type="number" id="hrLearn" value="${B.inputs.learningPerPerson}" style="${deps.FIELD};width:84px"></label></div>
        <table class="hr-table"><tr><td>Accommodation</td><td class="n">${inr(B.selected.lines.accommodation)}</td></tr><tr><td>Meals</td><td class="n">${inr(B.selected.lines.meals)}</td></tr><tr><td>Local vehicle${B.selected.vehicles > 1 ? ` (${B.selected.vehicles} vehicles)` : ''}</td><td class="n">${inr(B.selected.lines.vehicle)}</td></tr><tr><td>Learning sessions + materials</td><td class="n">${inr(B.selected.lines.learning)}</td></tr><tr><td><strong>Estimated per person</strong></td><td class="n"><strong>${inr(B.selected.perPerson)}</strong></td></tr><tr><td>Total for ${B.inputs.adults}</td><td class="n">${inr(B.selected.total)}</td></tr></table>
        <table class="hr-table" style="margin-top:6px"><tr><th>Adults</th><th>Rooms</th><th>Vehicles</th><th>Per person</th></tr>${B.samples.map(s => `<tr><td class="n">${s.adults}</td><td class="n">${s.rooms}</td><td class="n">${s.vehicles}</td><td class="n">${inr(s.perPerson)}</td></tr>`).join('')}</table><p class="hr-note">${h(B.seatsNote || '')}</p>
        <p class="hr-note">${h(B.accommodationSource)} Not included: ${h(B.excluded)}</p></div></div>`;
  el.querySelectorAll('[data-draft]').forEach(b => b.onclick = () => { S.draftId = b.dataset.draft; rerender(); });
  el.querySelector('#hrNewDraft').onclick = async () => { const d = await deps.apiPost('/api/heritage/itineraries', { title: 'Rakhigarhi visit draft ' + ((S.drafts || []).length + 1), items: [] }); S.draftId = d.id; rerender(); };
  if (cur) {
    const collect = () => ({ ...cur, title: el.querySelector('#hrTitle').value, date: el.querySelector('#hrDate').value, group: +el.querySelector('#hrGroup').value, notes: el.querySelector('#hrNotes').value });
    const put = async rec => { await deps.apiPost('/api/heritage/itineraries/' + cur.id, rec, 'PUT'); rerender(); };
    el.querySelector('#hrSaveDraft').onclick = async () => { await put(collect()); deps.toast('Draft saved.'); };
    el.querySelector('#hrDelDraft').onclick = async () => { await deps.apiPost('/api/heritage/itineraries/' + cur.id, {}, 'DELETE'); S.draftId = null; deps.toast('Draft deleted.'); rerender(); };
    el.querySelectorAll('[data-mv]').forEach(b => b.onclick = async () => { const r = collect(), i = +b.dataset.mv, j = i + +b.dataset.d; if (j < 0 || j >= r.items.length) return; [r.items[i], r.items[j]] = [r.items[j], r.items[i]]; await put(r); });
    el.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { const r = collect(); r.items.splice(+b.dataset.rm, 1); await put(r); });
  }
  el.querySelector('#hrHead').onchange = e => { S.headcount = Math.max(1, Math.min(20, Math.round(+e.target.value || 1))); rerender(); };
  el.querySelector('#hrDays').onchange = e => { S.usd.days = Math.max(1, Math.min(30, Math.round(+e.target.value || 1))); rerender(); };
  el.querySelectorAll('[data-usd]').forEach(c => c.onchange = () => { c.checked ? S.usd.sel.add(c.dataset.usd) : S.usd.sel.delete(c.dataset.usd); rerender(); });
  [['#hrAdults', 'adults'], ['#hrMeals', 'mealsPerDay'], ['#hrVeh', 'vehiclePerDay'], ['#hrLearn', 'learningPerPerson'], ['#hrSeats', 'seatsPerVehicle']].forEach(([sel, k]) => { el.querySelector(sel).onchange = e => { S.budget[k] = +e.target.value; rerender(); }; });
}

// --- providers ----------------------------------------------------------------------------------------
async function providers(el, deps, rerender) {
  const h = deps.escapeHtml;
  const list = await deps.apiGet('/api/heritage/providers'), match = await deps.apiGet('/api/heritage/providers/match');
  const p = list.find(x => x.id === S.editProv) || null;
  const money = x => (x.rate == null ? 'Rate not set' : (x.currency === 'USD' ? usd(x.rate) : inr(x.rate)) + ' ' + h(x.unit));
  el.innerHTML = `${banner(h, 'People, vendors and services. The prototype needed an online sign-in for this; in Maataa the registry is kept on this computer. Nothing is sent to anyone.')}
    <div class="hr-two"><form class="panel hr-form" id="hrProvForm" style="padding:12px"><div class="hr-k">${p ? 'Edit ' + h(p.name) : 'Register a person, vendor or service'}</div>
      <input name="name" required placeholder="Name (required)" value="${h(p?.name || '')}" style="${deps.FIELD}">
      <div class="hr-row"><select name="kind" style="${deps.FIELD};flex:1" aria-label="Kind">${['person', 'vendor', 'service'].map(k => `<option ${p?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select><input name="area" placeholder="Area served (e.g. Hisar)" value="${h(p?.area || '')}" style="${deps.FIELD};flex:2"></div>
      <input name="roles" placeholder="Roles, comma separated (line producer, runner, vehicle, language expert, camera, drone…)" value="${h((p?.roles || []).join(', '))}" style="${deps.FIELD}">
      <div class="hr-row"><input name="rate" type="number" min="0" placeholder="Rate" value="${p?.rate ?? ''}" style="${deps.FIELD};flex:1"><select name="currency" style="${deps.FIELD};flex:1" aria-label="Currency">${['INR', 'USD'].map(c => `<option ${p?.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select><input name="unit" placeholder="per day" value="${h(p?.unit || 'per day')}" style="${deps.FIELD};flex:1"></div>
      <input name="contact" placeholder="Contact (kept on this computer)" value="${h(p?.contact || '')}" style="${deps.FIELD}">
      <textarea name="certs" placeholder="Certifications, one per line: name | issuer | expires (YYYY-MM-DD)" style="${deps.FIELD};min-height:50px">${h((p?.certifications || []).map(c => [c.name, c.issuer, c.expires].join(' | ')).join('\n'))}</textarea>
      <label class="hr-note"><input type="checkbox" name="verified" ${p?.verified ? 'checked' : ''}> I have verified this provider (identity, scope and rate)</label>
      <textarea name="notes" placeholder="Notes" style="${deps.FIELD};min-height:40px">${h(p?.notes || '')}</textarea>
      <div class="hr-row"><button class="btn btn-amber" type="submit">${p ? 'Save changes' : 'Add provider'}</button>${p ? '<button class="btn btn-line" type="button" id="hrProvCancel">Cancel</button><button class="btn btn-line" type="button" id="hrProvDel">Delete</button>' : ''}</div></form>
    <div class="panel" style="padding:12px"><div class="hr-k">Auto itinerary · proposed providers</div><p class="hr-note">${h(match.note)}</p>
      <table class="hr-table">${match.needs.map(n => `<tr><td>${h(n.label)}</td><td>${n.proposed ? `<strong>${h(n.proposed.name)}</strong><div class="hr-note">${money(n.proposed)}${n.alternatives.length ? ' · ' + n.alternatives.length + ' alternative(s)' : ''}</div>` : '<span class="hr-note">No verified provider</span>'}${n.needsReview.length ? `<div class="hr-note" style="color:var(--amber)">Needs review: ${n.needsReview.map(r => h(r.name) + ' (' + h(r.reason) + ')').join(', ')}</div>` : ''}</td></tr>`).join('')}</table></div></div>
    <div class="cap-section-label" style="margin-top:12px">Registry (${list.length})</div>
    <div class="hr-grid">${list.map(x => `<div class="hr-card"><div class="hr-k">${h(x.kind)} · ${x.verified ? '<span style="color:var(--green)">verified</span>' : 'not verified'}</div><h4>${h(x.name)}</h4><div class="hr-note">${h(x.roles.join(', '))}${x.area ? ' · ' + h(x.area) : ''}</div><div style="font-size:12.5px">${money(x)}</div>${x.certifications.length ? `<div class="hr-note">${x.certifications.map(c => h(c.name) + (c.expires ? ' (to ' + h(c.expires) + ')' : '')).join(' · ')}</div>` : ''}<button class="btn btn-line" data-edit="${x.id}" style="margin-top:6px">Edit</button></div>`).join('') || '<p class="hr-note">No providers yet.</p>'}</div>`;
  el.querySelector('#hrProvForm').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    const body = { name: f.get('name'), kind: f.get('kind'), area: f.get('area'), roles: f.get('roles'), rate: f.get('rate'), currency: f.get('currency'), unit: f.get('unit'), contact: f.get('contact'), notes: f.get('notes'), verified: !!f.get('verified'),
      certifications: String(f.get('certs') || '').split('\n').map(l => l.split('|').map(s => s.trim())).filter(a => a[0]).map(([name, issuer, expires]) => ({ name, issuer: issuer || '', expires: expires || '' })) };
    try { if (p) await deps.apiPost('/api/heritage/providers/' + p.id, body, 'PUT'); else await deps.apiPost('/api/heritage/providers', body); S.editProv = null; deps.toast('Provider saved.'); rerender(); } catch (err) { deps.toast(err.message); }
  };
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { S.editProv = b.dataset.edit; rerender(); });
  const c = el.querySelector('#hrProvCancel'); if (c) c.onclick = () => { S.editProv = null; rerender(); };
  const d = el.querySelector('#hrProvDel'); if (d) d.onclick = async () => { await deps.apiPost('/api/heritage/providers/' + p.id, {}, 'DELETE'); S.editProv = null; deps.toast('Provider deleted.'); rerender(); };
}

// --- 3D gallery ---------------------------------------------------------------------------------------
let three = null, stopRender = null;
async function gallery(el, deps, rerender) {
  const h = deps.escapeHtml, G = S.data.gallery, m = G[S.model] || G[0];
  el.innerHTML = `${banner(h, 'Synthetic 3D model gallery: procedural shapes for testing the viewer. These are not artifacts, scans or replicas from Rakhigarhi.')}
    <div class="hr-two"><div><canvas class="hr-3d" id="hr3d" aria-label="3D viewer: ${h(m.title)}"></canvas><p class="hr-note">Drag to turn the model.</p></div>
    <div><div class="hr-grid">${G.map((g, i) => `<div class="hr-card" style="${i === S.model ? 'border-color:var(--amber)' : ''}"><div class="hr-k">${h(g.category)} · ${h(g.source)}</div><h4>${h(g.title)}</h4><p class="hr-note">${h(g.desc)}</p><button class="btn btn-line" data-model="${i}">Inspect in 3D viewer</button></div>`).join('')}</div>
      <p class="hr-note" style="margin-top:8px">Replace these only with assets that have documented provenance, permissions and descriptive metadata.</p></div></div>`;
  el.querySelectorAll('[data-model]').forEach(b => b.onclick = () => { S.model = +b.dataset.model; rerender(); });
  if (stopRender) stopRender();
  try { if (!three) three = await import('/vendor/three.module.min.js'); } catch (e) { el.querySelector('#hr3d').replaceWith(Object.assign(document.createElement('p'), { className: 'hr-note', textContent: '3D viewer unavailable: ' + e.message })); return; }
  const T = three, canvas = el.querySelector('#hr3d');
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const W = canvas.clientWidth || 480, H = canvas.clientHeight || 360; renderer.setSize(W, H, false); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new T.Scene(), cam = new T.PerspectiveCamera(40, W / H, 0.1, 100); cam.position.set(0, 1.2, 5); cam.lookAt(0, 0, 0);
  scene.add(new T.HemisphereLight(0xffffff, 0x334455, 1.4)); const sun = new T.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 4, 5); scene.add(sun);
  const mat = new T.MeshStandardMaterial({ color: m.color, roughness: 0.75, metalness: 0.05 });
  let geo;
  if (m.modelType === 'cylinder') geo = new T.CylinderGeometry(1.1, 1.1, 0.35, 64);
  else if (m.modelType === 'lathe') geo = new T.LatheGeometry([[0, -1], [0.55, -1], [0.75, -0.6], [0.95, 0], [0.8, 0.55], [0.45, 0.8], [0.5, 1]].map(([x, y]) => new T.Vector2(x, y)), 64);
  else if (m.modelType === 'torus') geo = new T.TorusGeometry(0.9, 0.28, 32, 96);
  else geo = new T.SphereGeometry(0.9, 48, 32);
  const mesh = new T.Mesh(geo, mat); if (m.modelType === 'cylinder') mesh.rotation.x = Math.PI / 2.4; scene.add(mesh);
  let drag = null, ry = 0.4, rx = 0, alive = true;
  canvas.onpointerdown = e => { drag = [e.clientX, e.clientY, ry, rx]; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = e => { if (!drag) return; ry = drag[2] + (e.clientX - drag[0]) / 120; rx = Math.max(-1.2, Math.min(1.2, drag[3] + (e.clientY - drag[1]) / 120)); };
  canvas.onpointerup = () => { drag = null; };
  const tick = () => { if (!alive || !canvas.isConnected) { renderer.dispose(); return; } if (!drag) ry += 0.004; mesh.rotation.y = ry; mesh.rotation.z = rx * 0.5; renderer.render(scene, cam); requestAnimationFrame(tick); };
  stopRender = () => { alive = false; };
  tick();
}

export const _test = { mins, placeLabels, shortName };
