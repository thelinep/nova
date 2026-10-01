#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * NOVA help builder — one source, three outputs.
 *
 * Source:  docs/help/*.md   (articles, faq.md, troubleshooting.md)
 * Outputs: public/help/help.json      the in-app Help Center (Help & Support view)
 *          docs/site/                 an offline docs site (open docs/site/index.html)
 *          docs/NOVA_USER_GUIDE.md    the whole guide as one Markdown file
 *
 * Zero dependencies, like the rest of NOVA: a small Markdown renderer lives
 * below. It supports what the help files use: headings, paragraphs, bold,
 * italic, code, fenced code, lists (two levels), tables, links, images,
 * "> **Tip**" callouts, and two NOVA extensions:
 *   @screen media/file.jpg "Caption"    a screenshot figure
 *   @video  media/file.mp4 "Caption"    a short screen recording
 * Links written as (help:article-id) or (help:article-id#anchor) point at
 * another article; the Help Center opens it in place, the site links the page.
 *
 * Run: node scripts/build-help.js   (also: npm run help:build)
 * ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'help');
const MEDIA_DIR = path.join(ROOT, 'public', 'help', 'media');
const JSON_OUT = path.join(ROOT, 'public', 'help', 'help.json');
const SITE = path.join(ROOT, 'docs', 'site');
const GUIDE = path.join(ROOT, 'docs', 'NOVA_USER_GUIDE.md');

const SECTIONS = ['Getting started', 'Chat and knowledge', 'Create', 'Capabilities', 'Oversight', 'Local Workspace', 'Operations', 'Desktop app', 'Help and support'];

/* ------------------------------------------------------------------ markdown */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = s => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9ऀ-ॿ]+/g, '-').replace(/^-|-$/g, '');

