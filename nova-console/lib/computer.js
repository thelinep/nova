'use strict';
/* ===========================================================================
 * Computer: tools that let NOVA use this Mac, always with your approval
 *
 *   run_command     a terminal command, inside a folder you approved
 *   open            open a web link, an app, a file, or reveal it in Finder
 *   screenshot      look at the screen (a vision model reads it)
 *   click / type_text / press_key / scroll   use the mouse and keyboard
 *   clipboard_read / clipboard_write
 *   list_files / read_file / write_file / move_file / make_folder / move_to_trash
 *
 * Every call goes through approve(): the chat shows what NOVA wants to do and
 * waits for Allow / Allow for this chat / Deny. Settings can let read-only
 * actions (looking at files, the screen or the clipboard) through without
 * asking. File tools only work inside approved folders (Local Workspace roots
 * and folders added to the conversation); nothing is ever deleted — "move to
 * Trash" uses Finder so it can be put back. Some commands are refused outright.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const IS_MAC = process.platform === 'darwin';
const OUTPUT_CAP = 16000;
const pending = new Map();          // approvalId -> {resolve, info, timer}
const sessionAllow = new Map();     // sessionId -> Set(tool)
const shots = new Map();            // sessionId -> {file, width, height, scale}
const listeners = new Set();

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function home(p) { const h = os.homedir(); return h && typeof p === 'string' && p.startsWith(h) ? '~' + p.slice(h.length) : p; }
/** "Desktop", "~/Desktop" or a full path → an absolute path (not yet checked). */
function folderPath(p) {
  let t = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (/^(desktop|documents|downloads|movies|music|pictures)$/i.test(t)) t = '~/' + t[0].toUpperCase() + t.slice(1).toLowerCase();
  return path.resolve(expand(t));
}
function expand(p) { return String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir()); }

