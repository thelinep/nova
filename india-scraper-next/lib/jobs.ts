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

export function updateJob(jobId: string, updates: Partial<Job>): void {
  if (jobs[jobId]) {
    jobs[jobId] = { ...jobs[jobId], ...updates };
  }
}
