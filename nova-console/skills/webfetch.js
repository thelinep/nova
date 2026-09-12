'use strict';
/* ===========================================================================
 * NOVA Runtime — Web Fetch skill (Phase 5, real implementation)
 *
 * Runs inside the sandboxed skill worker (lib/skill-worker.js) via Node's
 * own global fetch — a real HTTP request leaves the machine when this
 * runs, which is exactly why server.js gates this one skill specifically:
 * it refuses to even start the worker unless the workspace's own
 * Settings > Privacy > "Allow network access" preference is on (see
 * REQUIRES_NETWORK handling around REAL_SKILL_IDS in server.js). That gate
 * lives outside this file on purpose — a skill module shouldn't be trusted
 * to enforce the boundary on itself.
 *
 * Honest scope note: this blocks the obvious SSRF targets (loopback,
 * link-local, and RFC1918 private ranges, by literal hostname/IP pattern)
 * and caps response size and redirects, but it is not DNS-rebind-proof —
 * a hostname that only resolves to a private address after this check
 * would slip through. A real production fetch tool would resolve DNS
 * itself and check the resulting IP, not just the URL's hostname string;
 * flagged here rather than silently assumed away.
 * ========================================================================= */

const MAX_BYTES = 512 * 1024; // 512KB cap on the body actually read
const FETCH_TIMEOUT_MS = 10000;

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^::1$/, /^\[::1\]$/,
  /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('"' + raw + '" is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed, got ' + u.protocol);
  }
  const host = u.hostname;
  if (BLOCKED_HOSTNAME_PATTERNS.some(re => re.test(host))) {
    throw new Error('Refusing to fetch "' + host + '" — it resolves to a local/private address, not the open web');
  }
  return u;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function run(inputs) {
  const url = inputs && inputs.url;
  if (!url || !String(url).trim()) throw new Error('webfetch requires a non-empty "url" input');
  const safeUrl = assertSafeUrl(String(url).trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(safeUrl, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'NOVA-Runtime-WebFetch/1.0' } });
  } catch (e) {
    throw new Error('Fetch failed: ' + (e.message || String(e)));
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get('content-type') || '';
  const reader = res.body ? res.body.getReader() : null;
  let bytes = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) { controller.abort(); break; }
      chunks.push(value);
    }
  }
  const raw = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  const isHtml = /text\/html/i.test(contentType);
  const text = isHtml ? stripTags(raw) : raw;

  return {
    url: safeUrl.toString(),
    statusCode: res.status,
    contentType,
    bytesRead: bytes,
    truncated: bytes >= MAX_BYTES,
    text: text.slice(0, 4000),
  };
}

module.exports = { run };
