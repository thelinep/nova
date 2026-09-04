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

export function createJob(jobId: string, category: string, total: number): Job {
  const job: Job = { jobId, category, total, completed: 0, status: 'running', startTime: new Date().toISOString() };
  jobs[jobId] = job;
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
