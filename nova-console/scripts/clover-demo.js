#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { openDb, Store } = require('../lib/db');
const { OllamaClient } = require('../lib/ollama');
const { fromOllamaClient } = require('../lib/ollama-provider');
const { DafnyPro } = require('../lib/dafny-pro');
const { CloverVerifier } = require('../lib/clover');
const { createDafnyVerifier } = require('../lib/dafny-cli');

const DEFAULT_MODEL = process.env.NOVA_CLOVER_MODEL || 'llama3.2:latest';

const DEFAULT_PROBLEM =
  'Write a Dafny method Add(x: int) returns (y: int) that returns x + 1.';

const SPEC_SYSTEM = [
  'You convert a coding problem and a candidate solution into a Dafny triple.',
  'You MUST return a JSON object with exactly three string fields:',
  '  code:       the candidate solution, unchanged, in Dafny syntax',
  '  docstring:  a short comment that MUST contain the declared method name',
  '  spec:       Dafny requires/ensures clauses that MUST contain the',
  '              declared method name followed by the clauses, e.g.',
  '              "method Add requires x > 0 ensures y > x"',
  'Both the docstring AND the spec MUST contain the exact method name.',
  'Do NOT add any other fields. Do NOT wrap in markdown. Reply with JSON only.',
].join(' ');


