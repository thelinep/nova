/* ===========================================================================
 * Lipi OS and the Rakhigarhi heritage platform, inside Maataa
 *
 * Absorbed from the owner's "Rakhigarhi Research Platform" concept prototype
 * (lib/heritage-data/*.json, copied with their source notes and caveats).
 * This module serves that reference data and keeps the things people make
 * with it in Maataa's own stores on this computer:
 *   lipiReadings       private reading desk (book, source and script notes)
 *   lipiEditions       multi-language, multi-script newspaper editions
 *   heritageItinerary  draft visit plans built from proposed activities
 *   heritageProviders  people, vendors and services, with certifications
 * Budget and price figures are recomputed here from their stated basis, so a
 * changed rate or group size gives a consistent planning estimate. Nothing is
 * booked, sent or published.
 * ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lipi = require('./lipi-scripts');

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const newId = p => p + crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+$/g, '').slice(0, n);
const num = (v, lo, hi, dflt) => { if (v == null || v === '') return dflt; const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

let LIPI = null, RAKHI = null, CHARS = null;
const dataDir = path.join(__dirname, 'heritage-data');
function lipiData() { if (!LIPI) LIPI = JSON.parse(fs.readFileSync(path.join(dataDir, 'lipi-os.json'), 'utf8')); return LIPI; }
function rakhiData() { if (!RAKHI) RAKHI = JSON.parse(fs.readFileSync(path.join(dataDir, 'rakhigarhi.json'), 'utf8')); return RAKHI; }
function charScripts() {
  if (CHARS) return CHARS;
  CHARS = new Map();
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'lipi-scripts.json'), 'utf8'));
  for (const s of Object.values(d.scripts).sort((a, b) => a.order - b.order)) for (const v of Object.values(s.map)) for (const ch of v) if (!CHARS.has(ch)) CHARS.set(ch, s.label);
  return CHARS;
}

// --- Lipi OS ---------------------------------------------------------------------------------------

/** The script registry, each record marked with whether Lipi's converter can write it. */
function registry({ q = '', tier = '' } = {}) {
  const d = lipiData(), can = new Set(lipi.list().map(s => s.code));
  const query = String(q).trim().toLowerCase();
  const all = d.registry.map(r => ({ ...r, tierLabel: d.tiers[r.tier] || r.tier, convertible: can.has(r.code) }));
  const records = all.filter(r => (!tier || r.tier === tier) && (!query || `${r.code} ${r.name} ${r.region}`.toLowerCase().includes(query)));
  return {
    total: all.length, shown: records.length, convertible: all.filter(r => r.convertible).length,
    tiers: Object.entries(d.tiers).map(([id, label]) => ({ id, label, count: all.filter(r => r.tier === id).length })),
    boundary: 'The registry lists writing systems and historical styles, not one language per row. Indus / Harappan symbols stay exhibition-only: no decipherment or transliteration is claimed.',
    records,
  };
}

/** Planned minutes for a workshop, with each session's start offset. */
function workshopPlan(w) {
  let at = 0;
  const sessions = w.sessions.map(s => { const row = { ...s, start: at, end: at + s.minutes }; at += s.minutes; return row; });
  return { ...w, sessions, plannedMinutes: at, matchesRuntime: at === w.runtimeMinutes };
}

/** Draft per-participant price for a Futurism workshop, from the stated basis (rounded up to ₹100). */
function futurismPrice(w, basis = lipiData().futurism.priceBasis) {
  const days = w.days;
  const people = basis.lecturerPerDay * (days + 1) + basis.researcherPerDay * (days + 1);
  const production = (basis.producerPerDay + basis.avAssistantPerDay + basis.venuePerDay) * days;
  const materials = basis.materialsPerParticipantDay * basis.cohort * days;
  const expenses = people + production + materials;
  const total = expenses * (1 + basis.platformCharge);
  return { days, cohort: basis.cohort, people, production, materials, expenses, platform: Math.round(expenses * basis.platformCharge), total: Math.round(total), perParticipant: Math.ceil(total / basis.cohort / 100) * 100 };
}

