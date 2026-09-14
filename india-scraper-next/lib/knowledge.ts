import db from './db';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

const MAX_CONTENT_BYTES = 2_000_000;
const MAX_BULK_URLS = 50;

export type KnowledgeSource = {
  id: number;
  kind: 'url' | 'text';
  url: string | null;
  title: string;
  content: string;
  content_type: string | null;
  collected_at: string;
};

export type CollectedDocument = Pick<KnowledgeSource, 'kind' | 'url' | 'title' | 'content' | 'content_type'>;
export type KnowledgePattern = { id: number; label: string; pattern: string; created_at: string };

function textFromHtml(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const withoutNonContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const content = withoutNonContent
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), content };
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') ||
    host === '0.0.0.0' || host === '::1' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^198\.(1[89])\./.test(host) ||
    /^fc/i.test(host) || /^fd/i.test(host) || /^fe80:/i.test(host);
}

async function resolvePinnedAddress(hostname: string): Promise<string> {
  // Literal addresses have already been rejected; resolve names before every
  // outbound request to avoid accepting a hostname that points at a local RFC1918 address.
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some(({ address }) => isPrivateHost(address))) {
    throw new Error('URL resolves to a private-network address');
  }
  // Pin the real connection to the exact address just validated above, instead
  // of letting the HTTP client re-resolve the hostname a second time. A second,
  // independent lookup would reopen a DNS-rebinding window: a hostile DNS server
  // could return a safe address for this check and a private one moments later
  // for the actual connection.
  return records[0].address;
}

type PinnedResponse = { statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer };

/**
 * Fetches `url` over a socket connected to `address` (not to whatever the
 * hostname happens to resolve to at request time), while still sending the
 * real hostname as the Host header and TLS SNI/cert-check target. Exported
 * so the pinning behaviour itself -- "do I actually connect to the address I
 * was given, and do I enforce the byte cap while streaming rather than after
 * buffering" -- can be tested directly against a local HTTP server without
 * going through the public-address policy check in resolvePinnedAddress.
 */
export function fetchViaAddress(
  url: URL,
  address: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PinnedResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? MAX_CONTENT_BYTES;
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        host: address,
        port,
        path: url.pathname + url.search,
        method: 'GET',
        servername: isHttps ? url.hostname : undefined,
        headers: {
          Host: url.host,
          'User-Agent': 'BrahminiKnowledgeCollector/1.0 (+local collection)',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          res.resume();
          reject(new Error('Redirects are not followed'));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            reject(new Error('Source is larger than 2 MB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

export function validateCollectionUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2_048) throw new Error('A valid URL is required');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('A valid absolute URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (url.username || url.password || isPrivateHost(url.hostname)) throw new Error('Private-network and credential URLs are not allowed');
  return url.toString();
}

export function expandUrlPattern(pattern: unknown, start: unknown, end: unknown): string[] {
  if (typeof pattern !== 'string' || !pattern.includes('{n}')) throw new Error('URL pattern must contain {n}');
  // Validate the surrounding URL without allowing URL normalization to encode
  // the template placeholder before it can be expanded.
  const template = pattern.trim();
  validateCollectionUrl(template.replaceAll('{n}', '0'));
  const first = Number(start);
  const last = Number(end);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last - first + 1 > MAX_BULK_URLS) {
    throw new Error(`Choose an integer range of up to ${MAX_BULK_URLS} URLs`);
  }
  return Array.from({ length: last - first + 1 }, (_, index) => validateCollectionUrl(template.replaceAll('{n}', String(first + index))));
}

export async function collectUrl(rawUrl: unknown): Promise<CollectedDocument> {
  const validated = validateCollectionUrl(rawUrl);
  const url = new URL(validated);
  const address = await resolvePinnedAddress(url.hostname);
  const response = await fetchViaAddress(url, address, { timeoutMs: 15_000, maxBytes: MAX_CONTENT_BYTES });
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Collection failed with HTTP ${response.statusCode}`);
  const rawContentType = response.headers['content-type'];
  const contentType = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType) ?? 'text/plain';
  if (!/(text\/html|text\/plain|application\/json|application\/xml|text\/xml)/i.test(contentType)) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  // The byte cap is already enforced while streaming in fetchViaAddress; this
  // slice is just a final belt-and-suspenders bound on what we hand to the parser.
  const body = response.body.slice(0, MAX_CONTENT_BYTES).toString('utf8');
  const extracted = /text\/html/i.test(contentType) ? textFromHtml(body) : { title: '', content: body.trim() };
  if (!extracted.content) throw new Error('Source did not contain collectable text');
  return { kind: 'url', url: validated, title: extracted.title || url.hostname, content: extracted.content, content_type: contentType };
}

export function saveSource(source: CollectedDocument): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO knowledge_sources (kind, url, title, content, content_type)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, url) DO UPDATE SET title = excluded.title, content = excluded.content, content_type = excluded.content_type, collected_at = CURRENT_TIMESTAMP`,
      [source.kind, source.url, source.title.slice(0, 500), source.content, source.content_type],
      (error) => error ? reject(error) : resolve(),
    );
  });
}

export function savePattern(label: string, pattern: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO knowledge_patterns (label, pattern) VALUES (?, ?)
       ON CONFLICT(pattern) DO UPDATE SET label = excluded.label`,
      [label.slice(0, 200), pattern],
      (error) => error ? reject(error) : resolve(),
    );
  });
}

export function getSources(): Promise<KnowledgeSource[]> {
  return new Promise((resolve, reject) => db.all(
    `SELECT id, kind, url, title, content, content_type, collected_at FROM knowledge_sources ORDER BY collected_at DESC LIMIT 200`,
    (error, rows) => error ? reject(error) : resolve(rows as KnowledgeSource[]),
  ));
}

export function getPatterns(): Promise<KnowledgePattern[]> {
  return new Promise((resolve, reject) => db.all(
    `SELECT id, label, pattern, created_at FROM knowledge_patterns ORDER BY created_at DESC LIMIT 100`,
    (error, rows) => error ? reject(error) : resolve(rows as KnowledgePattern[]),
  ));
}