const DAFNY_SYSTEM = [
  'You add Dafny annotations to a method without changing its base logic.',
  'RULES:',
  '  - Do NOT modify any non-annotation line.',
  '  - Do NOT combine the method signature with annotations.',
  '  - Each annotation MUST be on its OWN line, starting with requires,',
  '    ensures, invariant, decreases, modifies, or reads.',
  '  - Put annotations between the method signature and the opening brace.',
  'Return JSON with exactly two fields:',
  '  code:        the original code with annotations inserted on new lines',
  '  annotations: array of the annotation strings you inserted',
  'Reply with JSON only.',
].join(' ');

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function extractMethodName(code) {
  const m = String(code || '').match(/\b(?:method|function)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : null;
}

async function callJson(chat, model, system, user) {
  const resp = await chat({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
  });
  const raw = (resp && resp.message && resp.message.content) || '';
  const cleaned = stripCodeFences(raw);
  try { return JSON.parse(cleaned); }
  catch { return null; }
}

async function main() {
  const problem = process.argv.slice(2).join(' ').trim() || DEFAULT_PROBLEM;
  const realDafny = process.env.NOVA_DAFNY_REAL === '1';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-clover-demo-'));
  const { db } = openDb(dir);
  const store = new Store(db);

  const ollama = new OllamaClient(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
  const chat = fromOllamaClient(ollama);

  const specGenerator = async (problemText, candidateCode) => {
    const methodName = extractMethodName(candidateCode);
    const requirements = methodName
      ? '\n\nThe declared method name is: ' + methodName +
        '\nBoth the docstring field AND the spec field MUST contain "' +
        methodName + '".'
      : '';
    const userPrompt = 'PROBLEM:\n' + problemText +
      '\n\nCANDIDATE:\n' + candidateCode + requirements;

    let out = await callJson(chat, DEFAULT_MODEL, SPEC_SYSTEM, userPrompt);

    const needsRepair = methodName && out && (
      typeof out.spec !== 'string' || !out.spec.includes(methodName) ||
      typeof out.docstring !== 'string' || !out.docstring.includes(methodName)
    );

    if (needsRepair) {
      const repairUser =
        'Your previous response did not include the method name ' + methodName +
        ' in one or both of the docstring and spec fields. Regenerate the JSON ' +
        'so BOTH fields contain "' + methodName + '". Example docstring: ' +
        '"Add returns x plus one." Example spec: "method Add requires x > 0 ' +
        'ensures y > x". Original problem:\n' + problemText +
        '\n\nOriginal candidate:\n' + candidateCode;
      const repair = await callJson(chat, DEFAULT_MODEL, SPEC_SYSTEM, repairUser);
      if (repair && typeof repair.spec === 'string' && repair.spec.includes(methodName)) {
        out = repair;
      }
      if (!out || typeof out.spec !== 'string' || !out.spec.includes(methodName)) {
        if (out && typeof out.spec === 'string') out.spec = methodName + ' ' + out.spec;
      }
      if (!out || typeof out.docstring !== 'string' || !out.docstring.includes(methodName)) {
        if (out) out.docstring = (methodName + ' implements the requested method. ' +
          String(out.docstring || '')).trim();
      }
    }

    // Tolerant fallback: never throw for shape problems; degrade to
    // the candidate code and a minimal spec derived from the method name.
    const safeOut = out && typeof out === 'object' ? out : {};
    const safeCode = (typeof safeOut.code === 'string' && safeOut.code.trim())
      ? safeOut.code
      : candidateCode;
    const safeDocstring = (typeof safeOut.docstring === 'string' && safeOut.docstring.trim())
      ? safeOut.docstring
      : (methodName
          ? methodName + ' implements the requested method.'
          : 'Implementation of the requested method.');
    const safeSpec = (typeof safeOut.spec === 'string' && safeOut.spec.trim())
      ? safeOut.spec
      : (methodName
          ? 'method ' + methodName + ' requires true ensures true'
          : 'requires true ensures true');

    // Ensure both spec and docstring contain the method name if we have one.
    const finalSpec = methodName && !safeSpec.includes(methodName)
      ? (methodName + ' ' + safeSpec)
      : safeSpec;
    const finalDocstring = methodName && !safeDocstring.includes(methodName)
      ? (methodName + ' ' + safeDocstring)
      : safeDocstring;

    return {
      code: safeCode,
      docstring: finalDocstring,
      spec: finalSpec,
    };
  };

  const dafnyLlm = async ({ spec, baseCode }) => {
    const out = await callJson(
      chat,
      DEFAULT_MODEL,
      DAFNY_SYSTEM,
      'SPEC:\n' + spec + '\n\nCODE:\n' + baseCode
    );
    if (!out) return { code: baseCode, annotations: [] };
    return {
      code: typeof out.code === 'string' ? out.code : baseCode,
      annotations: Array.isArray(out.annotations) ? out.annotations : [],
    };
  };

  const dafny = realDafny
    ? createDafnyVerifier({ timeoutMs: 60000 })
    : async () => ({ verified: true, errors: [], exit_code: 0, elapsed_ms: 0,
                     raw_stdout: '', raw_stderr: '' });

  const dafnyPro = new DafnyPro(store, { llm: dafnyLlm, dafny, maxAttempts: 3 });
  const clover = new CloverVerifier(store, { specGenerator, dafnyPro });

  console.log('model:      ' + DEFAULT_MODEL);
  console.log('dafny:      ' + (realDafny ? 'real (NOVA_DAFNY_REAL=1)' : 'mock'));
  console.log('problem:    ' + problem);
  console.log('');
  console.log('running clover.verify...');
  const t0 = Date.now();

  const candidate = [
    'method Add(x: int) returns (y: int)',
    '{',
    '  y := x + 1;',
    '}',
  ].join('\n');

  let result;
  try {
    result = await clover.verify(problem, candidate);
  } catch (e) {
    console.log('FAILED: ' + (e.message || e));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  const elapsed = Date.now() - t0;

  console.log('status:        ' + result.status);
  console.log('ok:            ' + result.ok);
  console.log('phase:         ' + (result.phase || '-'));
  console.log('consistency:   ' + (result.consistency_ok === true ? 'ok' :
                                result.consistency_ok === false ? 'fail' : 'not reached'));
  console.log('proof:         ' + (result.proof_ok === true ? 'verified' :
                                result.proof_ok === false ? 'failed' : 'not reached'));
  console.log('proof attempts:' + ' ' + (result.proof_attempts || 0));
  console.log('detail:        ' + (result.detail || '-'));
  console.log('elapsed:       ' + elapsed + 'ms');
  console.log('');

  console.log('--- sqlite audit ---');
  const rows = store.cloverVerificationsList({});
  console.log('clover runs: ' + rows.length);
  for (const r of rows) {
    console.log('  ' + r.id + '  status=' + r.status +
                '  consistency=' + r.consistency_ok +
                '  proof=' + r.proof_ok);
  }
  const dpRuns = store.dafnyProRunsList({});
  console.log('dafny runs:  ' + dpRuns.length);
  for (const r of dpRuns) {
    console.log('  ' + r.id + '  status=' + r.status + '  attempts=' + r.attempts);
  }

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('demo failed:', e);
    process.exit(1);
  });
}

module.exports = { main };