function learning() {
  const d = lipiData();
  return {
    studyLanguages: d.studyLanguages, courses: d.courses, catalogs: d.catalogs,
    workshops: d.workshops.map(workshopPlan),
    futurism: { priceBasis: d.futurism.priceBasis, workshops: d.futurism.workshops.map(w => ({ ...w, computed: futurismPrice(w) })) },
    notes: {
      courses: 'Maataa links to provider pages; it does not run these courses, award certificates or guarantee current enrollment.',
      workshops: 'Draft workshop plans: price, instructor, venue, materials, enrollment and delivery are unconfirmed, and every manual needs script-specific review.',
      futurism: 'Draft educational proposals and planning estimates only; not confirmed bookings, contracted staff rates or vendor quotes.',
    },
  };
}

const CATEGORIES = ['languages', 'scripts', 'books', 'cities', 'universities', 'markets', 'trades', 'inventions', 'people', 'places'];

/** The sourced chronology, filtered; dated events carry a sortable year (BCE negative). */
function chronology({ continent = '', category = '', from = -10000, to = 2026 } = {}) {
  const c = lipiData().chronology;
  const lo = num(from, -10000, 2026, -10000), hi = num(to, -10000, 2026, 2026);
  const events = c.events.filter(e => (!continent || e.continent === continent) && (!category || (e.entityTypes || []).includes(category) || (e.entities?.[category] || []).length))
    .filter(e => e.dateSort == null || (e.dateSort >= lo && e.dateSort <= hi));
  const dated = events.filter(e => e.dateSort != null).sort((a, b) => a.dateSort - b.dateSort);
  return {
    range: c.range, categories: CATEGORIES, continents: c.continents.map(x => ({ ...x, count: c.events.filter(e => e.continent === x.id).length })), continentShapes: c.continentShapes,
    total: c.events.length, shown: events.length, dated, undated: events.filter(e => e.dateSort == null), scriptEvents: c.scriptEvents,
    note: 'A sourced starter chronology, not an exhaustive global history. Approximate, debated and undated material is labelled rather than given false precision. BCE/CE has no year zero.',
  };
}

function overview() {
  const d = lipiData();
  return {
    provenance: d.provenance, welcome: lipi.welcome(), welcomeReference: d.welcomeReference, studyLanguages: d.studyLanguages,
    scripts: lipi.list(), registry: { total: d.registry.length }, atlas: d.atlas,
    counts: { courses: d.courses.length, catalogs: d.catalogs.length, workshops: d.workshops.length, futurism: d.futurism.workshops.length, chronology: d.chronology.events.length },
  };
}

