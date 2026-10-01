'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class DafnyProError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DafnyProError';
    this.code = code || 'dafny_pro_error';
  }
}

// Lines that look like Dafny annotations. Simplified; not a real parser.
const ANNOTATION_TOKENS = [
  'requires', 'ensures', 'invariant', 'decreases', 'modifies', 'reads',
  'yields', 'predicate', 'ghost',
];

function isAnnotationLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('//')) return true;
  if (t.startsWith('/*') || t.startsWith('*')) return true;
  if (t.startsWith('{:') || t.includes('{:') && t.includes('}')) return true;
  for (const tok of ANNOTATION_TOKENS) {
    if (t.startsWith(tok + ' ') || t.startsWith(tok + '\t')) return true;
  }
  return false;
}

function stripAnnotations(code) {
    return String(code)
    .split('\n')
    .filter((l) => !isAnnotationLine(l))
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .join('\n')
    .trim();
}

class DafnyPro {
  constructor(store, deps) {
    deps = deps || {};
    if (!store) throw new DafnyProError('store required', 'bad_store');
    if (typeof deps.llm !== 'function') throw new DafnyProError('llm function required', 'bad_llm');
    if (typeof deps.dafny !== 'function') throw new DafnyProError('dafny function required', 'bad_dafny');
    this.store = store;
    this.llm = deps.llm;
    this.dafny = deps.dafny;
    this.hintLibrary = Array.isArray(deps.hintLibrary) ? deps.hintLibrary.slice() : [];
    this.maxAttempts = Number.isFinite(deps.maxAttempts) ? deps.maxAttempts : 5;
  }

  async verify(baseCode, spec, options) {
    options = options || {};
    if (typeof baseCode !== 'string' || !baseCode) throw new DafnyProError('baseCode required', 'bad_code');
    if (typeof spec !== 'string' || !spec) throw new DafnyProError('spec required', 'bad_spec');
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : this.maxAttempts;

    const runId = uid('dp');
    const startedAt = nowIso();
    let previousErrors = [];
    let bestAttempt = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const hints = this._retrieveHints(spec, attempt);

      let generated;
      try {
        generated = await this.llm({ spec, baseCode, hints, previousErrors });
      } catch (e) {
        return this._finish(runId, 'llm_failed', {
          attempts: attempt + 1, error: String(e.message || e),
        });
      }

      const annotatedCode = (generated && generated.code) || baseCode;
      const annotations = (generated && generated.annotations) || [];

      const diff = this._checkDiff(baseCode, annotatedCode);
      if (!diff.clean) {
        this._record(runId, attempt, {
          verified: false,
          error_count: 0,
          annotations_json: JSON.stringify(annotations),
          rejected_reason: 'diff_not_clean:' + diff.reason,
        });
        previousErrors = ['diff_not_clean:' + diff.reason];
        continue;
      }

      const pruned = this._prune(annotations);

      let result;
      try {
        result = await this.dafny({
          code: annotatedCode,
          annotations: pruned,
          spec,
          attempt,
        });
      } catch (e) {
        return this._finish(runId, 'dafny_failed', {
          attempts: attempt + 1, error: String(e.message || e),
        });
      }

      const verified = !!(result && result.verified === true);
      const errors = (result && result.errors) || [];

      this._record(runId, attempt, {
        verified,
        error_count: errors.length,
        annotations_json: JSON.stringify(pruned),
        rejected_reason: null,
      });

      if (verified) {
        this._finish(runId, 'verified', { attempts: attempt + 1, annotations: pruned });
        return {
          ok: true,
          status: 'verified',
          runId,
          attempts: attempt + 1,
          annotations: pruned,
          code: annotatedCode,
        };
      }

      bestAttempt = { code: annotatedCode, annotations: pruned, errors };
      previousErrors = errors;
    }

    this._finish(runId, 'exhausted', { attempts: maxAttempts });
    return {
      ok: false,
      status: 'exhausted',
      runId,
      attempts: maxAttempts,
      last_annotations: bestAttempt ? bestAttempt.annotations : [],
    };
  }

  _checkDiff(base, modified) {
    const a = stripAnnotations(base);
    const b = stripAnnotations(modified);
    if (a === b) return { clean: true, reason: null };
    return { clean: false, reason: 'base_logic_changed' };
  }

  _prune(annotations) {
    if (!Array.isArray(annotations) || annotations.length === 0) return [];
    const texts = annotations.map((a) => (typeof a === 'string' ? a : (a && a.text) || ''));
    const kept = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t || t.trim().length === 0) continue;
      const tokens = this._tokens(t);
      let referenced = false;
      for (let j = 0; j < texts.length; j++) {
        if (i === j) continue;
        for (const tok of tokens) {
          if (texts[j].includes(tok)) { referenced = true; break; }
        }
        if (referenced) break;
      }
      if (referenced || tokens.length === 0) kept.push(texts[i]);
    }
    return kept.length > 0 ? kept : texts.slice();
  }

  _tokens(line) {
    const m = String(line).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    return m.filter((t) => !ANNOTATION_TOKENS.includes(t) && t.length > 1);
  }

  _retrieveHints(spec, attempt) {
    const k = Math.min(3 + attempt, this.hintLibrary.length);
    return this.hintLibrary.slice(0, k);
  }

  _record(runId, attempt, data) {
    this.store.dafnyProAttemptsInsert({
      id: uid('dpa'),
      run_id: runId,
      attempt,
      verified: data.verified ? 1 : 0,
      error_count: data.error_count || 0,
      annotations_json: data.annotations_json || null,
      rejected_reason: data.rejected_reason || null,
      created_at: nowIso(),
    });
  }

  _finish(runId, status, extra) {
    extra = extra || {};
    this.store.dafnyProRunsInsert({
      id: runId,
      status,
      attempts: extra.attempts || 0,
      error: extra.error || null,
      spec_hash: hash('dafny-pro:' + runId),
      started_at: nowIso(),
      ended_at: nowIso(),
    });
    return { ok: status === 'verified', status, runId, attempts: extra.attempts || 0 };
  }

  history(filter) { return this.store.dafnyProRunsList(filter || {}); }
  attemptsFor(runId) { return this.store.dafnyProAttemptsList(runId); }
}

module.exports = { DafnyPro, DafnyProError, stripAnnotations, isAnnotationLine };