/** Inline Markdown. `link(href)` rewrites help: links and media paths for the target. */
function inline(text, ctx) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${esc(ctx.media(src))}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const h = href.replace(/&amp;/g, '&');
    if (h.startsWith('help:')) { const [id, anchor] = h.slice(5).split('#'); return ctx.helpLink(id, anchor, label); }
    const ext = /^https?:/.test(h);
    return `<a href="${esc(h)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

function renderMarkdown(md, ctx) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const headings = [];
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), ctx)}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const level = m[1].length, text = m[2].trim(), id = slug(text);
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(text, ctx)}</h${level}>`);
      i++; continue;
    }
    if ((m = line.match(/^@(screen|video)\s+(\S+)(?:\s+"([^"]*)")?\s*$/))) {
      flush();
      const src = esc(ctx.media(m[2])), cap = m[3] ? inline(m[3], ctx) : '';
      if (ctx.hasMedia(m[2])) {
        out.push(m[1] === 'screen'
          ? `<figure class="help-fig"><img src="${src}" alt="${esc(m[3] || '')}" loading="lazy">${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`
          : `<figure class="help-fig"><video src="${src}" controls muted playsinline preload="metadata"></video>${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`);
      }
      i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${inline(h, ctx)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      const text = buf.join(' ');
      const kind = /^\*\*(Warning|Important)\*\*/i.test(text) ? 'warn' : 'tip';
      out.push(`<div class="help-callout ${kind}">${inline(text, ctx)}</div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const l = lines[i];
        const indent = l.match(/^\s*/)[0].length;
        const text = l.replace(/^\s*([-*]|\d+\.)\s+/, '');
        if (indent >= 2 && items.length && /^\s*([-*]|\d+\.)\s+/.test(l)) items[items.length - 1].kids.push({ text, ordered: /^\s*\d+\./.test(l) });
        else if (indent >= 2 && items.length) items[items.length - 1].text += ' ' + l.trim();
        else items.push({ text, kids: [] });
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(it => `<li>${inline(it.text, ctx)}${it.kids.length ? `<${it.kids[0].ordered ? 'ol' : 'ul'}>${it.kids.map(k => `<li>${inline(k.text, ctx)}</li>`).join('')}</${it.kids[0].ordered ? 'ol' : 'ul'}>` : ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return { html: out.join('\n'), headings };
}

const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ sources */

function frontMatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Splits "## Group / ### Question / answer" files (FAQ, troubleshooting). */
function qaEntries(body, ctx) {
  const entries = [];
  let group = 'General', cur = null;
  const push = () => { if (cur) { const { html } = renderMarkdown(cur.body.join('\n'), ctx); entries.push({ id: slug(cur.q), group: cur.group, q: cur.q, html, text: plain(html) }); } };
  for (const line of body.split('\n')) {
    let m;
    if ((m = line.match(/^##\s+(.*)$/))) { push(); cur = null; group = m[1].trim(); continue; }
    if ((m = line.match(/^###\s+(.*)$/))) { push(); cur = { group, q: m[1].trim(), body: [] }; continue; }
    if (cur) cur.body.push(line);
  }
  push();
  return entries;
}

function load(target) {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.md')).sort();
  const media = new Set(fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR) : []);
  const ids = new Set(files.filter(f => !['faq.md', 'troubleshooting.md'].includes(f)).map(f => frontMatter(fs.readFileSync(path.join(SRC, f), 'utf8'), f).meta.id));
  const missingLinks = [];
  const ctx = {
    media: src => (src.startsWith('media/') ? target.mediaPrefix + src.slice(6) : src),
    hasMedia: src => !src.startsWith('media/') || media.has(src.slice(6)),
    helpLink: (id, anchor, label) => {
      if (!ids.has(id) && !['faq', 'troubleshooting', 'support'].includes(id)) missingLinks.push(id);
      return target.helpLink(id, anchor, label);
    },
  };
  const articles = [];
  let faq = [], troubleshooting = [];
  for (const f of files) {
    const { meta, body } = frontMatter(fs.readFileSync(path.join(SRC, f), 'utf8'), f);
    if (f === 'faq.md') { faq = qaEntries(body, ctx); continue; }
    if (f === 'troubleshooting.md') { troubleshooting = qaEntries(body, ctx); continue; }
    for (const k of ['id', 'title', 'section']) if (!meta[k]) throw new Error(`${f}: front matter needs "${k}"`);
    if (!SECTIONS.includes(meta.section)) throw new Error(`${f}: unknown section "${meta.section}"`);
    const { html, headings } = renderMarkdown(body, ctx);
    articles.push({
      id: meta.id, title: meta.title, section: meta.section, order: Number(meta.order || 50), summary: meta.summary || '',
      views: (meta.views || '').split(',').map(s => s.trim()).filter(Boolean), keywords: meta.keywords || '',
      html, headings: headings.filter(h => h.level === 2).map(({ text, id }) => ({ text, id })), text: plain(html), md: body.trim(),
    });
  }
  articles.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.order - b.order || a.title.localeCompare(b.title));
  if (missingLinks.length) throw new Error('Links to unknown articles: ' + [...new Set(missingLinks)].join(', '));
  return { articles, faq, troubleshooting, mediaCount: media.size };
}

/* ------------------------------------------------------------------ outputs */

/** How links and media are written for the in-app Help Center (public/help/help.json). */
const JSON_TARGET = {
  mediaPrefix: '/help/media/',
  helpLink: (id, anchor, label) => `<a href="#help/${esc(id)}${anchor ? '/' + esc(anchor) : ''}" data-help-link="${esc(id)}"${anchor ? ` data-help-anchor="${esc(anchor)}"` : ''}>${label}</a>`,
};

function buildJson() {
  const data = load(JSON_TARGET);
  const viewMap = {};
  for (const a of data.articles) for (const v of a.views) if (!viewMap[v]) viewMap[v] = a.id;
  const json = {
    version: 1, builtAt: new Date().toISOString(), sections: SECTIONS.filter(s => data.articles.some(a => a.section === s)),
    articles: data.articles.map(({ md, ...a }) => a), faq: data.faq, troubleshooting: data.troubleshooting, viewMap,
  };
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(json));
  return { json, data };
}

const SITE_CSS = `
:root{--bg:#0b0e13;--panel:#121620;--panel2:#171c27;--line:#262d3a;--ink:#eef1f5;--dim:#c3cad4;--muted:#8b96a6;--amber:#f3a73e;--amber-soft:#f3a73e1f;--blue:#5fa8e0;--red:#e2645c;
  --ui:"Work Sans",-apple-system,"Segoe UI",sans-serif;--mono:"Space Mono","SF Mono",Menlo,monospace;color-scheme:dark}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--panel2:#f0f2f5;--line:#dde1e7;--ink:#141a22;--dim:#2f3844;--muted:#5d6878;--amber:#b86e07;--amber-soft:#f3a73e22;--blue:#1f6fae;--red:#b53a33;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:15px/1.65 var(--ui)}
a{color:var(--blue)}a:hover{text-decoration:underline}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:10px 20px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:700;letter-spacing:.02em;color:var(--ink);text-decoration:none}.brand span{color:var(--amber)}
.top nav{display:flex;gap:14px;flex-wrap:wrap}.top nav a{color:var(--dim);text-decoration:none;font-size:14px}.top nav a.on{color:var(--amber)}
.search{margin-left:auto;position:relative}.search input{width:260px;max-width:40vw;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
.results{position:absolute;right:0;top:40px;width:min(440px,90vw);max-height:60vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 14px 40px #0007;display:none}
.results a{display:block;padding:9px 12px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}.results a small{display:block;color:var(--muted)}
.layout{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1180px;margin:0 auto;gap:28px;padding:24px 20px 60px}
.layout.solo{grid-template-columns:minmax(0,1fr);max-width:1000px}
.side{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 80px);overflow:auto;font-size:14px}
.side h4{margin:16px 0 6px;font:11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.side a{display:block;padding:3px 8px;border-radius:6px;color:var(--dim);text-decoration:none}.side a.on{background:var(--amber-soft);color:var(--ink)}
article{min-width:0;max-width:780px}article h1{font-size:30px;line-height:1.2;margin:0 0 6px;text-wrap:balance}.lede{color:var(--muted);margin:0 0 22px;font-size:16px}
article h2{margin:34px 0 8px;font-size:21px;padding-top:6px;border-top:1px solid var(--line)}article h3{margin:24px 0 6px;font-size:17px}
code{font:13px var(--mono);background:var(--panel2);padding:1px 5px;border-radius:4px}pre{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:12px 14px;overflow:auto}pre code{background:none;padding:0}
.table-wrap{overflow-x:auto;margin:12px 0}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
.help-fig{margin:18px 0}.help-fig img,.help-fig video{display:block;max-width:100%;border:1px solid var(--line);border-radius:10px}.help-fig figcaption{color:var(--muted);font-size:13px;margin-top:6px}
.help-callout{border-left:3px solid var(--amber);background:var(--amber-soft);padding:10px 14px;border-radius:0 8px 8px 0;margin:14px 0}.help-callout.warn{border-color:var(--red);background:#e2645c1a}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin:14px 0 30px}.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;color:var(--ink);text-decoration:none}.card:hover{border-color:var(--amber);text-decoration:none}.card small{display:block;color:var(--muted);margin-top:4px;font-size:13px}
details{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}summary{cursor:pointer;font-weight:600}details[open] summary{margin-bottom:6px}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:40px;padding-top:16px;border-top:1px solid var(--line)}
.foot{color:var(--muted);font-size:13px;text-align:center;padding:30px 20px}
@media (max-width:820px){.layout{grid-template-columns:minmax(0,1fr);padding:16px}.side{position:static;max-height:none}.search input{width:160px}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;

const SITE_JS = `(function(){var q=document.getElementById('q'),box=document.getElementById('results');if(!q||!window.NOVA_HELP_INDEX)return;
function run(){var t=q.value.trim().toLowerCase();if(t.length<2){box.style.display='none';return}var words=t.split(/\\s+/);
var hits=NOVA_HELP_INDEX.map(function(e){var s=0,title=e.t.toLowerCase(),body=e.b.toLowerCase(),keys=(e.k||'').toLowerCase();words.forEach(function(w){if(title.indexOf(w)>=0)s+=5;if(keys.indexOf(w)>=0)s+=2;if(body.indexOf(w)>=0)s+=1});return[s,e]}).filter(function(x){return x[0]>=words.length}).sort(function(a,b){return b[0]-a[0]}).slice(0,12);
box.innerHTML=hits.length?hits.map(function(h){var e=h[1],i=Math.max(0,e.b.toLowerCase().indexOf(words[0]));var snip=e.b.slice(Math.max(0,i-40),i+90);return '<a href="'+e.u+'">'+e.t.replace(/</g,'&lt;')+'<small>'+e.s+' · …'+snip.replace(/</g,'&lt;')+'…</small></a>'}).join(''):'<a>No matches</a>';box.style.display='block'}
q.addEventListener('input',run);q.addEventListener('keydown',function(e){if(e.key==='Escape'){q.value='';run()}});document.addEventListener('click',function(e){if(!box.contains(e.target)&&e.target!==q)box.style.display='none'})})();`;

function page({ title, body, nav, active, articles }) {
  const side = nav ? `<aside class="side">${SECTIONS.filter(s => articles.some(a => a.section === s)).map(s => `<h4>${esc(s)}</h4>${articles.filter(a => a.section === s).map(a => `<a href="${a.id}.html"${active === a.id ? ' class="on"' : ''}>${esc(a.title)}</a>`).join('')}`).join('')}<h4>More</h4><a href="faq.html"${active === 'faq' ? ' class="on"' : ''}>FAQ</a><a href="troubleshooting.html"${active === 'troubleshooting' ? ' class="on"' : ''}>Troubleshooting</a><a href="support.html"${active === 'support' ? ' class="on"' : ''}>Get support</a></aside>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · NOVA Help</title><link rel="stylesheet" href="help.css"><link rel="icon" href="../../public/favicon.svg"></head><body>
<header class="top"><a class="brand" href="index.html">NOVA <span>Help</span></a><nav><a href="index.html"${active === 'home' ? ' class="on"' : ''}>Guides</a><a href="faq.html"${active === 'faq' ? ' class="on"' : ''}>FAQ</a><a href="troubleshooting.html"${active === 'troubleshooting' ? ' class="on"' : ''}>Troubleshooting</a><a href="support.html"${active === 'support' ? ' class="on"' : ''}>Support</a></nav><div class="search"><input id="q" type="search" placeholder="Search help…" aria-label="Search help"><div id="results" class="results"></div></div></header>
<div class="layout${nav ? '' : ' solo'}">${side}<main>${body}</main></div>
<div class="foot">NOVA Runtime · generated from docs/help — the same guides are in NOVA under Help &amp; Support.</div>
<script src="search-index.js"></script><script src="search.js"></script></body></html>`;
}

function buildSite() {
  const data = load({
    mediaPrefix: '../../public/help/media/',
    helpLink: (id, anchor, label) => `<a href="${esc(id)}.html${anchor ? '#' + esc(anchor) : ''}">${label}</a>`,
  });
  fs.mkdirSync(SITE, { recursive: true });
  for (const f of fs.readdirSync(SITE)) if (f.endsWith('.html')) fs.unlinkSync(path.join(SITE, f));
  fs.writeFileSync(path.join(SITE, 'help.css'), SITE_CSS.trim() + '\n');
  fs.writeFileSync(path.join(SITE, 'search.js'), SITE_JS + '\n');
  const { articles, faq, troubleshooting } = data;
  const index = [
    ...articles.map(a => ({ t: a.title, s: a.section, u: a.id + '.html', k: a.keywords, b: a.summary + ' ' + a.text })),
    ...faq.map(f => ({ t: f.q, s: 'FAQ', u: 'faq.html#' + f.id, b: f.text })),
    ...troubleshooting.map(f => ({ t: f.q, s: 'Troubleshooting', u: 'troubleshooting.html#' + f.id, b: f.text })),
  ];
  fs.writeFileSync(path.join(SITE, 'search-index.js'), 'window.NOVA_HELP_INDEX=' + JSON.stringify(index) + ';\n');
  const home = `<article><h1>NOVA Help</h1><p class="lede">Guides for every part of NOVA, answers to common questions, and what to do when something goes wrong. Everything NOVA does runs on your computer.</p>
${SECTIONS.filter(s => articles.some(a => a.section === s)).map(s => `<h2>${esc(s)}</h2><div class="cards">${articles.filter(a => a.section === s).map(a => `<a class="card" href="${a.id}.html">${esc(a.title)}<small>${esc(a.summary)}</small></a>`).join('')}</div>`).join('')}
<h2>More help</h2><div class="cards"><a class="card" href="faq.html">Frequently asked questions<small>${faq.length} short answers</small></a><a class="card" href="troubleshooting.html">Troubleshooting<small>Problems and fixes, by area</small></a><a class="card" href="support.html">Get support<small>Make a support report and what to include</small></a></div></article>`;
  fs.writeFileSync(path.join(SITE, 'index.html'), page({ title: 'Guides', body: home, nav: false, active: 'home', articles }));
  articles.forEach((a, i) => {
    const prev = articles[i - 1], next = articles[i + 1];
    const body = `<article><h1>${esc(a.title)}</h1>${a.summary ? `<p class="lede">${esc(a.summary)}</p>` : ''}${a.html}
<div class="pager">${prev ? `<a href="${prev.id}.html">← ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a href="${next.id}.html">${esc(next.title)} →</a>` : ''}</div></article>`;
    fs.writeFileSync(path.join(SITE, a.id + '.html'), page({ title: a.title, body, nav: true, active: a.id, articles }));
  });
  const qa = (list, title, lede) => {
    const groups = [...new Set(list.map(f => f.group))];
    return `<article><h1>${title}</h1><p class="lede">${lede}</p>${groups.map(g => `<h2 id="${slug(g)}">${esc(g)}</h2>${list.filter(f => f.group === g).map(f => `<details id="${f.id}"><summary>${esc(f.q)}</summary>${f.html}</details>`).join('')}`).join('')}</article>
<script>if(location.hash){var d=document.getElementById(location.hash.slice(1));if(d&&d.tagName==='DETAILS'){d.open=true;d.scrollIntoView()}}</script>`;
  };
  fs.writeFileSync(path.join(SITE, 'faq.html'), page({ title: 'FAQ', body: qa(faq, 'Frequently asked questions', 'Short answers to the questions people ask most.'), nav: true, active: 'faq', articles }));
  fs.writeFileSync(path.join(SITE, 'troubleshooting.html'), page({ title: 'Troubleshooting', body: qa(troubleshooting, 'Troubleshooting', 'Find the symptom, then follow the fix. Open Diagnostics in NOVA first: it tells you which part is not working.'), nav: true, active: 'troubleshooting', articles }));
  const support = articles.find(a => a.id === 'support');
  fs.writeFileSync(path.join(SITE, 'support.html'), page({ title: 'Get support', body: `<article><h1>Get support</h1>${support ? support.html : ''}</article>`, nav: true, active: 'support', articles }));
  return data;
}

function buildGuide(data) {
  const md = [
    '# NOVA Runtime user guide', '',
    '<!-- Generated by scripts/build-help.js from docs/help/*.md. Edit those files, then run `npm run help:build`. -->', '',
    'NOVA Runtime is a local AI workspace: chat with local models, search your documents, make images, video and audio, run skills, tools, agents and workflows, and change code in folders you approve. Everything runs on your computer. The same guide is inside NOVA under **Help & Support**, and as pages in `docs/site/`.', '',
    '## Contents', '',
    ...data.articles.map(a => `- [${a.title}](#${slug(a.title)})`), '- [Troubleshooting](#troubleshooting)', '- [Frequently asked questions](#frequently-asked-questions)', '',
  ];
  const demote = body => body.replace(/^(#{2,3})\s/gm, (_, h) => '#' + h + ' ').replace(/\(help:([\w-]+)(?:#[\w-]+)?\)/g, (_, id) => { const a = data.articles.find(x => x.id === id); return `(#${slug(a ? a.title : id)})`; }).replace(/^@(screen|video)\s+media\/(\S+)(?:\s+"([^"]*)")?\s*$/gm, (_, kind, f, cap) => kind === 'screen' ? `![${cap || f}](../public/help/media/${f})` : `[Video: ${cap || f}](../public/help/media/${f})`);
  for (const a of data.articles) md.push(`## ${a.title}`, '', a.summary ? `*${a.summary}*` : '', '', demote(a.md), '');
  const qa = (title, list) => { md.push(`## ${title}`, ''); let g = null; for (const f of list) { if (f.group !== g) { g = f.group; md.push(`### ${g}`, ''); } md.push(`#### ${f.q}`, '', plainMd(f.html), ''); } };
  qa('Troubleshooting', data.troubleshooting);
  qa('Frequently asked questions', data.faq);
  fs.writeFileSync(GUIDE, md.join('\n').replace(/\n{3,}/g, '\n\n'));
}
function plainMd(html) {
  return html.replace(/<li>/g, '- ').replace(/<\/(p|li|h\d)>/g, '\n').replace(/<code>([^<]*)<\/code>/g, '`$1`').replace(/<strong>([^<]*)<\/strong>/g, '**$1**').replace(/<a href="#help\/([\w-]+)[^"]*"[^>]*>([^<]*)<\/a>/g, '$2').replace(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g, '[$2]($1)').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
}

function main() {
  const { json } = buildJson();
  const data = buildSite();
  buildGuide(data);
  const media = fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR).length : 0;
  console.log(`Help built: ${json.articles.length} articles, ${json.faq.length} FAQ, ${json.troubleshooting.length} troubleshooting entries, ${media} media files.`);
  console.log(`  ${path.relative(ROOT, JSON_OUT)} · ${path.relative(ROOT, SITE)}/index.html · ${path.relative(ROOT, GUIDE)}`);
}

module.exports = { JSON_TARGET, renderMarkdown, qaEntries, frontMatter, slug, SECTIONS, load };
if (require.main === module) main();
