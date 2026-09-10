const DELIVERY_MILESTONES = [
  { id: 'locations', title: 'Location catalogue', status: 'complete', commit: 'b724494', date: '2026-09-09', href: '/locations', evidence: '/api/roadmap/evidence/TLPS-VALIDATION.md' },
  { id: 'collection', title: 'District collection engine', status: 'in_progress', commit: '7118357', date: '2026-09-09', href: '/event-planners', evidence: '/api/roadmap/evidence/EVENT-PLANNERS.md' },
  { id: 'studio', title: 'Search designer', status: 'complete', commit: 'e6abf6b', date: '2026-09-10', href: '/event-planners/studio', evidence: '/api/roadmap/evidence/QUERY-STUDIO.md' },
  { id: 'map', title: 'Live planner map', status: 'complete', commit: '3298494', date: '2026-09-11', href: '/event-planners/studio', evidence: '/api/roadmap/evidence/QUERY-STUDIO.md' },
  { id: 'maataa', title: 'Maataa local conversations', status: 'complete', commit: 'ea2773a', date: '2026-09-11', href: '/#maataa-conversation', evidence: '/api/roadmap/evidence/MAATAA-LOCAL-WORKSPACE.md' },
  { id: 'helpers', title: 'Helpers and scheduler', status: 'complete', commit: '8974fc5', date: '2026-09-11', href: '/helpers', evidence: '/api/roadmap/evidence/HELPERS-AND-SCHEDULER.md' },
  { id: 'coverage', title: 'All-district collection', status: 'in_progress', commit: null, date: null, href: '/event-planners', evidence: '/api/roadmap/evidence/EVENT-PLANNERS.md' },
  { id: 'release', title: 'Packaged local release', status: 'planned', commit: null, date: null, href: null, evidence: null },
];

function collectionView(summary) {
  const counts = Object.fromEntries((summary?.counts || []).map((row) => [row.status, Number(row.count) || 0]));
  const total = Number(summary?.totalDistricts) || 0;
  const active = counts.running || 0;
  const pending = counts.pending || 0;
  const completed = Math.max(0, total - pending - active);
  return {
    total,
    completed,
    pending,
    active,
    businesses: Number(summary?.uniqueBusinesses) || 0,
    percent: total ? Math.round((completed / total) * 1000) / 10 : 0,
    runnerState: summary?.runnerState || 'not started',
    pauseReason: summary?.pauseReason || null,
    lastProgressAt: summary?.lastProgressAt || null,
  };
}

function workspaceView(snapshot) {
  const conversations = snapshot?.conversations || [];
  const publications = snapshot?.publications || [];
  return {
    conversations: conversations.length,
    published: publications.filter((item) => item.status === 'published').length,
    drafts: publications.filter((item) => item.status === 'draft').length,
    recentConversations: conversations.slice(0, 5),
    recentPublications: publications.slice(0, 5),
  };
}

function helpersView(snapshot, now = Date.now()) {
  const helpers = snapshot?.helpers || [];
  const runs = snapshot?.runs || [];
  const heartbeat = snapshot?.worker?.heartbeat || null;
  const schedulerAvailable = Boolean(heartbeat && now - Date.parse(heartbeat) < 240000);
  return {
    total: helpers.length,
    scheduled: helpers.filter((item) => item.enabled).length,
    schedulerAvailable,
    heartbeat,
    waiting: runs.filter((item) => item.status === 'queued').length,
    working: runs.filter((item) => item.status === 'running').length,
    ready: runs.filter((item) => item.status === 'complete').length,
    needsAttention: runs.filter((item) => item.status === 'failed').length,
    recentRuns: runs.slice(0, 5),
  };
}

module.exports = { DELIVERY_MILESTONES, collectionView, workspaceView, helpersView };
