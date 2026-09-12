// Pure functions over the collector's status.json shape — no DB, no native
// deps, safe to import from the supervisor or unit-test standalone.
const THRESHOLDS = [25, 50, 75, 100];

function percentComplete(status) {
  const total = Number(status?.totalDistricts) || 0;
  if (!total) return 0;
  const counts = Object.fromEntries((status.counts || []).map((c) => [c.status, Number(c.count) || 0]));
  const pending = counts.pending || 0;
  const running = counts.running || 0;
  const completed = Math.max(0, total - pending - running);
  return Math.round((completed / total) * 1000) / 10;
}

function crossedThresholds(prevPercent, currPercent) {
  return THRESHOLDS.filter((t) => prevPercent < t && currPercent >= t);
}

function newlyCompletedStates(prevStates, currStates) {
  const prevDone = new Set(
    (prevStates || []).filter((s) => s.total > 0 && s.attempted >= s.total).map((s) => s.state),
  );
  return (currStates || [])
    .filter((s) => s.total > 0 && s.attempted >= s.total && !prevDone.has(s.state))
    .map((s) => s.state);
}

module.exports = { THRESHOLDS, percentComplete, crossedThresholds, newlyCompletedStates };