const TOOLS = [
  { name: 'use_folder', risk: 'folder', description: 'Ask the person for permission to work in a folder, for example ~/Desktop, ~/Downloads or ~/Documents/Scripts. Call this whenever you need a folder that is not approved yet. The person approves it with one click; never ask them to type commands or menu paths instead.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Full path, or ~/Desktop style path' }, reason: { type: 'string', description: 'One short sentence: why you need it' } }, required: ['path'] } },
  { name: 'run_command', risk: 'run', description: 'Run a shell command on this Mac and get its output. Use for listing, searching, building, testing, git, and scripts. Runs in an approved folder.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command line, e.g. "ls -la" or "npm test"' }, cwd: { type: 'string', description: 'Folder to run in (must be an approved folder; default: the first one)' } }, required: ['command'] } },
  { name: 'open', risk: 'change', description: 'Open a web link in the browser, launch an app, open a file in its app, or reveal a file in Finder.', parameters: { type: 'object', properties: { target: { type: 'string', description: 'A URL, a file or folder path, or an app name' }, app: { type: 'string', description: 'Optional app to open the target with, e.g. "Preview"' }, reveal: { type: 'boolean', description: 'Show the file in Finder instead of opening it' } }, required: ['target'] } },
  { name: 'screenshot', risk: 'read', description: 'Take a screenshot of the main screen so you can see what is on it. Coordinates for click use this image\'s pixels.', parameters: { type: 'object', properties: {} } },
  { name: 'click', risk: 'change', description: 'Click at a point on the screen, in the pixel coordinates of the last screenshot.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } }, required: ['x', 'y'] } },
  { name: 'type_text', risk: 'change', description: 'Type text with the keyboard into whatever has focus.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'press_key', risk: 'change', description: 'Press a key, optionally with modifiers, e.g. key "return", or key "c" with ["command"].', parameters: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string', enum: ['command', 'shift', 'option', 'control'] } } }, required: ['key'] } },
  { name: 'scroll', risk: 'change', description: 'Scroll the window under the mouse. Positive amount scrolls down.', parameters: { type: 'object', properties: { amount: { type: 'number', description: 'Lines to scroll; negative scrolls up' } }, required: ['amount'] } },
  { name: 'clipboard_read', risk: 'read', description: 'Read the text on the clipboard.', parameters: { type: 'object', properties: {} } },
  { name: 'clipboard_write', risk: 'change', description: 'Put text on the clipboard.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'list_files', risk: 'read', description: 'List the files and folders in an approved folder.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'read_file', risk: 'read', description: 'Read a text file in an approved folder.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', risk: 'change', description: 'Create or overwrite a text file in an approved folder.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['path', 'content'] } },
  { name: 'move_file', risk: 'change', description: 'Move or rename a file or folder inside approved folders. Never overwrites.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'make_folder', risk: 'change', description: 'Create a folder inside an approved folder.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'move_to_trash', risk: 'change', description: 'Move a file or folder in an approved folder to the Trash (it can be put back).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
const SCREEN_TOOLS = new Set(['screenshot', 'click', 'type_text', 'press_key', 'scroll']);

/** Ollama tool specs; `groups` narrows them ({screen:false} leaves out the screen tools). */
function toolSpecs({ screen = true } = {}) {
  return TOOLS.filter(t => screen || !SCREEN_TOOLS.has(t.name)).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/* ------------------------------------------------------------ safety rules */

const BLOCKED = [
  [/\bsudo\b|\bsu\s+-?\s*\w*\s*$|\bdoas\b/, 'NOVA does not run commands as administrator.'],
  [/\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\/\*|~\/\*)(\s|$)/, 'Deleting your disk or home folder is never allowed.'],
  [/\b(mkfs|diskutil\s+(erase|partition|zero|secureErase)|newfs|fdisk|dd\s+.*of=\/dev)/, 'Disk formatting commands are never allowed.'],
  [/\b(shutdown|reboot|halt)\b|killall\s+(Finder|Dock|loginwindow|WindowServer)/, 'Shutting down or restarting is not allowed from chat.'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'That command would freeze the Mac.'],
  [/\bcsrutil\b|\bspctl\s+--master-disable|\bnvram\b|\bsecurity\s+(delete|dump)-/, 'Security settings cannot be changed from chat.'],
  [/(curl|wget)[^|]*\|\s*(ba|z)?sh\b/, 'Downloading and running a script in one step is not allowed. Download it, read it, then run it.'],
  [/\bchmod\s+-R\s+777\s+(\/|~)/, 'Opening up permissions on your whole disk is not allowed.'],
];
function checkCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c) throw error('Empty command.');
  if (c.length > 4000) throw error('That command is too long.');
  for (const [re, why] of BLOCKED) if (re.test(c)) throw error(why, 403);
  return c;
}

function realOrParent(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) { tail.unshift(path.basename(cur)); const up = path.dirname(cur); if (up === cur) break; cur = up; }
  return path.join(fs.realpathSync.native(cur), ...tail);
}

/** Resolves a path and checks it is inside one of the approved roots. */
function insideRoots(p, roots, { mustExist = false } = {}) {
  if (!roots.length) throw error('No folder is approved yet. Add a folder to this conversation (+ > Add folder) or approve one in Local Workspace.', 403);
  let raw = expand(p);
  if (!path.isAbsolute(raw)) raw = path.join(roots[0], raw);
  const real = realOrParent(raw);
  if (mustExist && !fs.existsSync(real)) throw error('Not found: ' + home(real), 404);
  const ok = roots.some(r => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  if (!ok) throw error(`${home(real)} is outside the approved folders (${roots.map(home).join(', ')}).`, 403);
  return real;
}

/* ---------------------------------------------------------------- runners */

function run(file, args, { timeout = 20000, input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message = String(stderr || err.message).trim().slice(0, 800) || err.message; reject(err); } else resolve(String(stdout));
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}
function cap(text) { const t = String(text || ''); return t.length <= OUTPUT_CAP ? t : t.slice(0, OUTPUT_CAP * 0.6) + `\n… [${t.length - OUTPUT_CAP} characters cut] …\n` + t.slice(-OUTPUT_CAP * 0.35); }
function needMac(what) { if (!IS_MAC) throw error(what + ' works on macOS only.', 501); }

function runCommand({ command, cwd }, roots, signal) {
  const cmd = checkCommand(command);
  const dir = cwd ? insideRoots(cwd, roots, { mustExist: true }) : (roots[0] ? insideRoots(roots[0], roots, { mustExist: true }) : null);
  if (!dir) throw error('No folder is approved yet. Add a folder to this conversation first.', 403);
  if (!fs.statSync(dir).isDirectory()) throw error('cwd must be a folder.');
  const shell = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(shell, ['-lc', cmd], { cwd: dir, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', killed = false;
    const add = d => { out += d; if (out.length > OUTPUT_CAP * 4) out = out.slice(0, OUTPUT_CAP * 2) + '\n…\n' + out.slice(-OUTPUT_CAP); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000); }, 120000);
    const onAbort = () => { killed = true; child.kill('SIGTERM'); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', code => {
      clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      resolve({ ok: code === 0 && !killed, output: cap(out) || '(no output)', summary: `${killed ? 'Stopped' : code === 0 ? 'Finished' : 'Exit code ' + code} in ${secs} s · ${home(dir)}` });
    });
  });
}

