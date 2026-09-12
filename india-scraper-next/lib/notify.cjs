// Notification helper: macOS Notification Center banner + a persistent log
// file. Both are best-effort — a failed notification never crashes the
// caller, and this module has no dependency on sqlite3/puppeteer.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function logPath() {
  return path.join(__dirname, '..', 'data', 'event-planners', 'supervisor.log');
}

function logLine(line) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), stamped);
  } catch {
    // best effort only — never let logging failures break the supervisor
  }
  process.stdout.write(stamped);
}

// Passed as a single argv element to osascript (no shell involved), so
// nothing in `title`/`message` can break out into a shell command. AppleScript
// string-literal escaping happens to line up with JSON string escaping for
// quotes and backslashes, which covers everything these messages contain.
function macNotify(title, message) {
  if (process.platform !== 'darwin') return false;
  try {
    const script =
      `display notification ${JSON.stringify(String(message))} ` +
      `with title ${JSON.stringify(String(title))} sound name "Glass"`;
    execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function notify(title, message) {
  logLine(`[ALERT] ${title} — ${message}`);
  const delivered = macNotify(title, message);
  if (!delivered && process.platform === 'darwin') {
    logLine('  (native notification delivery failed; see above log line)');
  }
}

module.exports = { notify, logLine, logPath };
