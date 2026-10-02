'use strict';
/* ===========================================================================
 * NOVA Runtime — starter templates for new local projects
 *
 * Each template is a plain map of relative path -> file content, with
 * {{name}} and {{title}} placeholders. Nothing here downloads anything.
 * Every template ships a working `npm test` that runs on Node's built-in
 * test runner, so the controlled `test` command works before any package
 * is installed. Templates marked needsInstall declare dependencies that a
 * later, separately approved install step has to fetch before dev/build.
 * ========================================================================= */

const GITIGNORE = 'node_modules/\ndist/\n.next/\ncoverage/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n';

function pkg(fields) { return JSON.stringify({ name: '{{name}}', version: '0.1.0', private: true, ...fields }, null, 2) + '\n'; }

const GREETING_ESM = `export function greeting(name) {
  const who = String(name || '').trim() || 'world';
  return \`Hello, \${who}!\`;
}
`;
const GREETING_TEST_ESM = (from) => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from '${from}';

test('greets by name', () => {
  assert.equal(greeting('Nova'), 'Hello, Nova!');
});

test('falls back to world for empty input', () => {
  assert.equal(greeting('  '), 'Hello, world!');
});
`;

const TEMPLATES = {
  'node-api': {
    label: 'Node API',
    description: 'A dependency-free JSON API on node:http with a health route and tests.',
    needsInstall: false,
    files: {
      'package.json': pkg({ description: '{{title}}', type: 'commonjs', main: 'src/server.js', scripts: { start: 'node src/server.js', dev: 'node --watch src/server.js', test: 'node --test' }, engines: { node: '>=20' } }),
      'src/app.js': `'use strict';

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Request handler, kept separate from listen() so tests can mount it. */
function app(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: '{{name}}' });
  if (req.method === 'GET' && url.pathname === '/api/hello') return send(res, 200, { message: 'Hello, ' + (url.searchParams.get('name') || 'world') + '!' });
  return send(res, 404, { error: 'Not found' });
}

module.exports = { app };
`,
      'src/server.js': `'use strict';
const http = require('node:http');
const { app } = require('./app');

const port = Number(process.env.PORT) || 3000;
http.createServer(app).listen(port, '127.0.0.1', () => {
  console.log('{{name}} listening on http://127.0.0.1:' + port);
});
`,
      'test/app.test.js': `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../src/app');

async function withServer(fn) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn('http://127.0.0.1:' + server.address().port); }
  finally { server.close(); }
}

test('health route reports ok', () => withServer(async base => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: '{{name}}' });
}));

test('hello route greets by name', () => withServer(async base => {
  const res = await fetch(base + '/api/hello?name=Nova');
  assert.equal((await res.json()).message, 'Hello, Nova!');
}));

test('unknown routes return 404', () => withServer(async base => {
  assert.equal((await fetch(base + '/missing')).status, 404);
}));
`,
      '.gitignore': GITIGNORE,
      'README.md': '# {{title}}\n\nA small JSON API created with Maataa.\n\n```bash\nnpm start   # http://127.0.0.1:3000/health\nnpm test\n```\n',
    },
  },

  'static-site': {
    label: 'Static website',
    description: 'HTML, CSS and JavaScript with a local preview server and a build step. No dependencies.',
    needsInstall: false,
    files: {
      'package.json': pkg({ description: '{{title}}', type: 'commonjs', scripts: { start: 'node scripts/serve.js', dev: 'node scripts/serve.js', build: 'node scripts/build.js', test: 'node --test' }, engines: { node: '>=20' } }),
      'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{title}}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>{{title}}</h1>
    <p id="message">Loading...</p>
  </main>
  <script src="main.js"></script>
</body>
</html>
`,
      'styles.css': `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { max-width: 40rem; padding: 2rem; }
`,
      'main.js': `document.getElementById('message').textContent = 'Edit main.js to get started.';
`,
      'scripts/serve.js': `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const port = Number(process.env.PORT) || 5173;

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('Preview at http://127.0.0.1:' + port));
`,
      'scripts/build.js': `'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const file of ['index.html', 'styles.css', 'main.js']) fs.copyFileSync(path.join(root, file), path.join(out, file));
console.log('Built to dist/');
`,
      'test/site.test.js': `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('index.html links only to files that exist', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(root, ref)), ref + ' is missing');
});

