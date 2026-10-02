'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Playwright is loaded only when a page is opened, so NOVA starts without it.
// The source folder has the full `playwright` package; the desktop app ships
// only `playwright-core` and drives the Chrome (or Edge, Brave, Chromium)
// already installed on this computer.
let playwrightCache;
function loadPlaywright() {
  if (playwrightCache === undefined) {
    playwrightCache = null;
    for (const name of ['playwright', 'playwright-core']) {
      try { playwrightCache = { name, module: require(name) }; break; } catch (_) {}
    }
  }
  return playwrightCache ? playwrightCache.module : null;
}
function systemBrowser() {
  if (process.env.NOVA_AGENT_CHROME) return process.env.NOVA_AGENT_CHROME;
  try { return require('./image-to-code').findBrowser(); } catch (_) { return null; }
}
function available() { return Boolean(loadPlaywright()) && Boolean(systemBrowser() || (playwrightCache && playwrightCache.name === 'playwright')); }
/** What the agent browser would run with, for the status line and the support report. */
function engine() {
  const pw = loadPlaywright();
  const browser = systemBrowser();
  return {
    available: available(),
    disabled: process.env.NOVA_BROWSER === '0',
    library: playwrightCache ? playwrightCache.name : null,
    browser: browser ? path.basename(browser) : (pw && playwrightCache.name === 'playwright' ? 'Playwright Chromium' : null),
  };
}
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function cleanDomain(value) {
  let d = String(value || '').trim().toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(d)) d = new URL(d).hostname; } catch (_) {}
  d = d.replace(/^\*\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)*)$/.test(d) || d.length > 253) throw new BrowserError('That is not a website address. Use a name such as example.com.', 400);
  return d;
}

// ---------- error classes ----------
class BrowserError extends Error {
  constructor(message, statusCode, policyId) {
    super(message);
    this.name = 'BrowserError';
    this.statusCode = statusCode || 400;
    this.browser = true;
    this.policyId = policyId;
  }
}

class DisabledError extends BrowserError {
  constructor(policyId) {
    super('Browser service is disabled.', 503, policyId);
    this.name = 'DisabledError';
  }
}

class HaltedError extends BrowserError {
  constructor(policyId) {
    super('Browser kill switch is active.', 423, policyId);
    this.name = 'HaltedError';
  }
}

class PolicyDeniedError extends BrowserError {
  constructor(message, policyId) {
    super(message || 'Denied by policy.', 403, policyId);
    this.name = 'PolicyDeniedError';
  }
}

class PageNotFoundError extends BrowserError {
  constructor() {
    super('Unknown open browser page.', 404);
    this.name = 'PageNotFoundError';
  }
}

// ---------- helpers ----------
const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

function agent(value) {
  const v = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(v)) {
    throw new BrowserError('Invalid agent id.', 400);
  }
  return v;
}

function domain(url) {
  return new URL(url).hostname.toLowerCase();
}

// ---------- service ----------
class BrowserService {
  constructor(store, dataDir, security) {
    this.store = store;
    this.dataDir = dataDir;
    this.security = security;
    this.pages = new Map();
  }

  policy(input, agentId) {
    input = input || {};
    return {
      id: String(input.id || input.policyId || 'browser-default'),
      agentId,
      grants: new Set(
        (input.grants || input.domains || []).map((x) => String(x).toLowerCase())
      ),
      secretsRead: input.secretsRead === true,
      secretDomains: new Set(
        (input.secretDomains || []).map((x) => String(x).toLowerCase())
      ),
    };
  }

  audit(action, data) {
    if (this.security && this.security.appendAudit) {
      this.security.appendAudit(this.dataDir, {
        action: `browser.${action}`,
        timestamp: now(),
        ...data,
      });
    }
  }

  action(pageId, policyId, kind, result, selector, payload) {
    this.store.browserAction({
      id: uid('browser_action'),
      pageId,
      kind,
      result,
      policyId,
      timestamp: now(),
      selectorHash: selector ? hash(selector) : null,
      payloadHash: payload == null ? null : hash(payload),
    });
    this.audit(kind, { pageId, policyId, result });
  }

  enabled(policyId) {
    if (process.env.NOVA_BROWSER === '0') throw new DisabledError(policyId);
    if (this.store.getGlobalHalt() === '1') throw new HaltedError(policyId);
  }