async function openTarget({ target, app, reveal }, roots) {
  const t = String(target || '').trim();
  if (!t) throw error('Nothing to open.');
  let args, what;
  if (/^(https?:|mailto:)/i.test(t)) { args = app ? ['-a', app, t] : [t]; what = 'Opened ' + t; }
  else if (t.startsWith('/') || t.startsWith('~') || t.startsWith('.')) {
    const p = expand(t);
    if (!fs.existsSync(p)) throw error('Not found: ' + home(p), 404);
    args = reveal ? ['-R', p] : app ? ['-a', app, p] : [p]; what = (reveal ? 'Showed in Finder: ' : 'Opened ') + home(p);
  } else if (/^[\w .&+-]{1,60}$/.test(t)) { args = ['-a', t]; what = 'Launched ' + t; }
  else throw error('Give a web address, a full file path, or an app name.');
  needMac('Opening apps and files');
  await run('/usr/bin/open', args, { timeout: 15000 });
  return { ok: true, output: what, summary: what };
}

async function screenInfo() {
  needMac('Looking at the screen');
  const js = 'ObjC.import("AppKit"); var s=$.NSScreen.mainScreen; var f=s.frame; JSON.stringify({w:f.size.width,h:f.size.height,scale:s.backingScaleFactor})';
  try { return JSON.parse(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js])); } catch (_) { return { w: null, h: null, scale: 2 }; }
}

async function screenshot(ctx) {
  needMac('Taking a screenshot');
  const dir = path.join(ctx.dataDir, 'computer'); fs.mkdirSync(dir, { recursive: true });
  const name = 'shot-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex') + '.jpg';
  const raw = path.join(dir, 'raw-' + name), file = path.join(dir, name);
  await run('/usr/sbin/screencapture', ['-x', '-C', '-t', 'jpg', raw], { timeout: 15000 });
  // Keep it small enough for a vision model: 1280 px wide.
  await run('/usr/bin/sips', ['-Z', '1280', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', raw, '--out', file], { timeout: 15000 }).catch(() => fs.copyFileSync(raw, file));
  fs.rmSync(raw, { force: true });
  const dims = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).catch(() => '');
  const width = +(/pixelWidth: (\d+)/.exec(dims) || [])[1] || 1280, height = +(/pixelHeight: (\d+)/.exec(dims) || [])[1] || 800;
  const screen = await screenInfo();
  const scale = screen.w ? screen.w / width : 1; // screenshot pixels -> screen points
  shots.set(ctx.sessionId, { file, width, height, scale });
  prune(dir);
  return { ok: true, output: `Screenshot ${width}×${height} px. Click coordinates use these pixels.`, summary: `Screenshot ${width}×${height}`, image: { file, name, url: '/api/computer/shots/' + name } };
}
function prune(dir) { try { const f = fs.readdirSync(dir).filter(n => n.startsWith('shot-')).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t); for (const x of f.slice(40)) fs.rmSync(path.join(dir, x.n), { force: true }); } catch (_) {} }

