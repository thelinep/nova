'use strict';
/* ===========================================================================
 * ComfyUI watchdog
 *
 * Runs ComfyUI as its own child and stops it when NOVA goes away, however
 * NOVA ends (quit, crash or a forced kill from the desktop app), so a
 * multi-gigabyte Python process is never left running on its own.
 *
 *   node comfy-watchdog.js <nova-pid> <program> [args…]
 * ========================================================================= */
const { spawn } = require('node:child_process');

const [parentPid, program, ...args] = process.argv.slice(2);
const parent = Number(parentPid);
const child = spawn(program, args, { stdio: 'inherit' });

let stopping = false;
function stop(code) {
  if (stopping) return; stopping = true;
  try { child.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} process.exit(code); }, 8000).unref();
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

const timer = setInterval(() => { if (!alive(parent)) stop(0); }, 2000);
child.on('exit', (code, signal) => { clearInterval(timer); process.exit(code == null ? (signal ? 1 : 0) : code); });
child.on('error', e => { console.error('[watchdog] could not start ComfyUI: ' + e.message); process.exit(127); });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop(0));
