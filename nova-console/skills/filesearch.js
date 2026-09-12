'use strict';
/* ===========================================================================
 * NOVA Runtime — Repo File Search skill (Phase 3, real implementation)
 *
 * Runs inside the sandboxed skill worker. Searches real file contents
 * under the fs-server's sandboxed root via the real search_files MCP tool.
 * ========================================================================= */

async function run(inputs, tools) {
  const query = inputs && inputs.query;
  if (!query || !String(query).trim()) {
    throw new Error('filesearch requires a non-empty "query" input');
  }
  const scope = (inputs && inputs.scope) || '.';
  const res = await tools.search_files({ pattern: query, path: scope });
  const text = (res.content && res.content[0] && res.content[0].text) || '';
  const matches = text.startsWith('No matches') ? [] : text.split('\n').filter(Boolean);
  return { query, scope, matches };
}

module.exports = { run };