function toPoints(ctx, x, y) {
  const s = shots.get(ctx.sessionId);
  if (!s) throw error('Take a screenshot first, so there is something to point at.', 409);
  const px = Number(x), py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > s.width || py > s.height) throw error(`The point (${x}, ${y}) is outside the ${s.width}×${s.height} screenshot.`);
  return { x: Math.round(px * s.scale), y: Math.round(py * s.scale) };
}

async function click({ x, y, button = 'left', double = false }, ctx) {
  needMac('Clicking');
  const p = toPoints(ctx, x, y);
  const right = button === 'right';
  const js = `ObjC.import("CoreGraphics"); var p=$.CGPointMake(${p.x},${p.y});
    function post(t,n){var e=$.CGEventCreateMouseEvent(null,t,p,${right ? 1 : 0}); $.CGEventSetIntegerValueField(e,1,n); $.CGEventPost(0,e);}
    post(5,1); for (var n=1;n<=${double ? 2 : 1};n++){ post(${right ? 3 : 1},n); post(${right ? 4 : 2},n); } "ok"`;
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js]);
  return { ok: true, output: `${double ? 'Double-clicked' : right ? 'Right-clicked' : 'Clicked'} at (${x}, ${y})`, summary: `${double ? 'Double-click' : 'Click'} at ${x}, ${y}` };
}

function asString(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
async function typeText({ text }) {
  needMac('Typing');
  const t = String(text || ''); if (!t) throw error('Nothing to type.'); if (t.length > 4000) throw error('Type at most 4,000 characters at a time.');
  // Line by line: keystroke cannot type a newline, so press Return between lines.
  const lines = t.split('\n');
  const script = ['tell application "System Events"', ...lines.flatMap((l, i) => [l ? `keystroke ${asString(l)}` : null, i < lines.length - 1 ? 'key code 36' : null]).filter(Boolean), 'end tell'];
  await run('/usr/bin/osascript', script.flatMap(s => ['-e', s]), { timeout: 60000 });
  return { ok: true, output: `Typed ${t.length} characters`, summary: `Typed ${t.length} characters` };
}

const KEY_CODES = { return: 36, enter: 76, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96 };
async function pressKey({ key, modifiers = [] }) {
  needMac('Pressing keys');
  const k = String(key || '').toLowerCase().replace(/[\s_-]/g, '');
  const mods = (Array.isArray(modifiers) ? modifiers : []).map(m => String(m).toLowerCase().replace('cmd', 'command').replace('ctrl', 'control').replace('alt', 'option')).filter(m => ['command', 'shift', 'option', 'control'].includes(m));
  const using = mods.length ? ` using {${mods.map(m => m + ' down').join(', ')}}` : '';
  if (mods.includes('command') && ['q'].includes(k) ) throw error('Quitting apps with ⌘Q is not allowed from chat; ask me to do it another way.', 403);
  const action = KEY_CODES[k] != null ? `key code ${KEY_CODES[k]}${using}` : k.length === 1 ? `keystroke ${asString(k)}${using}` : null;
  if (!action) throw error('Unknown key: ' + key);
  await run('/usr/bin/osascript', ['-e', 'tell application "System Events"', '-e', action, '-e', 'end tell']);
  const label = [...mods.map(m => ({ command: '⌘', shift: '⇧', option: '⌥', control: '⌃' }[m])), k.length === 1 ? k.toUpperCase() : k].join('');
  return { ok: true, output: 'Pressed ' + label, summary: 'Pressed ' + label };
}

async function scroll({ amount }) {
  needMac('Scrolling');
  const n = Math.max(-50, Math.min(50, Math.round(Number(amount) || 0)));
  if (!n) throw error('Scroll by a number of lines, e.g. 5 or -5.');
  const js = `ObjC.import("CoreGraphics"); var e=$.CGEventCreateScrollWheelEvent2(null,1,1,${-n},0,0); $.CGEventPost(0,e); "ok"`;
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js]);
  return { ok: true, output: `Scrolled ${n > 0 ? 'down' : 'up'} ${Math.abs(n)} lines`, summary: `Scrolled ${n > 0 ? 'down' : 'up'}` };
}