test('page has a title', () => {
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<title>[^<]+<\\/title>/);
});
`,
      '.gitignore': GITIGNORE,
      'README.md': '# {{title}}\n\nA static website created with Maataa.\n\n```bash\nnpm start       # preview at http://127.0.0.1:5173\nnpm run build   # copies the site to dist/\nnpm test\n```\n',
    },
  },

  'vite-react': {
    label: 'React app (Vite)',
    description: 'A React single-page app built with Vite. Needs npm install before dev or build.',
    needsInstall: true,
    files: {
      'package.json': pkg({ description: '{{title}}', type: 'module', scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build', preview: 'vite preview --host 127.0.0.1', test: 'node --test' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0' } }),
      'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{title}}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`,
      'vite.config.js': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()] });
`,
      'src/main.jsx': `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
`,
      'src/App.jsx': `import { useState } from 'react';
import { greeting } from './greeting.js';

export default function App() {
  const [name, setName] = useState('');
  return (
    <main>
      <h1>{{title}}</h1>
      <label>Your name <input value={name} onChange={e => setName(e.target.value)} /></label>
      <p>{greeting(name)}</p>
    </main>
  );
}
`,
      'src/greeting.js': GREETING_ESM,
      'src/styles.css': `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
main { max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
`,
      'test/greeting.test.js': GREETING_TEST_ESM('../src/greeting.js'),
      '.gitignore': GITIGNORE,
      'README.md': '# {{title}}\n\nA React app created with Maataa.\n\n```bash\nnpm install\nnpm run dev     # http://127.0.0.1:5173\nnpm run build\nnpm test        # works before install\n```\n',
    },
  },

  'nextjs': {
    label: 'Next.js app',
    description: 'A Next.js App Router project in JavaScript. Needs npm install before dev or build.',
    needsInstall: true,
    files: {
      'package.json': pkg({ description: '{{title}}', type: 'module', scripts: { dev: 'next dev -H 127.0.0.1', build: 'next build', start: 'next start -H 127.0.0.1', test: 'node --test' }, dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' } }),
      'next.config.mjs': `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`,
      'app/layout.jsx': `import './globals.css';

export const metadata = { title: '{{title}}' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      'app/page.jsx': `import { greeting } from '../lib/greeting.js';

export default function Home() {
  return (
    <main>
      <h1>{{title}}</h1>
      <p>{greeting('Next.js')}</p>
    </main>
  );
}
`,
      'app/globals.css': `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
main { max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
`,
      'lib/greeting.js': GREETING_ESM,
      'test/greeting.test.js': GREETING_TEST_ESM('../lib/greeting.js'),
      'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }, null, 2) + '\n',
      '.gitignore': GITIGNORE,
      'README.md': '# {{title}}\n\nA Next.js app created with Maataa.\n\n```bash\nnpm install\nnpm run dev     # http://127.0.0.1:3000\nnpm run build\nnpm test        # works before install\n```\n',
    },
  },
};

function titleFor(name) {
  return name.split(/[-_]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, description: t.description, needsInstall: t.needsInstall, fileCount: Object.keys(t.files).length }));
}

/** Returns [{ relativePath, content }] with placeholders filled in. */
function render(templateId, name, title) {
  const template = TEMPLATES[templateId];
  if (!template) return null;
  const fill = text => text.replace(/\{\{name\}\}/g, name).replace(/\{\{title\}\}/g, title || titleFor(name));
  return Object.entries(template.files).map(([relativePath, content]) => ({ relativePath, content: fill(content) }));
}

module.exports = { TEMPLATES, listTemplates, render, titleFor };
