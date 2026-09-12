export interface Job {
  jobId: string;
  category: string;
  total: number;
  completed: number;
  status: 'running' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
}

const jobs: Record<string, Job> = {};

// This is an in-memory, process-lifetime store with no external eviction --
// a long-running `next start` that has kicked off many scrape jobs would
// otherwise accumulate job records forever. Cap it by pruning the oldest
// *finished* jobs (never a running one) once the store gets large.
const MAX_JOBS = 200;

function pruneFinishedJobsOverLimit(): void {
  const ids = Object.keys(jobs);
  const excess = ids.length - MAX_JOBS;
  if (excess <= 0) return;
  const finishedIds = ids
    .filter((id) => jobs[id].status !== 'running')
    .sort((a, b) => Date.parse(jobs[a].startTime) - Date.parse(jobs[b].startTime));
  for (const id of finishedIds.slice(0, excess)) delete jobs[id];
}

export function createJob(jobId: string, category: string, total: number): Job {
  const job: Job = { jobId, category, total, completed: 0, status: 'running', startTime: new Date().toISOString() };
  jobs[jobId] = job;
  pruneFinishedJobsOverLimit();
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs[jobId];
}

export function updateJob(jobId: string, updates: Partial<Job>): Job | undefined {
  const current = jobs[jobId];
  if (!current) return undefined;
  jobs[jobId] = { ...current, ...updates };
  return jobs[jobId];
}

export function incrementJobCompleted(jobId: string, by: number = 1): Job | undefined {
  const current = jobs[jobId];
  if (!current) return undefined;
  const completed = current.completed + by;
  const done = completed >= current.total;
  jobs[jobId] = {
    ...current,
    completed,
    ...(done ? { status: 'completed', endTime: new Date().toISOString() } : {}),
  };
  return jobs[jobId];
}

// Test helper
export function __clearJobs(): void {
  for (const key of Object.keys(jobs)) delete jobs[key];
}