async function clipboardRead() {
  const bin = IS_MAC ? '/usr/bin/pbpaste' : null; if (!bin) throw error('The clipboard works on macOS only.', 501);
  const t = await run(bin, []);
  return { ok: true, output: cap(t) || '(the clipboard is empty or holds no text)', summary: `${t.length} characters on the clipboard` };
}
async function clipboardWrite({ text }) {
  if (!IS_MAC) throw error('The clipboard works on macOS only.', 501);
  await run('/usr/bin/pbcopy', [], { input: String(text || '') });
  return { ok: true, output: 'Copied to the clipboard', summary: `Copied ${String(text || '').length} characters` };
}

function listFiles({ path: p }, roots) {
  const dir = insideRoots(p || roots[0] || '', roots, { mustExist: true });
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.')).slice(0, 400).map(e => {
    let size = ''; try { if (e.isFile()) { const b = fs.statSync(path.join(dir, e.name)).size; size = b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; } } catch (_) {}
    return (e.isDirectory() ? e.name + '/' : e.name) + (size ? '  ' + size : '');
  });
  return { ok: true, output: `${home(dir)}\n` + (entries.join('\n') || '(empty)'), summary: `${entries.length} items in ${home(dir)}` };
}
function readFile({ path: p }, roots) {
  const f = insideRoots(p, roots, { mustExist: true });
  if (fs.statSync(f).isDirectory()) return listFiles({ path: f }, roots);
  const buf = fs.readFileSync(f).subarray(0, 400 * 1024);
  if (buf.includes(0)) throw error('That is a binary file; I can only read text.');
  return { ok: true, output: cap(buf.toString('utf8')), summary: `Read ${home(f)}` };
}
function noGit(p) { if (p.split(path.sep).includes('.git')) throw error('Changing files inside .git is not allowed.', 403); }
function writeFile({ path: p, content, overwrite = false }, roots) {
  const f = insideRoots(p, roots); noGit(f);
  const exists = fs.existsSync(f);
  if (exists && !overwrite) throw error(`${home(f)} already exists. Ask again with overwrite if you mean to replace it.`, 409);
  if (String(content).length > 2 * 1024 * 1024) throw error('That is more than 2 MB of text.');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, String(content));
  return { ok: true, output: `${exists ? 'Replaced' : 'Created'} ${home(f)} (${String(content).length} characters)`, summary: `${exists ? 'Replaced' : 'Created'} ${path.basename(f)}` };
}
function moveFile({ from, to }, roots) {
  const a = insideRoots(from, roots, { mustExist: true }), b = insideRoots(to, roots); noGit(a); noGit(b);
  if (fs.existsSync(b)) throw error(`${home(b)} already exists; I never overwrite when moving.`, 409);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
  return { ok: true, output: `Moved ${home(a)} → ${home(b)}`, summary: path.dirname(a) === path.dirname(b) ? `Renamed to ${path.basename(b)}` : `Moved ${path.basename(a)}` };
}
function makeFolder({ path: p }, roots) {
  const d = insideRoots(p, roots); noGit(d);
  fs.mkdirSync(d, { recursive: true });
  return { ok: true, output: 'Created folder ' + home(d), summary: 'Created ' + path.basename(d) + '/' };
}
async function moveToTrash({ path: p }, roots) {
  const f = insideRoots(p, roots, { mustExist: true }); noGit(f);
  if (roots.includes(f)) throw error('I will not move a whole approved folder to the Trash.', 403);
  needMac('Moving to the Trash');
  await run('/usr/bin/osascript', ['-e', `tell application "Finder" to delete (POSIX file ${asString(f)} as alias)`], { timeout: 20000 });
  return { ok: true, output: `Moved ${home(f)} to the Trash (Finder can put it back)`, summary: `Trashed ${path.basename(f)}` };
}

/* --------------------------------------------------------------- approvals */

