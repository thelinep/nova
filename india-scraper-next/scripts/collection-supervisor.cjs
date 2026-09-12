#!/usr/bin/env node
// Supervises scripts/collect-event-planners.cjs so a run can actually reach
// completion unattended:
//   - restarts the collector after any recoverable halt, with backoff
//   - refuses to (re)start if free disk space is low (the collector's last
//     crash was ENOSPC; racing back into that helps no one)
//   - never bypasses a Google access-challenge pause — that one stops the
//     supervisor for good and asks for a human, exactly as the collector
//     script itself intends
//   - gives failed districts one retry pass with --retry-failed once the
//     main pass is otherwise finished
//   - fires milestone notifications (progress thresholds, states finishing,
//     halts, completion) to macOS Notification Center and a log file
//
// Run with: node scripts/collection-supervisor.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { notify, logLine } = require('../lib/notify.cjs');
const { THRESHOLDS, percentComplete, crossedThresholds, newlyCompletedStates } = require('../lib/collection-milestones.cjs');

const repoRoot = path.join(__dirname, '..');
const dataRoot = path.join(repoRoot, 'data', 'event-planners');
const statusPath = path.join(dataRoot, 'status.json');
const supervisorStatePath = path.join(dataRoot, 'supervisor-state.json');
const collectorScript = path.join(__dirname, 'collect-event-planners.cjs');

const MAX_ATTEMPTS = 20;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]; // caps at 5 minutes
const DISK_FREE_MIN_BYTES = 1_000_000_000; // refuse to (re)start under 1 GB free

function backoffFor(attemptIndex) {
  return BACKOFF_MS[Math.min(attemptIndex, BACKOFF_MS.length - 1)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function defaultSupervisorState() {
  return { alertedThresholds: [], alertedStates: [], retriedFailedOnce: false };
}

function loadSupervisorState() {
  return { ...defaultSupervisorState(), ...loadJson(supervisorStatePath, {}) };
}

function saveSupervisorState(state) {
  fs.writeFileSync(supervisorStatePath, JSON.stringify(state, null, 2) + '\n');
}

function readStatus() {
  return loadJson(statusPath, null);
}

// On the very first run of the supervisor, silently mark whatever is already
// true (progress already past a threshold, states already fully attempted)
// as "alerted" so we don't fire a burst of stale notifications for work done
// before supervision started.
function seedBaseline(state, status) {
  if (!status) return;
  const pct = percentComplete(status);
  for (const t of THRESHOLDS) {
    if (pct >= t && !state.alertedThresholds.includes(t)) state.alertedThresholds.push(t);
  }
  for (const s of status.states || []) {
    if (s.total > 0 && s.attempted >= s.total && !state.alertedStates.includes(s.state)) {
      state.alertedStates.push(s.state);
    }
  }
}

function checkMilestones(state, prevStatus, currStatus) {
  if (!currStatus) return;
  const prevPct = prevStatus ? percentComplete(prevStatus) : 0;
  const currPct = percentComplete(currStatus);
  for (const t of crossedThresholds(prevPct, currPct)) {
    if (!state.alertedThresholds.includes(t)) {
      state.alertedThresholds.push(t);
      notify(
        'Collection progress',
        `${t}% of districts attempted — ${currStatus.uniqueBusinesses ?? '?'} businesses collected so far.`,
      );
    }
  }
  for (const s of newlyCompletedStates(prevStatus?.states, currStatus.states)) {
    if (!state.alertedStates.includes(s)) {
      state.alertedStates.push(s);
      notify('State complete', `${s}: every district in this state has now been attempted.`);
    }
  }
}

function freeBytes() {
  try {
    const out = execFileSync('df', ['-k', dataRoot], { encoding: 'utf8' });
    const line = out.trim().split('\n').pop();
    const cols = line.trim().split(/\s+/);
    const availKb = Number(cols[3]);
    return Number.isFinite(availKb) ? availKb * 1024 : null;
  } catch {
    return null;
  }
}

function statusCounts(status) {
  return Object.fromEntries((status?.counts || []).map((c) => [c.status, Number(c.count) || 0]));
}

function runCollectorOnce(extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [collectorScript, ...extraArgs], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) logLine(line.trim());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => {
      logLine(`spawn error: ${err.message}`);
      resolve(-1);
    });
  });
}

