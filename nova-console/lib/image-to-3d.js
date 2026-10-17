'use strict';
/* ===========================================================================
 * Character Studio: scan an image into a 3D character
 *
 *  1. Match the rig. The app measures the picture (body proportions from
 *     MediaPipe pose when installed, colours sampled at the hair, face, top,
 *     bottom and shoes). A local vision model, when one is installed in
 *     Ollama, names the hair style, clothes and extras. The two are merged
 *     into the posable 3D character (lib/puppet.js normaliseRig3d).
 *  2. Generate a mesh. TripoSR (MIT licence) turns one picture into a
 *     textured 3D mesh (.glb) on this Mac. It is a statue: it can be viewed,
 *     placed and exported, but it has no joints.
 * Everything runs locally; nothing is uploaded.
 * ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const media = require('./media');
const puppet = require('./puppet');

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const HEX = /^#[0-9a-f]{6}$/i;
const hex = v => (HEX.test(String(v || '')) ? String(v).toLowerCase() : null);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0)); };

/* -------------------------------- match the rig -------------------------------- */
function visionModels(store) {
  return store.all('models').filter(m => Array.isArray(m.capabilities) && m.capabilities.includes('vision') && !m.example).map(m => m.id || m.name).filter(Boolean);
}
const E = puppet.RIG3D;
const PROMPT = `You are helping make a stylised 3D cartoon character that looks like the main person or character in this picture.
Look only at what is visible. Reply with ONE JSON object and nothing else, using exactly these keys and one of the listed values:
{"robot": true|false,
 "build": ${JSON.stringify(E.build)},
 "child": true|false,
 "hairStyle": ${JSON.stringify(E.hairStyle)},
 "eyeShape": ${JSON.stringify(E.eyeShape.filter(x => x !== 'glow'))},
 "browShape": ${JSON.stringify(E.browShape)},
 "mouthShape": ${JSON.stringify(E.mouthShape)},
 "noseShape": ${JSON.stringify(E.noseShape)},
 "top": ${JSON.stringify(E.top)},
 "bottom": ${JSON.stringify(E.bottom)},
 "shoes": ${JSON.stringify(E.shoes)},
 "extras": array of any of ${JSON.stringify(E.extras)},
 "description": "one short sentence about how they look (clothes and colours), no names"}
If a part is not visible, choose the most likely value. Do not identify the person.`;

