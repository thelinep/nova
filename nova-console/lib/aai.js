'use strict';

// Maataa AAI (Advanced Ancient Intelligence): a rules-first engine.
//
//   Rules derive and check. Panini's sutras, run by Vidyut's prakriya engine
//                           (lib/aai_prakriya.py), derive words step by step, and
//                           every step names its sutra.
//   Models propose.         A language model (Guru or any Ollama model) may answer
//                           free-form questions, grounded in the exact sutra text.
//   Nothing is called       An answer is shown as verified only for what the rules
//   correct unless the      confirmed: a derived form, or a cited sutra whose number
//   rules confirm it.       exists and whose quoted words are its text.

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const panini = require('./panini');
const slp1 = require('./slp1');

const SCRIPT = path.join(__dirname, 'aai_prakriya.py');
const ENGINE_PACKAGE = 'vidyut==0.4.0';
const LAKARAS = { Lat:'लट्', Lit:'लिट्', Lut:'लुट्', Lrt:'लृट्', Let:'लेट्', Lot:'लोट्', Lan:'लङ्', VidhiLin:'विधिलिङ्', AshirLin:'आशीर्लिङ्', Lun:'लुङ्', Lrn:'लृङ्' };
const PRAYOGAS = { Kartari:'कर्तरि', Karmani:'कर्मणि' };
const PURUSHAS = { Prathama:'प्रथम', Madhyama:'मध्यम', Uttama:'उत्तम' };
const VACANAS = { Eka:'एकवचन', Dvi:'द्विवचन', Bahu:'बहुवचन' };
const LINGAS = { Pum:'पुंलिङ्ग', Stri:'स्त्रीलिङ्ग', Napumsaka:'नपुंसकलिङ्ग' };
const VIBHAKTIS = { Prathama:'प्रथमा', Dvitiya:'द्वितीया', Trtiya:'तृतीया', Caturthi:'चतुर्थी', Panchami:'पञ्चमी', Sasthi:'षष्ठी', Saptami:'सप्तमी', Sambodhana:'सम्बोधन' };
const PADAS = { Parasmaipada:'परस्मैपद', Atmanepada:'आत्मनेपद' };
const PREFIXES = ['pra', 'parA', 'apa', 'sam', 'anu', 'ava', 'nis', 'nir', 'dus', 'dur', 'vi', 'AN', 'ni', 'aDi', 'api', 'ati', 'su', 'ut', 'aBi', 'prati', 'pari', 'upa'];
const SOURCES = { Ashtadhyayi:'अष्टाध्यायी', Varttika:'वार्त्तिक', Dhatupatha:'धातुपाठ', Kashika:'काशिका', Kaumudi:'सिद्धान्तकौमुदी', Unadipatha:'उणादिपाठ', Linganushasana:'लिङ्गानुशासन', Phit:'फिट्सूत्र' };

let dataDir = path.join(__dirname, '..', 'data');
let pythonCache = null;
let install = { state: 'idle', log: [], startedAt: null, finishedAt: null, error: null };

function error(message, statusCode = 400, code) { return Object.assign(new Error(message), { statusCode, code }); }
function configure(options = {}) { if (options.dataDir) dataDir = options.dataDir; pythonCache = null; }
function venvPython() { return path.join(dataDir, 'aai', 'venv', 'bin', 'python'); }

function candidates() {
  const appSupport = path.join(require('node:os').homedir(), 'Library', 'Application Support', 'com.brahmini.nova-runtime', 'aai', 'venv', 'bin', 'python');
  return [process.env.NOVA_AAI_PYTHON, venvPython(), appSupport, path.join(__dirname, '..', '..', 'guru', '.venv', 'bin', 'python'), 'python3'].filter(Boolean);
}

function hasEngine(python) {
  try { execFileSync(python, ['-c', 'import vidyut.prakriya'], { stdio: 'ignore', timeout: 15000 }); return true; } catch (_) { return false; }
}

function python() {
  if (pythonCache && Date.now() - pythonCache.at < 60000) return pythonCache.path;
  const found = candidates().find(p => (p === 'python3' || fs.existsSync(p)) && hasEngine(p)) || null;
  pythonCache = { path: found, at: Date.now() };
  return found;
}

