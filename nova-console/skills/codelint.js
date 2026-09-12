'use strict';
/* ===========================================================================
 * NOVA Runtime — Code Lint skill (Phase 3, real implementation)
 *
 * Runs inside the sandboxed skill worker. Walks real files via the real
 * list_directory/read_file MCP tools (injected by the runner, gated by
 * whatever approval policy mcp_fs is set to) and applies a few honest,
 * minimal line-based checks. This is NOT a real JS parser/AST linter —
 * it's intentionally simple — but every finding is computed from real file
 * content fetched through a real tool call, not fabricated.
 * ========================================================================= */

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const MAX_LINE_LENGTH = 120;
const MAX_FILES = 40;
const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);

function extname(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i) : '';
}

async function walk(tools, dir, out) {
  if (out.length >= MAX_FILES) return;
  let listing;
  try { listing = await tools.list_directory({ path: dir }); }
  catch (e) { return; } // unreadable dir — skip, not a hard failure
  const text = (listing.content && listing.content[0] && listing.content[0].text) || '';
  if (text === '(empty directory)') return;
  for (const line of text.split('\n')) {
    if (out.length >= MAX_FILES) return;
    const m = line.match(/^\[(dir|file)\]\s+(.+)$/);
    if (!m) continue;
    const name = m[2];
    if (SKIP_DIRS.has(name)) continue;
    const full = dir === '.' ? name : dir + '/' + name;
    if (m[1] === 'dir') await walk(tools, full, out);
    else if (DEFAULT_EXTENSIONS.includes(extname(name))) out.push(full);
  }
}

async function run(inputs, tools) {
  const paths = (inputs && Array.isArray(inputs.paths) && inputs.paths.length) ? inputs.paths : ['.'];
  const files = [];
  for (const p of paths) await walk(tools, p, files);

  const findings = [];
  for (const file of files) {
    let content;
    try {
      const res = await tools.read_file({ path: file });
      content = (res.content && res.content[0] && res.content[0].text) || '';
    } catch (e) { continue; }
    content.split('\n').forEach((line, i) => {
      if (line.length > MAX_LINE_LENGTH) {
        findings.push({ file, line: i + 1, rule: 'max-line-length', detail: 'Line is ' + line.length + ' chars (limit ' + MAX_LINE_LENGTH + ')' });
      }
      if (/console\.log\(/.test(line)) {
        findings.push({ file, line: i + 1, rule: 'no-console', detail: 'console.log(...) left in source' });
      }
      if (/[ \t]+$/.test(line)) {
        findings.push({ file, line: i + 1, rule: 'no-trailing-whitespace', detail: 'Trailing whitespace' });
      }
    });
  }
  return { filesScanned: files.length, findings };
}

module.exports = { run };