// --- reading desk ----------------------------------------------------------------------------------
const READ = 'lipiReadings';
function readings(store) { return store.all(READ).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
function saveReading(store, input = {}, id = null) {
  const prior = id ? store.get(READ, id) : null;
  if (id && !prior) throw error('Unknown reading-desk entry.', 404);
  const title = clip(input.title, 300).trim();
  if (!title) throw error('Give the book or text a title.');
  const url = clip(input.url, 1000).trim();
  if (url && !/^https?:\/\//i.test(url)) throw error('The source link must start with http:// or https://.');
  const rec = { id: prior?.id || newId('read_'), title, author: clip(input.author, 300).trim(), language: clip(input.language, 80), script: clip(input.script, 80), url, notes: clip(input.notes, 4000), status: ['to-read', 'reading', 'done'].includes(input.status) ? input.status : (prior?.status || 'to-read'), createdAt: prior?.createdAt || now(), updatedAt: now() };
  return store.put(READ, rec);
}
function removeReading(store, id) { if (!store.get(READ, id)) throw error('Unknown reading-desk entry.', 404); store.delete(READ, id); return { ok: true }; }

// --- newsroom ----------------------------------------------------------------------------------------
const ED = 'lipiEditions';
function newsroom() { const d = lipiData(); return { ...d.newsroom, studyLanguages: d.studyLanguages, scripts: lipi.list().map(s => ({ code: s.code, label: s.label, direction: s.direction })) }; }
function editions(store) { return store.all(ED).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
function normaliseLane(l = {}) {
  const script = lipi.known(l.script) || l.script === 'Latn' ? l.script : 'Deva';
  return { language: clip(l.language || 'Hindi', 60), script, headline: clip(l.headline, 300), body: clip(l.body, 6000), method: ['typed', 'transliterated'].includes(l.method) ? l.method : 'typed' };
}
function saveEdition(store, input = {}, id = null) {
  const prior = id ? store.get(ED, id) : null;
  if (id && !prior) throw error('Unknown edition.', 404);
  const d = lipiData();
  const theme = d.newsroom.themes.some(t => t.id === input.theme) ? input.theme : (prior?.theme || d.newsroom.themes[0].id);
  const lanes = (Array.isArray(input.lanes) ? input.lanes : prior?.lanes || []).slice(0, 8).map(normaliseLane);
  const rec = { id: prior?.id || newId('ed_'), masthead: clip(input.masthead || prior?.masthead || 'Vaigyaaniq Times', 80), theme, storyId: clip(input.storyId || prior?.storyId || d.newsroom.stories[0].id, 60), source: { headline: clip(input.source?.headline ?? prior?.source?.headline ?? '', 300), body: clip(input.source?.body ?? prior?.source?.body ?? '', 6000) }, lanes, createdAt: prior?.createdAt || now(), updatedAt: now() };
  return store.put(ED, rec);
}
function removeEdition(store, id) { if (!store.get(ED, id)) throw error('Unknown edition.', 404); store.delete(ED, id); return { ok: true }; }

/** Text diagnostics for the newsroom's debug view: what the string actually stores. */
function inspectText(text) {
  const t = String(text || '').slice(0, 2000);
  const graphemes = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(t)].length : [...t].length;
  const blocks = new Map();
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80 && !/[A-Za-z]/.test(ch)) continue;
    const name = cp >= 0x0900 && cp <= 0x097f ? 'Devanagari' : (cp >= 0x10A00 && cp <= 0x10A5F) ? 'Kharoshthi' : cp < 0x250 ? 'Latin' : (charScripts().get(ch) || 'Other');
    blocks.set(name, (blocks.get(name) || 0) + 1);
  }
  return { codePoints: [...t].length, graphemes, nfc: t === t.normalize('NFC'), nfd: t === t.normalize('NFD'), scripts: [...blocks].map(([name, count]) => ({ name, count })), note: 'Character counts and Unicode blocks are listed for inspection; this is not script identification or scholarly validation.' };
}

// --- Rakhigarhi -------------------------------------------------------------------------------------
function rakhigarhi() {
  const d = rakhiData();
  return { ...d, itinerary: { ...d.itinerary, estimate: fieldVisitEstimate(), budget: budgetModel({ adults: 1 }) } };
}

/** The two-day field visit: priced heads, scheduled estimate and group scenarios. */
function fieldVisitEstimate({ headcounts = [1, 3, 5, 6, 10, 15, 20] } = {}) {
  const it = rakhiData().itinerary, fv = it.fieldVisit, cost = id => it.costs.find(c => c.id === id)?.rate || 0;
  const rows = it.costs.map(c => ({ ...c, amount: c.rate == null ? null : c.rate * c.qty }));
  const priced = rows.filter(r => r.amount != null).reduce((a, r) => a + r.amount, 0);
  const scheduled = Math.round(priced * (1 + fv.contingency));
  const sc = fv.scenario;
  const scenarios = headcounts.map(n => {
    const accommodation = Math.ceil(n / sc.perRoom) * cost('accommodation');
    const transfer = Math.ceil(n / sc.perVehicle) * cost('airport-transfer');
    const meals = n * sc.mealsPerPerson;
    const base = accommodation + transfer + meals + sc.day2Fixed;
    const contingency = Math.round(base * fv.contingency);
    return { attendees: n, accommodation, transfer, meals, day2: sc.day2Fixed, contingency, total: base + contingency, perAttendee: Math.round((base + contingency) / n) };
  });
  return { rows, priced, contingency: fv.contingency, scheduled, unpriced: rows.filter(r => r.amount == null).map(r => r.name), scenarios };
}

