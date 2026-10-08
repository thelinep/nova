#!/usr/bin/env node
'use strict';
/* Used by "Maataa - Start coding.command". Talks to a running NOVA on 127.0.0.1
 * and prints KEY=value lines the launcher reads:
 *   node scripts/start-coding.js status <model>    sync models, approve ~/Maataa Projects, report qualification
 *   node scripts/start-coding.js qualify <model>   start the 18 coding checks for that exact model
 * Nothing here downloads anything or touches project files. */
const http = require('node:http');

const PORT = Number(process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const NEEDED = ['multi-file', 'clarification', 'timeout', 'cancellation'];

function call(route, body) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { Origin: BASE, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch (_) {}
        if (res.statusCode >= 400) return reject(new Error((json && json.error) || `HTTP ${res.statusCode} for ${route}`));
        resolve(json);
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('NOVA did not answer in time')));
    req.end(data);
  });
}

const clean = digest => String(digest || '').replace(/^sha256:/i, '');

async function status(name) {
  const { models } = await call('/api/models/sync', {});
  const model = (models || []).find(m => m.runtime === 'ollama' && (m.name === name || m.id === name));
  console.log('MODEL_FOUND=' + (model ? 'yes' : 'no'));
  const folder = await call('/api/app-builder/projects-folder', {});
  console.log('PROJECTS_FOLDER=' + folder.path);
  if (!model) return;
  const records = await call('/api/model-qualifications');
  const record = (records || []).find(r => clean(r.digest) === clean(model.digest));
  const qualified = record ? Object.entries(record.capabilities || {}).filter(([, v]) => v && v.qualified).map(([k]) => k) : [];
  console.log('QUALIFIED_FOR=' + qualified.join(','));
  console.log('READY=' + (NEEDED.every(c => qualified.includes(c)) ? 'yes' : 'no'));
}

async function qualify(name) {
  const { jobId } = await call('/api/models/qualify', { model: name });
  console.log('QUALIFY_JOB=' + jobId);
}

const [cmd, name] = process.argv.slice(2);
(cmd === 'qualify' ? qualify(name) : status(name)).catch(e => { console.log('ERROR=' + String(e.message).replace(/\n/g, ' ')); process.exit(1); });