  egress(pageId, url, policy, reason) {
    let name;
    try {
      name = domain(url);
    } catch {
      return false;
    }
    const allowed = this.domainAllowed(name, policy);
    this.store.browserEgress({
      id: uid('browser_egress'),
      pageId,
      domain: name,
      allowed,
      reason,
      timestamp: now(),
    });
    this.audit('egress', {
      pageId,
      policyId: policy.id,
      domain: name,
      allowed,
      reason,
    });
    return allowed;
  }

  /** example.com on the list also allows www.example.com and cdn.example.com. */
  domainAllowed(name, policy) {
    const has = (d) => this.store.egressAllowed(d) || Boolean(policy && policy.grants.has(d));
    const host = String(name).toLowerCase();
    if (/^[\d.]+$|^\[/.test(host) || !host.includes('.')) return has(host); // addresses and single names: exact only
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) if (has(parts.slice(i).join('.'))) return true;
    return false;
  }

  /** Opening internet pages follows Settings > Privacy > Allow network access; this computer's own pages do not. */
  networkCheck(url, policyId) {
    let host; try { host = domain(url); } catch (_) { throw new BrowserError('That is not a web address.', 400, policyId); }
    if (LOOPBACK.has(host)) return;
    const prefs = (() => { try { return this.store.get('preferences', 'default'); } catch (_) { return null; } })();
    if (!prefs || !prefs.webAccess) throw new BrowserError('The agent browser needs network access. Turn on Settings > Privacy > Allow network access, then try again.', 403, policyId);
  }

  allowlist() {
    return this.store.egressAllowlist().map((r) => ({ domain: r.domain, addedAt: r.added_at, addedBy: r.added_by }));
  }

  allowDomain(value, addedBy) {
    const d = cleanDomain(value);
    this.store.allowEgress(d, String(addedBy || 'console').slice(0, 80));
    this.audit('allowlist.add', { domain: d, by: addedBy || 'console' });
    return { ok: true, domain: d, allowlist: this.allowlist() };
  }

  removeDomain(value, by) {
    const d = cleanDomain(value);
    this.store.removeEgress(d);
    this.audit('allowlist.remove', { domain: d, by: by || 'console' });
    return { ok: true, domain: d, allowlist: this.allowlist() };
  }

  /** Engine, kill switch and open pages, for the Agent Browser screen. */
  status() {
    return {
      ...engine(),
      halted: this.store.getGlobalHalt() === '1',
      networkAccess: Boolean((() => { try { return (this.store.get('preferences', 'default') || {}).webAccess; } catch (_) { return false; } })()),
      openPages: [...this.pages.values()].map((e) => ({ pageId: e.id, agentId: e.agentId, url: (() => { try { return e.page.url(); } catch (_) { return null; } })(), title: e.title || null })),
    };
  }

  /** Recent pages, actions and blocked addresses, newest first. */
  log(limit = 60) {
    const n = Math.max(1, Math.min(500, Number(limit) || 60));
    return {
      pages: this.store.browserRecentPages(n),
      actions: this.store.browserRecentActions(n),
      blocked: this.store.browserRecentEgress(n, false),
    };
  }

  /** Closes every agent page without halting the rest of NOVA. */
  async closeAll() {
    let closed = 0;
    for (const [pageId, e] of [...this.pages]) {
      try { await e.context.close(); } catch (_) {}
      this.pages.delete(pageId);
      this.store.browserUpdatePage(pageId, { closed_at: now(), status: 'closed' });
      this.action(pageId, e.policy.id, 'close', 'ok');
      closed++;
    }
    return { ok: true, closed };
  }

  shotFile(name) {
    const base = path.resolve(this.dataDir, 'browser-evidence');
    const file = path.resolve(base, String(name));
    if (!file.startsWith(base + path.sep) || !file.endsWith('.png') || !fs.existsSync(file)) throw new PageNotFoundError();
    return file;
  }

  entry(pageId) {
    const e = this.pages.get(pageId);
    if (!e) throw new PageNotFoundError();
    return e;
  }

