'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const VERIFY_CMD = 'verify';
const TIMELIMIT_FLAG = '--verification-time-limit';
const DEFAULT_JSON_FLAG = '--json-output';
const MAX_CAPTURE_BYTES = 256 * 1024;
const TRUNCATE_MARKER = '...[truncated]';

class DafnyCliError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DafnyCliError';
    this.code = code || 'dafny_cli_error';
  }
}

function composeSource(input) {
  input = input || {};
  const parts = [];
  if (input.spec) parts.push(String(input.spec).trimEnd());
  if (Array.isArray(input.annotations) && input.annotations.length > 0) {
    parts.push(input.annotations.map((a) => (typeof a === 'string' ? a : String(a || ''))).join('\n'));
  }
  if (input.code) parts.push(String(input.code).trimEnd());
  return parts.join('\n\n') + '\n';
}

function tempFilePath(tmpDir) {
  const rand = crypto.randomBytes(6).toString('hex');
  return path.join(tmpDir, `nova-dafny-${Date.now()}-${rand}.dfy`);
}

function capString(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_CAPTURE_BYTES) return s;
  return s.slice(0, MAX_CAPTURE_BYTES) + TRUNCATE_MARKER;
}

function tryParseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function tryParseJsonLines(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { return null; }
  }
  return out;
}

function isVerifiedSignal(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.verified === true) return true;
  if (obj.success === true) return true;
  if (obj.outcome === 'correct' || obj.outcome === 'verified') return true;
  if (obj.result === 'verified' || obj.result === 'correct') return true;
  return false;
}

function isFailureSignal(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.verified === false) return true;
  if (obj.success === false) return true;
  const o = obj.outcome || obj.result || obj.status;
  if (typeof o === 'string' && /fail|error|invalid|incorrect/.test(o)) return true;
  return false;
}

function collectMessages(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  for (const k of ['message', 'error', 'reason']) {
    const v = obj[k];
    if (typeof v === 'string' && v) out.push(v);
  }
  return out;
}

function parseDafnyJson(stdout) {
  if (typeof stdout !== 'string') return { verified: null, errors: [] };

  let parsed = tryParseJson(stdout);
  if (parsed == null) parsed = tryParseJsonLines(stdout);
  if (parsed == null) return { verified: null, errors: [] };

  let objects = [];
  if (Array.isArray(parsed)) {
    objects = parsed;
  } else if (parsed && typeof parsed === 'object') {
    objects = [parsed];
    for (const key of ['results', 'verificationResults', 'diagnostics']) {
      if (Array.isArray(parsed[key])) objects = objects.concat(parsed[key]);
    }
  }

  let verified = null;
  const errors = [];
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    if (isVerifiedSignal(obj)) verified = true;
    if (isFailureSignal(obj)) {
      if (verified == null) verified = false;
      errors.push(...collectMessages(obj));
    }
  }
  return { verified, errors };
}

function createDafnyVerifier(options) {
  options = options || {};
  const bin = options.bin || process.env.NOVA_DAFNY_BIN || 'dafny';
  const jsonFlag = options.jsonFlag || process.env.NOVA_DAFNY_JSON_FLAG || DEFAULT_JSON_FLAG;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000;
  const tmpDir = options.tmpDir || os.tmpdir();
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs.slice() : [];

  return async function dafny(input) {
    if (!input || typeof input !== 'object') {
      throw new DafnyCliError('input object required', 'bad_input');
    }

    const composed = composeSource(input);
    const tmpFile = tempFilePath(tmpDir);
    try {
      fs.writeFileSync(tmpFile, composed, 'utf8');
    } catch (e) {
      throw new DafnyCliError('cannot write temp file: ' + (e.message || e), 'fs_error');
    }

    const args = [
      VERIFY_CMD,
      jsonFlag,
      TIMELIMIT_FLAG,
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      tmpFile,
    ].concat(extraArgs);

    const startedAt = Date.now();

    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
      throw new DafnyCliError('spawn failed: ' + (e.message || e), 'spawn_failed');
    }

    return await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;
      let killGraceTimer = null;

      const wallclockTimer = setTimeout(() => {
        killedByTimeout = true;
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        killGraceTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, 2000);
        if (killGraceTimer && typeof killGraceTimer.unref === 'function') killGraceTimer.unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_CAPTURE_BYTES + 1024) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_CAPTURE_BYTES + 1024) stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(wallclockTimer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
        reject(new DafnyCliError('spawn failed: ' + (err.message || err), 'spawn_failed'));
      });

      child.on('close', (code) => {
        clearTimeout(wallclockTimer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        try { fs.unlinkSync(tmpFile); } catch { /* noop */ }

        const cappedOut = capString(stdout);
        const cappedErr = capString(stderr);
        const elapsed_ms = Date.now() - startedAt;

        if (killedByTimeout) {
          resolve({
            verified: false,
            errors: ['dafny_timeout'],
            raw_stdout: cappedOut,
            raw_stderr: cappedErr,
            exit_code: null,
            elapsed_ms,
          });
          return;
        }

        const parsed = parseDafnyJson(cappedOut);

        if (code === 0) {
          resolve({
            verified: true,
            errors: parsed.errors || [],
            raw_stdout: cappedOut,
            raw_stderr: cappedErr,
            exit_code: 0,
            elapsed_ms,
          });
          return;
        }

        const fallback = (cappedErr || cappedOut || ('dafny exited with code ' + code)).slice(0, 400);
        const errors = (parsed.errors && parsed.errors.length > 0) ? parsed.errors : [fallback];

        resolve({
          verified: false,
          errors,
          raw_stdout: cappedOut,
          raw_stderr: cappedErr,
          exit_code: typeof code === 'number' ? code : null,
          elapsed_ms,
        });
      });
    });
  };
}

module.exports = { DafnyCliError, createDafnyVerifier, parseDafnyJson };
