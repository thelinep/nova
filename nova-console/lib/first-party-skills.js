'use strict';
/* ===========================================================================
 * NOVA Runtime — first-party skill records added after the initial seed
 *
 * The console seeds its skill registry only when the store is empty, so an
 * existing install would never see skills added later. ensureFirstPartySkills
 * adds any of these that are missing and leaves existing records (and your
 * enable/disable choices) untouched.
 * ========================================================================= */

const now = () => new Date().toISOString();
const textPerms = [{ scope: 'session:read', label: 'Read active session content', granted: true }, { scope: 'network', label: 'Network access', granted: false }];

const SKILLS = [
  { id: 'skl_treatment', name: 'Treatment Writer', version: '1.0.0', category: 'Pre-production',
    description: 'Turns a brief, notes or script pages into a treatment: logline, synopsis, characters, themes, tone, visual style and structure. Local model only.',
    manifest: { entrypoint: 'treatment.run(context)', inputs: ['text', 'sessionId', 'title', 'format', 'runtime', 'audience'], outputs: ['data', 'markdown'], requiredTools: [], requiredHost: ['readSession', 'generate'] } },
  { id: 'skl_shotlist', name: 'Shot List', version: '1.0.0', category: 'Pre-production',
    description: 'Breaks scenes or script pages into a numbered shot list with size, angle, movement, lens and estimated duration. Local model only.',
    manifest: { entrypoint: 'shotlist.run(context)', inputs: ['text', 'sessionId', 'title', 'style', 'cameraKit'], outputs: ['data', 'markdown'], requiredTools: [], requiredHost: ['readSession', 'generate'] } },
  { id: 'skl_callsheet', name: 'Call Sheet', version: '1.0.0', category: 'Pre-production',
    description: "Drafts one shoot day's call sheet: general call, location, schedule, cast and crew calls, notes. Unknown facts are left as TBC. Local model only.",
    manifest: { entrypoint: 'callsheet.run(context)', inputs: ['text', 'sessionId', 'production', 'shootDay', 'date', 'generalCall', 'location', 'director', 'producer'], outputs: ['data', 'markdown'], requiredTools: [], requiredHost: ['readSession', 'generate'] } },
];

function record(def) {
  return { ...def, status: 'installed', enabled: true, permissions: textPerms.map(p => ({ ...p })),
    health: { ok: true, lastCheck: now(), detail: 'Runs on a local Ollama model.' },
    installedAt: now(), lastRun: null, runCount: 0, audit: [{ at: now(), action: 'Installed', detail: `v${def.version} first-party skill` }] };
}

function ensureFirstPartySkills(store) {
  const existing = store.all('skills');
  if (!existing.length) return 0; // fresh install: the console seeds everything, including these
  let added = 0;
  for (const def of SKILLS) if (!store.get('skills', def.id)) { store.put('skills', record(def)); added++; }
  return added;
}

module.exports = { SKILLS, record, ensureFirstPartySkills };
