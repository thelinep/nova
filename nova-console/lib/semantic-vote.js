'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class SemanticVoteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SemanticVoteError';
    this.code = code || 'semantic_vote_error';
  }
}

const ALL_CRASH = 'all-crash';

class SemanticVoter {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new SemanticVoteError('store required', 'bad_store');
    if (typeof deps.executor !== 'function') throw new SemanticVoteError('executor required', 'bad_executor');
    this.store = store;
    this.executor = deps.executor;
    this.timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 5000;
  }

  async vote(candidates, inputs) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new SemanticVoteError('candidates array required', 'bad_candidates');
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new SemanticVoteError('inputs array required', 'bad_inputs');
    }

    const runId = uid('svr');
    const startedAt = nowIso();

    const fingerprints = [];
    for (const c of candidates) {
      if (!c || typeof c.id !== 'string' || typeof c.code !== 'string') {
        throw new SemanticVoteError('each candidate needs {id, code}', 'bad_candidate');
      }
      const fp = await this._fingerprint(c.code, inputs, runId);
      fingerprints.push({ candidateId: c.id, fingerprint: fp, crashed: fp === ALL_CRASH });
    }

    const clusters = this._cluster(fingerprints);
    clusters.sort((a, b) => {
      if (b.members.length !== a.members.length) return b.members.length - a.members.length;
      return String(a.members[0]).localeCompare(String(b.members[0]));
    });

    const winnerId = clusters[0] ? clusters[0].members[0] : null;
    const winner = winnerId ? candidates.find((c) => c.id === winnerId) : null;

    this.store.semanticVoteRunsInsert({
      id: runId,
      candidate_count: candidates.length,
      input_count: inputs.length,
      winner_id: winnerId,
      cluster_count: clusters.length,
      clusters_json: JSON.stringify(clusters.map((cl) => ({
        fingerprint: cl.fingerprint,
        members: cl.members,
        size: cl.members.length,
      }))),
      started_at: startedAt,
      ended_at: nowIso(),
    });

    return {
      ok: !!winner,
      runId,
      winner,
      winner_id: winnerId,
      clusters: clusters.map((cl) => ({
        fingerprint: cl.fingerprint,
        members: cl.members.slice(),
        size: cl.members.length,
      })),
    };
  }

  async _fingerprint(code, inputs, runId) {
    const results = [];
    let allCrashed = true;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      try {
        const out = await Promise.race([
          this.executor(code, input),
          new Promise((_, rej) => setTimeout(() => rej(new Error('executor_timeout')), this.timeoutMs)),
        ]);
        allCrashed = false;
        results.push({ i, ok: true, out: this._stable(out) });
      } catch (e) {
        results.push({ i, ok: false, err: String(e.message || e) });
      }
    }
    if (allCrashed) return ALL_CRASH;
    return hash(JSON.stringify(results));
  }

  _stable(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v !== 'object') return String(v);
    try {
      return JSON.stringify(v, Object.keys(v).sort());
    } catch {
      return String(v);
    }
  }

  _cluster(fingerprints) {
    const map = new Map();
    for (const fp of fingerprints) {
      if (fp.crashed) continue;
      if (!map.has(fp.fingerprint)) map.set(fp.fingerprint, []);
      map.get(fp.fingerprint).push(fp.candidateId);
    }
    return Array.from(map.entries()).map(([fingerprint, members]) => ({ fingerprint, members }));
  }

  history(filter) { return this.store.semanticVoteRunsList(filter || {}); }
}

module.exports = { SemanticVoter, SemanticVoteError, ALL_CRASH };