/** The editable 7-day / 6-night planning model. */
function budgetModel({ adults = 1, mealsPerDay, vehiclePerDay, learningPerPerson, seatsPerVehicle } = {}) {
  const m = rakhiData().itinerary.budgetModel;
  const n = Math.round(num(adults, 1, 20, 1));
  const meals = num(mealsPerDay, 0, 100000, m.defaults.mealsPerDay), vehicle = num(vehiclePerDay, 0, 1000000, m.defaults.vehiclePerDay), learn = num(learningPerPerson, 0, 1000000, m.defaults.learningPerPerson);
  const seats = Math.round(num(seatsPerVehicle, 1, 60, m.defaults.seatsPerVehicle || 6));
  const per = k => {
    // A group needs enough rooms and enough vehicles: one vehicle per `seats` adults (F8: one vehicle for 20 people understated the cost).
    const rooms = Math.ceil(k / m.perRoom), vehicles = Math.ceil(k / seats);
    const lines = { accommodation: rooms * m.roomRate * m.nights / k, meals: meals * m.days, vehicle: vehicles * vehicle * m.days / k, learning: learn };
    const total = Object.values(lines).reduce((a, b) => a + b, 0);
    return { adults: k, rooms, vehicles, lines: Object.fromEntries(Object.entries(lines).map(([a, b]) => [a, Math.round(b)])), perPerson: Math.round(total), total: Math.round(total * k) };
  };
  return { inputs: { adults: n, mealsPerDay: meals, vehiclePerDay: vehicle, learningPerPerson: learn, seatsPerVehicle: seats }, selected: per(n), samples: [1, 6, 7, 10, 12, 15, 20].map(per), title: m.title, accommodationSource: m.accommodationSource, seatsNote: m.seatsNote, excluded: m.excluded };
}