  profile(agentId) {
    const root = path.resolve(this.dataDir, 'browser-profiles', agentId);
    const parent = path.resolve(this.dataDir, 'browser-profiles');
    if (!root.startsWith(parent + path.sep)) {
      throw new BrowserError('Unsafe profile path.');
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    return root;
  }

  async capture(e, requestedPath) {
    this.enabled(e.policy.id);
    const png = await e.page.screenshot({ fullPage: true, type: 'png' });
    this.enabled(e.policy.id);

    const base = path.resolve(this.dataDir, 'browser-evidence', e.id);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });

    // Screenshots are kept only in NOVA's own evidence folder.
    const target = requestedPath
      ? path.resolve(base, path.basename(String(requestedPath)).replace(/[^\w.-]/g, '_').replace(/(\.png)?$/i, '.png'))
      : path.join(base, `${Date.now()}.png`);

    if (!target.startsWith(base + path.sep)) {
      throw new BrowserError('Unsafe screenshot path.', 400, e.policy.id);
    }

    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, png, { mode: 0o600 });
    fs.renameSync(tmp, target);

    const sha256 = crypto.createHash('sha256').update(png).digest('hex');
    this.store.browserUpdatePage(e.id, {
      final_url: e.page.url(),
      screenshot_path: target,
      sha256,
      status: 'open',
    });
    this.action(e.id, e.policy.id, 'screenshot', 'ok', null, sha256);
    try { e.title = await e.page.title(); } catch (_) {}
    e.lastImage = path.relative(path.resolve(this.dataDir, 'browser-evidence'), target).split(path.sep).join('/');
    return { path: target, sha256, url: e.page.url(), title: e.title || null, image: path.relative(path.resolve(this.dataDir, 'browser-evidence'), target).split(path.sep).join('/') };
  }

  async open(url, options) {
    options = options || {};
    const agentId = agent(options.agentId || options.profile);
    const policy = this.policy(options.policy, agentId);
    this.enabled(policy.id);

    if (!this.egress(null, url, policy, 'open')) {
      throw new PolicyDeniedError('Egress denied by policy.', policy.id);
    }
    this.networkCheck(url, policy.id);

    const pw = loadPlaywright();
    if (!pw) throw new BrowserError('The agent browser needs Playwright, which this copy of Maataa does not include. Rebuild the app with Build NOVA app.command, or run npm install in nova-console.', 503, policy.id);
    const executablePath = systemBrowser() || undefined;
    if (!executablePath && playwrightCache.name !== 'playwright') throw new BrowserError('The agent browser uses the Chrome on this computer. Install Google Chrome (or Edge, Brave or Chromium) and try again.', 503, policy.id);
    const context = await pw.chromium.launchPersistentContext(
      this.profile(agentId),
      {
        executablePath,
        headless: process.env.NOVA_BROWSER_HEADFUL !== '1',
        acceptDownloads: true,
        serviceWorkers: 'block',
        args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--use-mock-keychain', '--password-store=basic'],
      }
    );

    const page = await context.newPage();
    const pageId = uid('browser_page');
    const e = { id: pageId, context, page, agentId, policy };
    this.pages.set(pageId, e);

    await page.route('**/*', (r) =>
      this.egress(pageId, r.request().url(), policy, 'route')
        ? r.continue()
        : r.abort('blockedbyclient')
    );

    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) {
        this.action(pageId, policy.id, 'navigate', 'ok', null, f.url());
      }
    });

    this.store.browserInsertPage({
      id: pageId,
      agentId,
      url,
      finalUrl: url,
      policyId: policy.id,
      openedAt: now(),
      status: 'open',
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.capture(e);
    } catch (error) {
      this.pages.delete(pageId);
      await context.close();
      this.store.browserUpdatePage(pageId, {
        status: 'failed',
        final_url: url,
      });
      throw error;
    }

    return { ok: true, pageId, url: page.url(), title: e.title || null, image: e.lastImage || null, policy_id: policy.id };
  }

  async click(pageId, selector) {
    const e = this.entry(pageId);
    this.enabled(e.policy.id);
    await e.page.click(selector);
    await e.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.capture(e);
    this.action(pageId, e.policy.id, 'click', 'ok', selector);
    return { ok: true, url: e.page.url(), title: e.title || null, image: e.lastImage || null, policy_id: e.policy.id };
  }

  async type(pageId, selector, text) {
    const e = this.entry(pageId);
    this.enabled(e.policy.id);

    const typeAttr = await e.page.locator(selector).getAttribute('type');
    const isPassword = typeAttr === 'password';
    const host = domain(e.page.url());

    if (isPassword) {
      const allowed =
        e.policy.secretsRead &&
        e.policy.secretDomains.has(host) &&
        this.store.egressAllowed(host);
      if (!allowed) {
        this.action(pageId, e.policy.id, 'type_denied', 'denied', selector);
        throw new PolicyDeniedError(
          'Credential entry is denied by policy.',
          e.policy.id
        );
      }
    }

    await e.page.fill(selector, String(text));
    this.action(pageId, e.policy.id, 'type', 'ok', selector, text);
    return { ok: true, policy_id: e.policy.id };
  }

  async read(pageId, options) {
    options = options || {};
    const e = this.entry(pageId);
    this.enabled(e.policy.id);
    const text = await e.page.locator(options.selector || 'body').innerText();
    this.action(pageId, e.policy.id, 'read', 'ok', options.selector);
    return {
      ok: true,
      text,
      html: options.content ? await e.page.content() : undefined,
      policy_id: e.policy.id,
    };
  }

  async wait(pageId, options) {
    options = options || {};
    const e = this.entry(pageId);
    this.enabled(e.policy.id);
    const timeout = Math.min(15000, Number(options.ms) || 15000);
    if (options.selector) {
      await e.page.waitForSelector(options.selector, { timeout });
    } else {
      await e.page.waitForTimeout(Math.min(15000, Number(options.ms) || 0));
    }
    this.action(pageId, e.policy.id, 'wait', 'ok', options.selector, options.ms);
    return { ok: true, policy_id: e.policy.id };
  }

  async screenshot(pageId, options) {
    options = options || {};
    const e = this.entry(pageId);
    const shot = await this.capture(e, options.path);
    return { ok: true, ...shot, policy_id: e.policy.id };
  }

  async download(pageId, options) {
    options = options || {};
    const e = this.entry(pageId);
    this.enabled(e.policy.id);

    if (!options.approve || !options.selector || !options.path) {
      throw new PolicyDeniedError(
        'Download needs explicit approval, selector, and path.',
        e.policy.id
      );
    }

    const [dl] = await Promise.all([
      e.page.waitForEvent('download'),
      e.page.click(options.selector),
    ]);
    const target = path.resolve(options.path);
    await dl.saveAs(target);
    this.action(pageId, e.policy.id, 'download', 'ok', options.selector, target);
    return { ok: true, path: target, policy_id: e.policy.id };
  }

  async upload(pageId, options) {
    options = options || {};
    const e = this.entry(pageId);
    this.enabled(e.policy.id);

    if (!options.approve || !options.selector || !options.path) {
      throw new PolicyDeniedError(
        'Upload needs explicit approval, selector, and path.',
        e.policy.id
      );
    }

    await e.page
      .locator(options.selector)
      .setInputFiles(path.resolve(options.path));
    if (options.submitSelector) {
      await e.page.click(options.submitSelector);
    }
    this.action(
      pageId,
      e.policy.id,
      'upload',
      'ok',
      options.selector,
      options.path
    );
    return { ok: true, policy_id: e.policy.id };
  }

  async close(pageId) {
    const e = this.entry(pageId);
    await e.context.close();
    this.pages.delete(pageId);
    this.store.browserUpdatePage(pageId, {
      closed_at: now(),
      status: 'closed',
    });
    this.action(pageId, e.policy.id, 'close', 'ok');
    return { ok: true, policy_id: e.policy.id };
  }

  async halt() {
    this.store.setGlobalHalt('1');
    for (const [pageId, e] of this.pages) {
      await e.context.close();
      this.pages.delete(pageId);
      this.store.browserUpdatePage(pageId, {
        closed_at: now(),
        status: 'halted',
      });
      this.action(pageId, e.policy.id, 'halt', 'ok');
    }
    return { ok: true };
  }

  list(agentId) {
    return { ok: true, pages: this.store.browserPages(agent(agentId)) };
  }

  listAll() {
    return { ok: true, pages: this.store.browserRecentPages(200) };
  }

  async shutdown() {
    for (const e of this.pages.values()) {
      await e.context.close();
    }
    this.pages.clear();
  }
}

module.exports = {
  BrowserService,
  BrowserError,
  DisabledError,
  HaltedError,
  available,
  engine,
  cleanDomain,
  PolicyDeniedError,
  PageNotFoundError,
};