async function main() {
  const isFirstRun = !fs.existsSync(supervisorStatePath);
  const state = loadSupervisorState();
  let prevStatus = readStatus();
  if (isFirstRun) seedBaseline(state, prevStatus);
  saveSupervisorState(state);

  const startPct = prevStatus ? percentComplete(prevStatus) : 0;
  notify('Collection supervisor started', `Resuming at ${startPct}% complete.`);

  let attempt = 0;
  let nextArgs = [];
  while (attempt < MAX_ATTEMPTS) {
    const free = freeBytes();
    if (free !== null && free < DISK_FREE_MIN_BYTES) {
      notify(
        'Collection supervisor stopped',
        `Only ${(free / 1e9).toFixed(1)} GB free on disk — refusing to start another run. Free up space, then rerun the supervisor.`,
      );
      return;
    }

    logLine(`Launching collector (attempt ${attempt + 1}/${MAX_ATTEMPTS})${nextArgs.length ? ' ' + nextArgs.join(' ') : ''}...`);
    const exitCode = await runCollectorOnce(nextArgs);
    nextArgs = [];

    const currStatus = readStatus();
    checkMilestones(state, prevStatus, currStatus);
    saveSupervisorState(state);
    prevStatus = currStatus;

    const runnerState = currStatus?.runnerState;
    const pauseReason = String(currStatus?.pauseReason || '');
    const lastError = String(currStatus?.lastError || '');
    const counts = statusCounts(currStatus);
    const failedLeft = counts.failed || 0;

    if (runnerState === 'finished') {
      if (failedLeft > 0 && !state.retriedFailedOnce) {
        state.retriedFailedOnce = true;
        saveSupervisorState(state);
        notify('Retrying failed districts', `${failedLeft} district(s) failed on the first pass — giving them one retry.`);
        nextArgs = ['--retry-failed'];
        attempt++;
        continue;
      }
      notify(
        'Collection finished',
        `All districts attempted. ${currStatus.uniqueBusinesses ?? '?'} businesses collected, ${currStatus.matchedPlanners ?? '?'} matched as event planners.`,
      );
      return;
    }

    if (runnerState === 'paused' && /access challenge|consent|traffic challenge/i.test(pauseReason)) {
      notify(
        'Collection needs you',
        `Stopped for a Google access challenge: "${pauseReason}". This needs manual review — the supervisor will not retry automatically.`,
      );
      return;
    }

    if (/ENOSPC|no space left/i.test(lastError)) {
      notify('Collection stopped: disk full', `${lastError}. Free up disk space, then rerun the supervisor.`);
      return;
    }

    if (runnerState === 'paused') {
      notify('Collection paused, restarting', pauseReason || 'Halted for an unspecified reason; restarting.');
    } else if (exitCode !== 0 || runnerState === 'failed') {
      notify('Collector crashed, restarting', lastError || `Exit code ${exitCode}`);
    }

    attempt++;
    if (attempt >= MAX_ATTEMPTS) {
      notify(
        'Collection supervisor giving up',
        `Stopped after ${MAX_ATTEMPTS} restart attempts. Last state: ${runnerState || 'unknown'} — ${pauseReason || lastError || 'no detail available'}.`,
      );
      return;
    }
    const wait = backoffFor(attempt - 1);
    logLine(`Restarting in ${Math.round(wait / 1000)}s...`);
    await sleep(wait);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logLine(`FATAL supervisor error: ${error.stack || error.message}`);
    notify('Collection supervisor crashed', error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkMilestones, seedBaseline };
