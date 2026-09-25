'use strict';
/* ===========================================================================
 * NOVA Runtime — host methods for sandboxed skills
 *
 * Some skills need more than MCP tools: the summarizer has to read a stored
 * session and call the local model. Those capabilities live on the main
 * thread (the SQLite store and the Ollama client), so the worker asks for
 * them by name and lib/skill-runner.js forwards the call here.
 *
 * A skill only receives the host methods its manifest lists in
 * `requiredHost` (first-party skills seeded before that field existed fall
 * back to FIRST_PARTY_HOST below). Each method also enforces its own rule:
 *   readSession — the skill's session:read permission must be granted
 *   generate    — local Ollama models only; API/remote models are refused
 * ========================================================================= */

const FIRST_PARTY_HOST = {
  skl_summarize: ['readSession', 'generate'],
  skl_treatment: ['readSession', 'generate'],
  skl_shotlist: ['readSession', 'generate'],
  skl_callsheet: ['readSession', 'generate'],
  skl_translate: ['readSession', 'generate'],
  skl_pptx: ['readSession', 'generate'],
};
const MAX_OUTPUT_TOKENS = 3072;

function httpErr(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }

function granted(skill, scope) {
  return (skill.permissions || []).some(p => p && p.scope === scope && p.granted);
}

function hostMethodsFor(skill) {
  const declared = skill && skill.manifest && skill.manifest.requiredHost;
  if (Array.isArray(declared)) return declared;
  return FIRST_PARTY_HOST[skill && skill.id] || [];
}

/** Picks the first candidate that is a stored Ollama model, then falls back
 *  to any stored Ollama model. Never returns a demo, MLX, or API model. */
function resolveLocalModel(store, candidates) {
  for (const id of candidates) {
    if (!id) continue;
    const model = store.get('models', String(id));
    if (model && model.runtime === 'ollama') return model.id;
    if (model) throw httpErr(400, 'Model "' + id + '" is not a local Ollama model; the summarizer only runs on local models.');
  }
  const local = store.all('models').find(m => m.runtime === 'ollama');
  if (!local) throw httpErr(503, 'No local Ollama model is available. Sync models from Ollama first.');
  return local.id;
}

/** Returns { methodName: async (args) => result } for the methods this
 *  skill is allowed to call. `options.modelId` is a caller-level preference
 *  (for example the agent's own model). */
function buildSkillHost(store, ollama, skill, options = {}) {
  const allowed = new Set(hostMethodsFor(skill));
  const host = {};
  let sessionModelId = null;

  if (allowed.has('readSession')) {
    host.readSession = async ({ sessionId } = {}) => {
      if (!granted(skill, 'session:read')) throw httpErr(403, 'Skill "' + skill.name + '" does not have the session:read permission.');
      const session = store.get('sessions', String(sessionId || ''));
      if (!session) throw httpErr(404, 'Unknown session: ' + sessionId);
      sessionModelId = session.modelId || null;
      return {
        id: session.id,
        title: session.title || null,
        modelId: session.modelId || null,
        messages: (session.messages || [])
          .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
          .map(m => ({ id: m.id || null, role: m.role, content: String(m.content || ''), createdAt: m.createdAt || null })),
      };
    };
  }

  if (allowed.has('generate')) {
    host.generate = async ({ system, prompt, modelId, maxTokens, format } = {}) => {
      if (!ollama) throw httpErr(503, 'Ollama is not configured.');
      if (!prompt || !String(prompt).trim()) throw httpErr(400, 'generate needs a prompt');
      const localSession = sessionModelId && store.get('models', sessionModelId);
      const sessionCandidate = localSession && localSession.runtime === 'ollama' ? sessionModelId : null;
      const model = resolveLocalModel(store, [modelId, options.modelId, sessionCandidate]);
      const messages = [];
      if (system) messages.push({ role: 'system', content: String(system).slice(0, 4000) });
      messages.push({ role: 'user', content: String(prompt) });
      const numPredict = Math.max(32, Math.min(MAX_OUTPUT_TOKENS, Number(maxTokens) || 512));
      const response = await ollama.chatFull(model, messages, { options: { temperature: 0.2, num_predict: numPredict }, ...(format === 'json' ? { format: 'json' } : {}) });
      return { text: String((response && response.message && response.message.content) || ''), model, doneReason: (response && response.done_reason) || null };
    };
  }

  return host;
}

module.exports = { buildSkillHost, hostMethodsFor, resolveLocalModel, FIRST_PARTY_HOST };