function parseVision(text) {
  const s = String(text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
  const pick = (k, list) => (list.includes(j[k]) ? j[k] : undefined);
  return {
    robot: j.robot === true, child: j.child === true, build: pick('build', E.build), hairStyle: pick('hairStyle', E.hairStyle), eyeShape: pick('eyeShape', E.eyeShape),
    browShape: pick('browShape', E.browShape), mouthShape: pick('mouthShape', E.mouthShape), noseShape: pick('noseShape', E.noseShape),
    top: pick('top', E.top), bottom: pick('bottom', E.bottom), shoes: pick('shoes', E.shoes),
    extras: (Array.isArray(j.extras) ? j.extras : []).filter(x => E.extras.includes(x)), description: String(j.description || '').slice(0, 240),
  };
}

/**
 * The 3D rig for a scan. samples: colours the app measured ({skin, hair, top, bottom, shoes, accent, background});
 * metrics: proportions from pose landmarks ({legRatio, armRatio, headRatio, shoulderHip, hasPose});
 * vision: what a vision model named (parseVision output) or null.
 */
function rigFromScan(samples = {}, metrics = {}, vision = null, prior = null) {
  const v = vision || {};
  const base = puppet.normaliseRig3d(null, prior || puppet.rigFromPuppet(null));
  const s = Object.fromEntries(Object.entries(samples || {}).map(([k, c]) => [k, hex(c)]).filter(([, c]) => c));
  const robot = !!v.robot;
  const r = base;
  // proportions: a big head relative to the shoulders reads as a child or a cartoon
  const headRatio = num(metrics.headRatio, 0.2, 1.5), legRatio = num(metrics.legRatio, 0.5, 2.5), armRatio = num(metrics.armRatio, 0.5, 2.5), sh = num(metrics.shoulderHip, 0.6, 2.5);
  if (headRatio) r.body.headSize = Math.round(Math.min(1.45, Math.max(0.85, 1 + (headRatio - 0.4))) * 100) / 100;
  if (legRatio) r.body.legLength = Math.round(Math.min(1.3, Math.max(0.75, legRatio / 1.6)) * 100) / 100;
  if (armRatio) r.body.armLength = Math.round(Math.min(1.25, Math.max(0.8, armRatio / 1.15)) * 100) / 100;
  // adults: ear-to-ear is about 0.35-0.45 of the shoulder width; children and cartoons have bigger heads
  // (only with the legs in view: a head-and-shoulders picture in three-quarter view also has narrow shoulders)
  const child = vision ? v.child : !!(headRatio && headRatio > 0.52 && legRatio && legRatio < 1.55);
  r.body.height = child ? 0.82 : 1;
  r.body.build = v.build || (sh ? (sh > 2.0 ? 'sturdy' : sh < 1.3 ? 'slim' : 'average') : r.body.build);
  r.body.robot = robot; r.body.hands = robot ? 'mitten' : 'fingers';
  if (s.skin) r.body.skin = s.skin;
  // hair: a hair sample close to the skin colour means bald or very short hair
  const bald = s.hair && s.skin && dist(s.hair, s.skin) < 38;
  r.hair = { style: robot ? 'bald' : v.hairStyle || (bald ? 'bald' : 'short'), color: s.hair && !bald ? s.hair : r.hair.color };
  r.face = { ...r.face, eyeShape: robot ? 'glow' : v.eyeShape || 'round', browShape: robot ? 'none' : v.browShape || 'arched', browColor: s.hair && !bald ? s.hair : r.face.browColor,
    mouthShape: v.mouthShape || 'smile', noseShape: robot ? 'none' : v.noseShape || 'button', earShape: robot ? 'none' : 'round' };
  if (robot && s.accent) r.face.eyeColor = s.accent;
  // clothes: a bottom sample close to the skin means bare legs (shorts or skirt), unless the model says otherwise
  const bareLegs = s.bottom && s.skin && dist(s.bottom, s.skin) < 40;
  r.costume = { ...r.costume,
    top: robot ? 'armor' : v.top || 'tshirt', topColor: s.top || r.costume.topColor, accent: s.accent || r.costume.accent,
    bottom: robot ? 'none' : v.bottom || (bareLegs ? 'shorts' : 'pants'), bottomColor: (!bareLegs && s.bottom) || r.costume.bottomColor,
    shoes: v.shoes || (s.shoes && s.skin && dist(s.shoes, s.skin) < 52 ? 'barefoot' : 'sneakers'), shoeColor: s.shoes || r.costume.shoeColor,
    extras: v.extras || [] };
  return puppet.normaliseRig3d(r);
}

async function analyse({ store, dataDir, ollama }, input = {}) {
  const record = media.getMedia(store, String(input.mediaId || ''));
  if (record.kind !== 'image') throw error('Choose a picture (PNG, JPEG or WebP).');
  const models = visionModels(store);
  const model = input.model && models.includes(input.model) ? input.model : models[0] || null;
  let vision = null, visionNote = null;
  if (model && input.useVision !== false && ollama) {
    try {
      const img = fs.readFileSync(media.filePath(dataDir, record)).toString('base64');
      const res = await ollama.chatFull(model, [{ role: 'user', content: PROMPT, images: [img] }], { options: { temperature: 0.1, num_predict: 400 }, format: 'json' });
      vision = parseVision(res && res.message && res.message.content);
      if (!vision) visionNote = model + ' did not return a usable answer; colours and proportions were used alone.';
    } catch (e) { visionNote = 'The vision model could not run (' + String(e.message || e).slice(0, 120) + '); colours and proportions were used alone.'; }
  } else if (!model) visionNote = 'No vision model is installed, so hair style and clothes are guesses. For a better match, install one in Models (for example qwen2.5vl or llama3.2-vision).';
  const rig = rigFromScan(input.samples, input.metrics, vision, input.prior || null);
  return { rig, vision, model: vision ? model : null, pose: !!(input.metrics && input.metrics.hasPose), note: visionNote, sourceMediaId: record.id };
}

/* -------------------------------- generate a mesh -------------------------------- */
const meshDir = dataDir => process.env.NOVA_TRIPOSR_DIR || path.join(dataDir, 'tools', 'triposr');
function meshStatus(dataDir) {
  const dir = meshDir(dataDir), python = process.env.NOVA_TRIPOSR_PYTHON || path.join(dir, '.venv', 'bin', 'python');
  const ready = fs.existsSync(python) && (Boolean(process.env.NOVA_TRIPOSR_PYTHON) || fs.existsSync(path.join(dir, '.ready')));
  return { ready, python: ready ? python : null, dir, missing: ready ? [] : ['Image to 3D mesh (TripoSR): Setup → Install → Image to 3D mesh (about 3 GB)'] };
}
const meshesDir = dataDir => path.join(dataDir, 'meshes');
function meshFile(dataDir, name) {
  if (!/^mesh_[a-f0-9]{12}\.glb$/.test(String(name))) throw error('Unknown mesh.', 404);
  const f = path.join(meshesDir(dataDir), name); if (!fs.existsSync(f)) throw error('That mesh is gone.', 404); return f;
}
function newJob(store, settings) {
  const job = { id: 'gen_' + crypto.randomBytes(8).toString('hex'), type: 'mesh-3d', status: 'running', settings, promptId: null, mediaIds: [], error: null, progress: 'Starting…', cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null };
  store.put('generationJobs', job); return job;
}
/** Starts TripoSR on a picture. The job ends with job.mesh = { file, bytes }. */
function startMesh(store, dataDir, input = {}) {
  const st = meshStatus(dataDir);
  if (!st.ready) throw error('Image to 3D mesh is not installed. ' + st.missing[0] + '.', 412);
  const record = media.getMedia(store, String(input.mediaId || ''));
  if (record.kind !== 'image') throw error('Choose a picture (PNG, JPEG or WebP).');
  const settings = { engine: 'triposr', prompt: 'Picture to 3D mesh: ' + record.originalName, sourceMediaId: record.id, sourceName: record.originalName, removeBackground: input.removeBackground !== false, resolution: Math.round(num(input.resolution, 128, 320) || 256) };
  const job = newJob(store, settings);
  fs.mkdirSync(meshesDir(dataDir), { recursive: true });
  const name = 'mesh_' + crypto.randomBytes(6).toString('hex') + '.glb', out = path.join(meshesDir(dataDir), name);
  const script = process.env.NOVA_TRIPOSR_SCRIPT || path.join(__dirname, '..', 'scripts', 'image-to-mesh.py');
  const args = [script, '--image', media.filePath(dataDir, record), '--out', out, '--resolution', String(settings.resolution), ...(settings.removeBackground ? [] : ['--keep-background'])];
  const done = new Promise(resolve => {
    const c = spawn(st.python, args, { cwd: fs.existsSync(st.dir) ? st.dir : dataDir, env: { ...process.env, TRIPOSR_DIR: st.dir, HF_HOME: path.join(st.dir, 'hf') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', ended = false;
    const timer = setTimeout(() => c.kill('SIGKILL'), 20 * 60 * 1000);
    const watch = setInterval(() => { if (store.get('generationJobs', job.id)?.cancelRequested) c.kill('SIGTERM'); }, 1000);
    const save = patch => { const cur = { ...(store.get('generationJobs', job.id) || job), ...patch }; store.put('generationJobs', cur); return cur; };
    c.stdout.on('data', d => { for (const line of String(d).split('\n')) if (line.startsWith('PROGRESS ')) save({ progress: line.slice(9).trim() }); });
    c.stderr.on('data', d => { err = (err + d).slice(-4000); });
    c.on('close', code => {
      if (ended) return; ended = true; clearTimeout(timer); clearInterval(watch);
      const cancelled = store.get('generationJobs', job.id)?.cancelRequested, finishedAt = new Date().toISOString();
      if (code === 0 && !cancelled && fs.existsSync(out)) resolve(save({ status: 'done', progress: null, mesh: { file: name, bytes: fs.statSync(out).size }, finishedAt }));
      else { fs.rmSync(out, { force: true }); resolve(save({ status: cancelled ? 'cancelled' : 'failed', progress: null, error: cancelled ? 'Cancelled.' : 'TripoSR could not make a mesh: ' + (err.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'exit ' + code), finishedAt })); }
    });
    c.on('error', e => { if (ended) return; ended = true; clearTimeout(timer); clearInterval(watch); resolve(save({ status: 'failed', progress: null, error: e.message, finishedAt: new Date().toISOString() })); });
  });
  return { job, done };
}

module.exports = { analyse, rigFromScan, parseVision, visionModels, meshStatus, startMesh, meshFile, meshesDir, PROMPT };
