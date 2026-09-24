'use strict';
/* ===========================================================================
 * NOVA Runtime — real skill manifest schema + validator (Phase 3)
 *
 * A real JSON Schema (draft-07 syntax) for the skill manifest shape this
 * project actually uses, plus a minimal hand-rolled validator that really
 * checks values against it. ajv isn't installable here (same
 * registry-blocked constraint as the rest of Phase 3 — see
 * lib/mcp-manager.js's header), so this covers the subset of JSON Schema
 * the manifests actually need — type, required, properties, items,
 * minLength, enum — rather than full draft-07 compliance. That's an honest
 * scope limit, documented here rather than silently assumed.
 * ========================================================================= */

const SKILL_MANIFEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'NOVA skill manifest',
  type: 'object',
  required: ['entrypoint', 'inputs', 'outputs'],
  properties: {
    entrypoint: { type: 'string', minLength: 1 },
    inputs: { type: 'array', items: { type: 'string' } },
    outputs: { type: 'array', items: { type: 'string' } },
    requiredTools: { type: 'array', items: { type: 'string' } },
    requiredHost: { type: 'array', items: { type: 'string', enum: ['readSession', 'generate'] } },
    timeoutMs: { type: 'integer' },
  },
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Validates `value` against `schema`. Returns an array of error strings
 *  (empty = valid). Covers: type (incl. "integer"), required, properties,
 *  items, minLength, enum — recursively. */
function validate(schema, value, path) {
  path = path || '$';
  const errors = [];
  if (schema.type) {
    const actual = typeOf(value);
    const expected = schema.type;
    const ok = expected === 'integer' ? (actual === 'number' && Number.isInteger(value)) : actual === expected;
    if (!ok) { errors.push(path + ': expected type "' + expected + '", got "' + actual + '"'); return errors; }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(path + ': value ' + JSON.stringify(value) + ' is not one of ' + JSON.stringify(schema.enum));
  }
  if (schema.type === 'string' && schema.minLength != null && (value || '').length < schema.minLength) {
    errors.push(path + ': string shorter than minLength ' + schema.minLength);
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const req of (schema.required || [])) {
      if (!(req in value)) errors.push(path + ': missing required property "' + req + '"');
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (value[key] !== undefined) errors.push(...validate(subSchema, value[key], path + '.' + key));
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, path + '[' + i + ']')));
  }
  return errors;
}

function validateManifest(manifest) {
  const errors = validate(SKILL_MANIFEST_SCHEMA, manifest || {});
  return { valid: errors.length === 0, errors };
}

module.exports = { SKILL_MANIFEST_SCHEMA, validateManifest };