// --- itinerary drafts --------------------------------------------------------------------------------
const IT = 'heritageItinerary';
function itineraries(store) { return store.all(IT).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
function itineraryMinutes(rec) {
  const acts = Object.fromEntries(rakhiData().activities.map(a => [a.id, a]));
  return rec.items.reduce((t, id) => t + (acts[id]?.duration || 0), 0);
}
function saveItinerary(store, input = {}, id = null) {
  const prior = id ? store.get(IT, id) : null;
  if (id && !prior) throw error('Unknown itinerary draft.', 404);
  const known = new Set([...rakhiData().activities.map(a => a.id), ...rakhiData().packages.map(p => p.id)]);
  const items = (Array.isArray(input.items) ? input.items : prior?.items || []).filter(x => known.has(x)).slice(0, 40);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : (prior?.date || '');
  const rec = { id: prior?.id || newId('itin_'), title: clip(input.title || prior?.title || 'Rakhigarhi visit draft', 120), date, group: Math.round(num(input.group ?? prior?.group, 1, 20, 1)), items, notes: clip(input.notes ?? prior?.notes ?? '', 4000), createdAt: prior?.createdAt || now(), updatedAt: now() };
  return store.put(IT, { ...rec, minutes: itineraryMinutes(rec) });
}
function removeItinerary(store, id) { if (!store.get(IT, id)) throw error('Unknown itinerary draft.', 404); store.delete(IT, id); return { ok: true }; }

// --- providers -----------------------------------------------------------------------------------------
const PROV = 'heritageProviders';
const PROVIDER_KINDS = ['person', 'vendor', 'service'];
/** Roles the field visit needs, matched to providers by role. */
const NEEDS = [
  { id: 'line-producer', label: 'Local line producer', role: 'line producer' },
  { id: 'runner', label: 'Production runner', role: 'runner' },
  { id: 'local-vehicle', label: 'Local vehicle (8 h / 80 km)', role: 'vehicle' },
  { id: 'airport-transfer', label: 'Airport transfer', role: 'transfer' },
  { id: 'language-expert', label: 'Ancient-language expert', role: 'language expert' },
  { id: 'cameraman', label: 'Camera operator', role: 'camera' },
  { id: 'drone', label: 'Drone operator', role: 'drone' },
  { id: 'accommodation', label: 'Accommodation', role: 'accommodation' },
  { id: 'catering', label: 'Catering', role: 'catering' },
];
function providers(store) { return store.all(PROV).sort((a, b) => a.name.localeCompare(b.name)); }
function saveProvider(store, input = {}, id = null) {
  const prior = id ? store.get(PROV, id) : null;
  if (id && !prior) throw error('Unknown provider.', 404);
  const name = clip(input.name ?? prior?.name, 160).trim();
  if (!name) throw error('Give the person, vendor or service a name.');
  const certs = (Array.isArray(input.certifications) ? input.certifications : prior?.certifications || []).slice(0, 20).map(c => ({ name: clip(c.name, 160), issuer: clip(c.issuer, 160), expires: /^\d{4}-\d{2}-\d{2}$/.test(c.expires || '') ? c.expires : '' })).filter(c => c.name);
  const rec = {
    id: prior?.id || newId('prov_'), name, kind: PROVIDER_KINDS.includes(input.kind) ? input.kind : (prior?.kind || 'person'),
    roles: (Array.isArray(input.roles) ? input.roles : String(input.roles ?? (prior?.roles || []).join(', ')).split(',')).map(r => clip(r, 60).trim().toLowerCase()).filter(Boolean).slice(0, 12),
    rate: input.rate === '' || input.rate == null ? (prior?.rate ?? null) : num(input.rate, 0, 1e9, null), currency: ['INR', 'USD'].includes(input.currency) ? input.currency : (prior?.currency || 'INR'), unit: clip(input.unit ?? prior?.unit ?? 'per day', 40),
    area: clip(input.area ?? prior?.area ?? '', 160), contact: clip(input.contact ?? prior?.contact ?? '', 200), certifications: certs,
    verified: typeof input.verified === 'boolean' ? input.verified : !!prior?.verified, notes: clip(input.notes ?? prior?.notes ?? '', 2000), createdAt: prior?.createdAt || now(), updatedAt: now(),
  };
  return store.put(PROV, rec);
}
function removeProvider(store, id) { if (!store.get(PROV, id)) throw error('Unknown provider.', 404); store.delete(PROV, id); return { ok: true }; }

/** Auto itinerary: each need gets the verified providers whose roles match, cheapest first; unverified ones are listed apart. */
function matchProviders(store, today = new Date().toISOString().slice(0, 10)) {
  const all = providers(store);
  const certOk = p => p.certifications.every(c => !c.expires || c.expires >= today);
  return {
    note: 'A proposal for you to review. Nothing is booked or sent; confirm availability, scope and rates with each provider.',
    needs: NEEDS.map(n => {
      const match = all.filter(p => p.roles.some(r => r.includes(n.role) || n.role.includes(r)));
      const ready = match.filter(p => p.verified && certOk(p)).sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity));
      return { ...n, proposed: ready[0] || null, alternatives: ready.slice(1, 4), needsReview: match.filter(p => !(p.verified && certOk(p))).map(p => ({ id: p.id, name: p.name, reason: !p.verified ? 'not verified' : 'certification expired' })) };
    }),
  };
}

module.exports = {
  registry, learning, workshopPlan, futurismPrice, chronology, overview, newsroom, inspectText,
  readings, saveReading, removeReading, editions, saveEdition, removeEdition,
  rakhigarhi, fieldVisitEstimate, budgetModel, itineraries, saveItinerary, removeItinerary,
  providers, saveProvider, removeProvider, matchProviders, NEEDS,
  _reset: () => { LIPI = null; RAKHI = null; CHARS = null; },
};