function run(request) {
  const py = python();
  if (!py) return Promise.reject(error('The derivation engine is not installed yet. Install it from AAI, or double-click "AAI - Set up.command".', 503, 'engine-missing'));
  return new Promise((resolve, reject) => {
    const child = execFile(py, [SCRIPT], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      let answer;
      try { answer = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (_) { return reject(error(err ? err.message : 'The derivation engine gave no answer.', 500)); }
      if (!answer.ok) return reject(error(answer.error, answer.code === 'not-found' ? 404 : answer.code === 'engine-missing' ? 503 : 400, answer.code));
      resolve(answer);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// --- status and installation ---------------------------------------------------------------
async function status() {
  const py = python();
  let engine = { installed: false };
  if (py) { try { const v = await run({ op: 'version' }); engine = { installed: true, name: 'Vidyut prakriya', version: v.version, dhatus: v.dhatus }; } catch (e) { engine = { installed: false, error: e.message }; } }
  return {
    name: 'Maataa AAI', expansion: 'Advanced Ancient Intelligence',
    principle: 'Rules derive and check; models propose; nothing is called correct unless the rules confirm it.',
    engine, install: { ...install, log: install.log.slice(-30) },
    texts: panini.info(),
    choices: { lakaras: LAKARAS, prayogas: PRAYOGAS, purushas: PURUSHAS, vacanas: VACANAS, lingas: LINGAS, vibhaktis: VIBHAKTIS, padas: PADAS, prefixes: PREFIXES.map(p => ({ slp1: p, text: slp1.toDevanagari(p) })) },
    licences: [panini.info().source.attribution, 'Derivations: Vidyut prakriya engine (https://github.com/ambuda-org/vidyut), MIT licence.'],
  };
}

function startInstall({ killSwitch } = {}) {
  if (killSwitch?.isHalted?.()) throw error('Maataa is halted with the kill switch; installing is refused.', 409);
  if (install.state === 'running') return install;
  const base = ['python3', '/usr/bin/python3'].find(p => { try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } });
  if (!base) throw error('Python 3 is not available on this computer. Install the Xcode command-line tools (xcode-select --install) and try again.', 503);
  const venv = path.join(dataDir, 'aai', 'venv');
  install = { state: 'running', log: [`Creating ${venv}`], startedAt: new Date().toISOString(), finishedAt: null, error: null };
  const step = (cmd, args, next) => execFile(cmd, args, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    install.log.push(...String(stdout || '').split('\n').filter(Boolean).slice(-8), ...String(stderr || '').split('\n').filter(Boolean).slice(-8));
    if (err) { install.state = 'failed'; install.error = err.message; install.finishedAt = new Date().toISOString(); return; }
    next();
  });
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  step(base, ['-m', 'venv', venv], () => {
    install.log.push(`Installing ${ENGINE_PACKAGE} (about 3 MB)`);
    step(path.join(venv, 'bin', 'python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', ENGINE_PACKAGE], () => {
      pythonCache = null;
      install.state = hasEngine(path.join(venv, 'bin', 'python')) ? 'done' : 'failed';
      if (install.state === 'failed') install.error = 'The package installed but could not be loaded.';
      install.finishedAt = new Date().toISOString(); install.log.push(install.state === 'done' ? 'The derivation engine is ready.' : install.error);
    });
  });
  return install;
}

// --- derivations -----------------------------------------------------------------------------
function pick(map, value, label, fallback) {
  const v = value || fallback;
  if (!Object.prototype.hasOwnProperty.call(map, v)) throw error(`Unknown ${label}: ${v}.`);
  return v;
}

function viewSteps(steps) {
  return steps.map(s => {
    const sutra = s.source === 'Ashtadhyayi' ? panini.get(s.code) : null;
    return { source: s.source, sourceName: SOURCES[s.source] || s.source, code: s.code, sutra: sutra ? sutra.devanagari : null,
      terms: s.result.map(t => slp1.toDevanagari(t)), result: slp1.toDevanagari(s.result.join(' + ')) };
  });
}

function dhatuView(d) {
  const entry = panini.dhatuByCode(d.code);
  return { code: d.code, root: entry ? entry.root : slp1.toDevanagari(d.aupadeshika), meaning: entry ? entry.meaning : slp1.toDevanagari(d.artha), gana: entry?.gana, ganaName: entry?.ganaName };
}

function verbRequest(input) {
  const code = String(input.code || '').trim();
  if (!/^\d{2}\.\d{4}$/.test(code)) throw error('Choose a root from the Dhatupatha (a code like 01.0001).');
  const prefixes = (Array.isArray(input.prefixes) ? input.prefixes : []).filter(Boolean);
  for (const p of prefixes) if (!PREFIXES.includes(p)) throw error(`Unknown prefix ${p}.`);
  return { code, lakara: pick(LAKARAS, input.lakara, 'lakara', 'Lat'), prayoga: pick(PRAYOGAS, input.prayoga, 'prayoga', 'Kartari'), pada: input.pada ? pick(PADAS, input.pada, 'pada') : null, prefixes };
}

async function deriveVerb(input) {
  const req = { op: 'tinanta', ...verbRequest(input), purusha: pick(PURUSHAS, input.purusha, 'purusha', 'Prathama'), vacana: pick(VACANAS, input.vacana, 'vacana', 'Eka') };
  const answer = await run(req);
  return { kind: 'verb', request: req, dhatu: dhatuView(answer.dhatu), derivedBy: 'rule', forms: answer.forms.map(f => ({ text: slp1.toDevanagari(f.text), iast: null, slp1: f.text, steps: viewSteps(f.steps) })) };
}

async function paradigm(input) {
  const req = { op: 'paradigm', ...verbRequest(input) };
  const answer = await run(req);
  return { kind: 'verb-paradigm', request: req, dhatu: dhatuView(answer.dhatu), derivedBy: 'rule', rows: answer.rows, columns: answer.columns,
    grid: answer.grid.map(row => row.map(cell => cell.map(t => slp1.toDevanagari(t)))) };
}

function stemRequest(input) {
  const raw = String(input.stem || '').trim();
  if (!raw) throw error('Type a stem, for example राम or मति.');
  const stem = /[\u0900-\u097f]/.test(raw) ? slp1.fromDevanagari(raw) : raw;
  if (!/^[a-zA-Z~'\\^]+$/.test(stem)) throw error('Type the stem in Devanagari (राम) or SLP1 (rAma), one word.');
  return { stem, linga: pick(LINGAS, input.linga, 'linga', 'Pum') };
}

async function deriveNoun(input) {
  const req = { op: 'subanta', ...stemRequest(input), vibhakti: pick(VIBHAKTIS, input.vibhakti, 'vibhakti', 'Prathama'), vacana: pick(VACANAS, input.vacana, 'vacana', 'Eka') };
  const answer = await run(req);
  return { kind: 'noun', request: req, stem: slp1.toDevanagari(req.stem), derivedBy: 'rule', forms: answer.forms.map(f => ({ text: slp1.toDevanagari(f.text), slp1: f.text, steps: viewSteps(f.steps) })) };
}

async function declension(input) {
  const req = { op: 'declension', ...stemRequest(input) };
  const answer = await run(req);
  return { kind: 'noun-paradigm', request: req, stem: slp1.toDevanagari(req.stem), derivedBy: 'rule', rows: answer.rows, columns: answer.columns,
    grid: answer.grid.map(row => row.map(cell => cell.map(t => slp1.toDevanagari(t)))) };
}

// Is a claimed form one the rules derive for this root and lakara (or this stem and gender)?
async function checkForm(input) {
  const claim = String(input.form || '').trim();
  if (!claim) throw error('Type the form to check.');
  const k = panini.key(claim);
  const table = input.stem ? await declension(input) : await paradigm(input);
  const found = [];
  table.rows.forEach((r, i) => table.columns.forEach((c, j) => { if (table.grid[i][j].some(t => panini.key(t) === k)) found.push({ row: r, column: c }); }));
  return { claim, derivable: found.length > 0, where: found, table };
}

// --- Lipi ---------------------------------------------------------------------------------------
// Devanagari, Brahmi or Siddham in; Latin letters are read as SLP1. Out: every script at once.
function lipi(input) {
  const text = String(input.text || '');
  if (!text.trim()) throw error('Type some text.');
  if (text.length > 5000) throw error('Convert at most 5,000 characters at a time.');
  if (/[\u{10A00}-\u{10A5F}]/u.test(text)) throw error('Kharoshthi can be written here but not read yet. Type Devanagari, Brahmi, Siddham or SLP1.');
  const latin = /[a-zA-Z]/.test(text) && !/[\u0900-\u097f\u{11000}-\u{1107F}\u{11580}-\u{115FF}]/u.test(text);
  const deva = latin ? slp1.toDevanagari(text) : panini.toDevaText(text);
  const s = slp1.fromDevanagari(deva);
  return { readAs: latin ? 'slp1' : 'indic', devanagari: deva, iast: slp1.toIast(s), slp1: s,
    brahmi: panini.fromDeva(deva, 'brahmi'), kharoshthi: panini.fromDeva(deva, 'kharoshthi'), siddham: panini.fromDeva(deva, 'siddham') };
}

// --- governed answers ---------------------------------------------------------------------------
const SYSTEM = `You are Maataa AAI, an assistant for Panini's Ashtadhyayi and Sanskrit grammar.
Rules: Quote a sutra only if its exact text is given to you below, and give its number as adhyaya.pada.number (for example 6.1.77).
If you are not sure of a sutra's number or wording, say so instead of guessing. Keep answers short and clear.
Your answer will be checked: every sutra number you cite is compared with the real text.`;

function grounding(question) {
  const ids = new Set(panini.checkCitations(question).filter(c => c.expected).map(c => c.id));
  const words = String(question).match(/[\u0900-\u097f]{3,}/g) || [];
  for (const w of words.slice(0, 6)) for (const r of panini.search(w).results?.slice(0, 2) || []) ids.add(r.id);
  return [...ids].slice(0, 8).map(id => panini.get(id)).filter(Boolean);
}

async function ask({ ollama, question, model, killSwitch }) {
  if (killSwitch?.isHalted?.()) throw error('Maataa is halted with the kill switch.', 409);
  const q = String(question || '').trim();
  if (q.length < 3) throw error('Ask a question.');
  if (!model) throw error('Choose a model.');
  const ground = grounding(q);
  const context = ground.length ? 'Exact sutra texts (Ashtadhyayi, Vidyut edition):\n' + ground.map(s => `${s.id} ${s.devanagari}`).join('\n') : 'No sutra text was found for this question.';
  const started = Date.now();
  const json = await ollama.chatFull(model, [{ role: 'system', content: `${SYSTEM}\n\n${context}` }, { role: 'user', content: q }], { options: { temperature: 0.2 } });
  const answer = String(json?.message?.content || '').trim();
  const citations = panini.checkCitations(answer);
  const bad = citations.filter(c => c.status === 'unknown' || c.status === 'mismatch');
  const verdict = bad.length ? 'contradicted' : citations.some(c => c.status === 'ok') ? 'citations-verified' : 'unverified';
  return {
    question: q, model, answer, grounding: ground.map(s => ({ id: s.id, text: s.devanagari })), citations, verdict,
    explanation: verdict === 'contradicted' ? 'Some sutra citations in this answer are wrong (see below). Do not rely on it.'
      : verdict === 'citations-verified' ? 'Every sutra this answer cites exists and is quoted correctly. The explanation itself is the model\'s and is not checked by rule.'
      : 'The model\'s answer. No sutra citation could be checked, so nothing in it is verified by rule.',
    proposedBy: 'model', durationMs: Date.now() - started,
  };
}

module.exports = { configure, status, startInstall, deriveVerb, paradigm, deriveNoun, declension, checkForm, lipi, ask, LAKARAS, PREFIXES, _run: run, _reset: () => { pythonCache = null; install = { state: 'idle', log: [], startedAt: null, finishedAt: null, error: null }; } };
