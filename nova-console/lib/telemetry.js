'use strict';
/* ===========================================================================
 * NOVA Runtime — telemetry
 *
 * CPU and RAM are real on every platform, read from Node's own `os` module
 * (no library needed — os.cpus() deltas give real per-core busy time, and
 * os.totalmem/freemem give real memory pressure). GPU/VRAM has no portable
 * Node API, so this shells out to whatever the platform actually exposes
 * (nvidia-smi on a machine with an NVIDIA GPU, powermetrics/ioreg on a Mac)
 * and reports `available:false` when none of those exist — per the
 * roadmap's own rule for this phase: unavailable, never faked.
 * ========================================================================= */
const os = require('node:os');
const { execFile } = require('node:child_process');

function cpuSnapshot() {
  return os.cpus().map(c => ({ ...c.times }));
}

/** CPU busy % since the last snapshot, per Node's docs recipe for
 *  os.cpus() deltas (a single point-in-time read of os.cpus() times is
 *  cumulative since boot, not a live percentage — you need two reads). */
function cpuPercentFromDelta(prev, curr) {
  if (!prev || prev.length !== curr.length) return null;
  let idleDelta = 0, totalDelta = 0;
  for (let i = 0; i < curr.length; i++) {
    const p = prev[i], c = curr[i];
    const idle = c.idle - p.idle;
    const total = (c.user - p.user) + (c.nice - p.nice) + (c.sys - p.sys) + (c.idle - p.idle) + (c.irq - p.irq);
    idleDelta += idle; totalDelta += total;
  }
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
}

function execFileP(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs || 1200 }, (err, stdout) => {
      if (err) resolve(null); else resolve(stdout.toString());
    });
  });
}

/** Best-effort GPU/VRAM read. Tries, in order: nvidia-smi (NVIDIA, any OS),
 *  then macOS `system_profiler SPDisplaysDataType` for VRAM size (Apple
 *  Silicon shares system memory, so "VRAM" there is the unified memory
 *  pool — reported as such, not invented as a separate number). Returns
 *  null fields (never 0, never a guess) when nothing is available. */
async function readGpu() {
  const nvidia = await execFileP('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits',
  ]);
  if (nvidia) {
    const line = nvidia.trim().split('\n')[0];
    const [util, used, total] = line.split(',').map(s => parseFloat(s.trim()));
    if (Number.isFinite(util)) {
      return { available: true, source: 'nvidia-smi', utilPercent: util, vramUsedGb: used / 1024, vramTotalGb: total / 1024 };
    }
  }
  if (process.platform === 'darwin') {
    const profile = await execFileP('system_profiler', ['SPDisplaysDataType', '-json'], 2000);
    if (profile) {
      try {
        const parsed = JSON.parse(profile);
        const gpu = (parsed.SPDisplaysDataType || [])[0];
        const vramStr = gpu && (gpu.sppci_vram || gpu.spdisplays_vram || gpu.spdisplays_vram_shared);
        const vramGb = vramStr ? parseFloat(vramStr) / (/GB/i.test(vramStr) ? 1 : 1024) : null;
        // Apple Silicon has no separate utilization counter exposed here —
        // report the memory pool honestly, leave utilization unavailable.
        return { available: vramGb != null, source: 'system_profiler', utilPercent: null, vramUsedGb: null, vramTotalGb: vramGb };
      } catch { /* fall through to unavailable */ }
    }
  }
  return { available: false, source: null, utilPercent: null, vramUsedGb: null, vramTotalGb: null };
}

class TelemetryReader {
  constructor() {
    this._prevCpu = cpuSnapshot();
    this._lastGpu = null;
    this._lastGpuAt = 0;
  }

  async read() {
    const curr = cpuSnapshot();
    const cpuPercent = cpuPercentFromDelta(this._prevCpu, curr);
    this._prevCpu = curr;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // GPU probing shells out to another process — cache for a couple of
    // seconds so a 1.4s poll loop doesn't spawn nvidia-smi 40x/minute.
    const now = Date.now();
    if (!this._lastGpu || now - this._lastGpuAt > 2000) {
      this._lastGpu = await readGpu();
      this._lastGpuAt = now;
    }

    return {
      cpu: { percent: cpuPercent, cores: curr.length, loadAvg: os.loadavg() },
      ram: { usedGb: usedMem / 1e9, totalGb: totalMem / 1e9 },
      gpu: this._lastGpu,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: os.uptime(),
      sampledAt: new Date().toISOString(),
    };
  }
}

module.exports = { TelemetryReader };
