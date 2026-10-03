'use strict';

/**
 * Strict boundary between model output and Maataa's workspace change-batch API.
 * This module validates data only: it never reads or writes project files.
 */

const SCHEMA = 'maataa.coding-change-set';
const VERSION = 1;
const OPERATIONS = new Set(['edit', 'create', 'delete', 'rename', 'overwrite']);
const PROTECTED_SEGMENTS = new Set([
  '.git', 'node_modules', 'target', '.next', 'dist', 'build', 'coverage', '.cache',
]);

const LIMITS = Object.freeze({
  outputBytes: 4 * 1024 * 1024,
  changes: 50,
  summaryBytes: 1000,
  pathBytes: 1024,
  contentBytes: 1024 * 1024,
  findBytes: 1024 * 1024,
  replacementBytes: 1024 * 1024,
  impactBytes: 1000,
  dependencyCount: 50,
});

class CodingAgentResultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CodingAgentResultError';
    this.code = code || 'invalid_coding_agent_result';
  }
}

function fail(message, code) {
  throw new CodingAgentResultError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Unknown field "${key}" in ${where}.`, 'unknown_field');
  }
}

function boundedString(value, name, maxBytes, options) {
  options = options || {};
  if (typeof value !== 'string') fail(`${name} must be a string.`, 'bad_field_type');
  if (options.nonEmpty && !value.trim()) fail(`${name} must not be empty.`, 'empty_field');
  if (value.includes('\0')) fail(`${name} must not contain NUL bytes.`, 'bad_string');
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail(`${name} exceeds the ${maxBytes}-byte limit.`, 'size_limit');
  }
  return value;
}

function validateProjectPath(value, name) {
  const relativePath = boundedString(value, name, LIMITS.pathBytes, { nonEmpty: true });
  // Require portable, canonical slash-separated relative paths. Reject rather
  // than normalize ambiguous forms so review and eventual application agree.
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[a-z]:/i.test(relativePath)) {
    fail(`${name} must be project-relative.`, 'unsafe_path');
  }
  if (relativePath.includes('\\')) fail(`${name} must use forward-slash separators.`, 'unsafe_path');
  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail(`${name} contains an empty or traversing path segment.`, 'unsafe_path');
  }
  if (segments.some(segment => PROTECTED_SEGMENTS.has(segment))) {
    fail(`${name} targets a protected project folder.`, 'unsafe_path');
  }
  if (segments.some(segment => /[\u0001-\u001f\u007f]/.test(segment))) {
    fail(`${name} contains a control character.`, 'unsafe_path');
  }
  return relativePath;
}

function optionalStringField(source, key, maxBytes, where, options) {
  if (!Object.hasOwn(source, key)) return undefined;
  return boundedString(source[key], `${where}.${key}`, maxBytes, options);
}

function validateChange(raw, index) {
  const where = `changes[${index}]`;
  if (!isRecord(raw)) fail(`${where} must be an object.`, 'bad_change');
  if (typeof raw.operation !== 'string' || !OPERATIONS.has(raw.operation)) {
    fail(`${where}.operation must be one of: ${[...OPERATIONS].join(', ')}.`, 'bad_operation');
  }
  const operation = raw.operation;
  const allowed = new Set(['operation', 'relativePath']);
  if (operation === 'edit') for (const key of ['find', 'replacement']) allowed.add(key);
  if (operation === 'create' || operation === 'overwrite') allowed.add('content');
  if (operation === 'rename') allowed.add('toPath');
  allowed.add('impact');
  allowed.add('dependsOn');
  exactKeys(raw, allowed, where);

  const result = {
    operation,
    relativePath: validateProjectPath(raw.relativePath, `${where}.relativePath`),
  };
  if (operation === 'edit') {
    result.find = boundedString(raw.find, `${where}.find`, LIMITS.findBytes, { nonEmpty: true });
    result.replacement = boundedString(raw.replacement, `${where}.replacement`, LIMITS.replacementBytes);
  } else if (operation === 'create' || operation === 'overwrite') {
    result.content = boundedString(raw.content, `${where}.content`, LIMITS.contentBytes);
  } else if (operation === 'rename') {
    result.toPath = validateProjectPath(raw.toPath, `${where}.toPath`);
    if (result.toPath === result.relativePath) fail(`${where}.toPath must differ from relativePath.`, 'bad_change');
  }

  if (Object.hasOwn(raw, 'impact')) {
    result.impact = boundedString(raw.impact, `${where}.impact`, LIMITS.impactBytes);
  }
  if (Object.hasOwn(raw, 'dependsOn')) {
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > LIMITS.dependencyCount) {
      fail(`${where}.dependsOn must be an array of at most ${LIMITS.dependencyCount} paths.`, 'bad_dependencies');
    }
    result.dependsOn = raw.dependsOn.map((item, depIndex) =>
      validateProjectPath(item, `${where}.dependsOn[${depIndex}]`));
  }
  return result;
}

/** Accept a JSON string or an already decoded object; never recover JSON from prose/fences. */
function parseCodingAgentResult(input) {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > LIMITS.outputBytes) {
      fail(`Model output exceeds the ${LIMITS.outputBytes}-byte limit.`, 'size_limit');
    }
    try {
      value = JSON.parse(input);
    } catch {
      fail('Model output must be one complete JSON object without surrounding prose or Markdown fences.', 'invalid_json');
    }
  } else if (!isRecord(input)) {
    fail('Model output must be a JSON object.', 'bad_result');
  }

  if (!isRecord(value)) fail('Model output must be a JSON object.', 'bad_result');
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { fail('Model output must be a serializable JSON object.', 'bad_result'); }
  if (typeof serialized !== 'string') fail('Model output must be a serializable JSON object.', 'bad_result');
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.outputBytes) {
    fail(`Model output exceeds the ${LIMITS.outputBytes}-byte limit.`, 'size_limit');
  }
  exactKeys(value, new Set(['schema', 'version', 'summary', 'changes']), 'result');
  if (value.schema !== SCHEMA) fail(`schema must be "${SCHEMA}".`, 'bad_schema');
  if (value.version !== VERSION) fail(`version must be ${VERSION}.`, 'bad_version');
  const summary = boundedString(value.summary, 'summary', LIMITS.summaryBytes, { nonEmpty: true });
  if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > LIMITS.changes) {
    fail(`changes must contain between 1 and ${LIMITS.changes} operations.`, 'bad_changes');
  }

  const changes = value.changes.map(validateChange);
  const touchedPaths = new Set();
  for (const change of changes) {
    const paths = change.operation === 'rename'
      ? [change.relativePath, change.toPath]
      : [change.relativePath];
    for (const touched of paths) {
      if (touchedPaths.has(touched)) fail(`A project path may appear only once in a change set: ${touched}`, 'duplicate_path');
      touchedPaths.add(touched);
    }
  }
  return { schema: SCHEMA, version: VERSION, summary, changes };
}

/** Convert a validated result to the input shape consumed by workspaceChanges.createBatch. */
function toWorkspaceBatchInput(result, rootId) {
  const validated = parseCodingAgentResult(result);
  if (typeof rootId !== 'string' || !rootId.trim()) fail('rootId is required to create a workspace batch.', 'bad_root_id');
  return {
    rootId: rootId.trim(),
    summary: validated.summary,
    changes: validated.changes.map(change => ({ ...change })),
  };
}

module.exports = {
  SCHEMA,
  VERSION,
  LIMITS,
  CodingAgentResultError,
  parseCodingAgentResult,
  toWorkspaceBatchInput,
};