function describe(name, args) {
  const a = args || {};
  switch (name) {
    case 'run_command': return { title: 'Run a command', detail: a.command, where: a.cwd ? home(expand(a.cwd)) : null };
    case 'open': return { title: a.reveal ? 'Show in Finder' : /^https?:/i.test(a.target || '') ? 'Open a web page' : 'Open', detail: a.target + (a.app ? ' with ' + a.app : '') };
    case 'screenshot': return { title: 'Look at your screen', detail: 'Take a screenshot of the main display' };
    case 'click': return { title: a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click', detail: `at (${a.x}, ${a.y}) on the last screenshot` };
    case 'type_text': return { title: 'Type text', detail: String(a.text || '').slice(0, 300) };
    case 'press_key': return { title: 'Press a key', detail: [...(a.modifiers || []), a.key].join(' + ') };
    case 'scroll': return { title: 'Scroll', detail: `${a.amount > 0 ? 'down' : 'up'} ${Math.abs(a.amount || 0)} lines` };
    case 'clipboard_read': return { title: 'Read the clipboard', detail: '' };
    case 'clipboard_write': return { title: 'Copy to the clipboard', detail: String(a.text || '').slice(0, 300) };
    case 'list_files': return { title: 'List files', detail: a.path };
    case 'read_file': return { title: 'Read a file', detail: a.path };
    case 'write_file': return { title: a.overwrite ? 'Replace a file' : 'Create a file', detail: `${a.path} (${String(a.content || '').length} characters)` };
    case 'move_file': return { title: 'Move or rename', detail: `${a.from} → ${a.to}` };
    case 'make_folder': return { title: 'Create a folder', detail: a.path };
    case 'move_to_trash': return { title: 'Move to Trash', detail: a.path };
    case 'use_folder': return { title: 'Let NOVA work in a folder', detail: home(folderPath(a.path)) + (a.reason ? ' — ' + a.reason : '') };
    default: return { title: name, detail: JSON.stringify(a).slice(0, 300) };
  }
}

// The Workbench kill switch also stops NOVA acting on this computer.
function halted(store) { try { return typeof store.getGlobalHalt === 'function' && store.getGlobalHalt() === '1'; } catch (_) { return false; } }
function checkHalt(store) { if (halted(store)) throw error('NOVA is halted (Workbench kill switch), so it will not act on this computer. Resume it in Workbench first.', 423); }
function policy(store) { const p = store.get('preferences', 'computer') || {}; return { enabled: p.enabled !== false, autoRead: Boolean(p.autoRead), screen: p.screen !== false }; }
function setPolicy(store, input = {}) {
  const cur = store.get('preferences', 'computer') || { id: 'computer' };
  const next = { ...cur, id: 'computer', updatedAt: new Date().toISOString() };
  for (const k of ['enabled', 'autoRead', 'screen']) if (typeof input[k] === 'boolean') next[k] = input[k];
  store.put('preferences', next);
  return policy(store);
}

/** Waits for the person to decide. Resolves 'allow' | 'always' | 'deny'. */
function approve(store, { sessionId, tool, args, signal }) {
  const spec = BY_NAME.get(tool);
  const p = policy(store);
  if (tool !== 'use_folder' && (sessionAllow.get(sessionId) || new Set()).has(tool)) return { promise: Promise.resolve('allow'), auto: 'Allowed for this chat' };
  if (tool === 'use_folder') { /* always asks: a folder is a new permission */ }
  else if (p.autoRead && spec && spec.risk === 'read') return { promise: Promise.resolve('allow'), auto: 'Read-only: allowed by your settings' };
  const id = 'apr_' + crypto.randomBytes(6).toString('hex');
  const info = { id, sessionId, tool, risk: spec ? spec.risk : 'change', ...describe(tool, args), requestedAt: new Date().toISOString() };
  const promise = new Promise(resolve => {
    const finish = (d) => { const e = pending.get(id); if (!e) return; clearTimeout(e.timer); pending.delete(id); emit({ type: 'approval.resolved', id, decision: d }); resolve(d); };
    const timer = setTimeout(() => finish('deny'), 10 * 60 * 1000);
    pending.set(id, { info, finish, timer });
    if (signal) signal.addEventListener('abort', () => finish('deny'), { once: true });
  });
  emit({ type: 'approval.requested', approval: info });
  return { promise, info };
}
function decide(id, decision) {
  const e = pending.get(id);
  if (!e) throw error('That request was already answered or has expired.', 404);
  const d = ['allow', 'always', 'deny'].includes(decision) ? decision : 'deny';
  if (d === 'always') { const set = sessionAllow.get(e.info.sessionId) || new Set(); set.add(e.info.tool); sessionAllow.set(e.info.sessionId, set); }
  e.finish(d);
  return { ok: true, decision: d };
}
function pendingApprovals(sessionId) { return [...pending.values()].map(e => e.info).filter(i => !sessionId || i.sessionId === sessionId); }
function forgetSession(sessionId) { sessionAllow.delete(sessionId); }
function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch (_) {} } }
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* ----------------------------------------------------------------- execute */

/** ctx: {store, dataDir, sessionId, roots, signal} */
async function execute(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const p = policy(ctx.store);
  checkHalt(ctx.store);
  if (!p.enabled) throw error('Computer access is turned off in Settings.', 403);
  if (SCREEN_TOOLS.has(name) && !p.screen) throw error('Seeing and controlling the screen is turned off in Settings.', 403);
  switch (name) {
    case 'run_command': return runCommand(a, ctx.roots, ctx.signal);
    case 'open': return openTarget(a, ctx.roots);
    case 'screenshot': return screenshot(ctx);
    case 'click': return click(a, ctx);
    case 'type_text': return typeText(a);
    case 'press_key': return pressKey(a);
    case 'scroll': return scroll(a);
    case 'clipboard_read': return clipboardRead();
    case 'clipboard_write': return clipboardWrite(a);
    case 'list_files': return listFiles(a, ctx.roots);
    case 'read_file': return readFile(a, ctx.roots);
    case 'write_file': return writeFile(a, ctx.roots);
    case 'move_file': return moveFile(a, ctx.roots);
    case 'make_folder': return makeFolder(a, ctx.roots);
    case 'move_to_trash': return moveToTrash(a, ctx.roots);
    case 'use_folder': throw error('use_folder is handled by the conversation.');
    default: throw error('Unknown tool: ' + name);
  }
}

/** What works on this Mac right now, for Settings and Diagnostics. */
async function status() {
  const out = { platform: process.platform, mac: IS_MAC, shell: fs.existsSync('/bin/zsh') ? 'zsh' : 'bash', screen: false, accessibility: null, notes: [] };
  if (!IS_MAC) { out.notes.push('Screen, clipboard and app tools work on macOS only; commands and file tools work here.'); return out; }
  out.screen = true;
  try { out.accessibility = (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()'])).trim() === 'true'; } catch (_) { out.accessibility = null; }
  if (out.accessibility === false) out.notes.push('To click and type, allow NOVA Runtime (or Terminal, in browser mode) in System Settings > Privacy & Security > Accessibility.');
  out.notes.push('To see windows (not only the wallpaper) in screenshots, allow it in System Settings > Privacy & Security > Screen Recording.');
  return out;
}

function shotFile(dataDir, name) {
  if (!/^shot-[\w]+\.jpg$/.test(name)) throw error('Not found', 404);
  const f = path.join(dataDir, 'computer', name);
  if (!fs.existsSync(f)) throw error('Not found', 404);
  return f;
}

function workspaceRoots(store) {
  return store.all('workspaceRoots').map(r => { try { return fs.realpathSync.native(r.path); } catch (_) { return null; } }).filter(Boolean);
}

function _reset() { for (const e of pending.values()) clearTimeout(e.timer); pending.clear(); sessionAllow.clear(); shots.clear(); listeners.clear(); }

module.exports = { halted, checkHalt, folderPath, TOOLS, SCREEN_TOOLS, toolSpecs, execute, approve, decide, pendingApprovals, forgetSession, subscribe, policy, setPolicy, status, describe, checkCommand, insideRoots, shotFile, workspaceRoots, _reset };
