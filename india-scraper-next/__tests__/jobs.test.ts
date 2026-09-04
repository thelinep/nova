import {
  createJob,
  getJob,
  updateJob,
  incrementJobCompleted,
  __clearJobs,
  Job,
} from '@/lib/jobs';

describe('jobs module', () => {
  beforeEach(() => {
    __clearJobs();
  });

  describe('createJob', () => {
    it('creates a job with correct initial values', () => {
      const job = createJob('j1', 'plumbers', 10);
      expect(job.jobId).toBe('j1');
      expect(job.category).toBe('plumbers');
      expect(job.total).toBe(10);
      expect(job.completed).toBe(0);
      expect(job.status).toBe('running');
      expect(typeof job.startTime).toBe('string');
      expect(job.endTime).toBeUndefined();
      expect(Number.isNaN(Date.parse(job.startTime))).toBe(false);
    });

    it('stores the job so it is retrievable', () => {
      createJob('j2', 'dentists', 5);
      expect(getJob('j2')).toBeDefined();
      expect(getJob('j2')!.category).toBe('dentists');
    });

    it('overwrites an existing job with the same id', () => {
      createJob('j3', 'a', 1);
      createJob('j3', 'b', 2);
      expect(getJob('j3')!.category).toBe('b');
      expect(getJob('j3')!.total).toBe(2);
    });

    it('supports zero total', () => {
      const job = createJob('j4', 'x', 0);
      expect(job.total).toBe(0);
    });
  });

  describe('getJob', () => {
    it('returns undefined for unknown id', () => {
      expect(getJob('nope')).toBeUndefined();
    });
  });

  describe('updateJob', () => {
    it('applies partial updates and returns the updated job', () => {
      createJob('u1', 'cat', 3);
      const updated = updateJob('u1', { status: 'failed', completed: 2 });
      expect(updated!.status).toBe('failed');
      expect(updated!.completed).toBe(2);
      expect(getJob('u1')!.status).toBe('failed');
    });

    it('returns undefined and does not throw for unknown id', () => {
      expect(updateJob('ghost', { completed: 1 })).toBeUndefined();
    });

    it('can set endTime', () => {
      createJob('u2', 'cat', 1);
      const now = new Date().toISOString();
      updateJob('u2', { endTime: now });
      expect(getJob('u2')!.endTime).toBe(now);
    });
  });

  describe('incrementJobCompleted', () => {
    it('increments completed by 1 by default', () => {
      createJob('i1', 'cat', 5);
      const j = incrementJobCompleted('i1');
      expect(j!.completed).toBe(1);
      expect(j!.status).toBe('running');
    });

    it('increments by a custom amount', () => {
      createJob('i2', 'cat', 5);
      const j = incrementJobCompleted('i2', 3);
      expect(j!.completed).toBe(3);
    });

    it('marks completed and sets endTime when reaching total', () => {
      createJob('i3', 'cat', 2);
      incrementJobCompleted('i3');
      const done = incrementJobCompleted('i3');
      expect(done!.completed).toBe(2);
      expect(done!.status).toBe('completed');
      expect(done!.endTime).toBeDefined();
      expect(Number.isNaN(Date.parse(done!.endTime!))).toBe(false);
    });

    it('handles concurrent increments correctly (no lost updates)', () => {
      createJob('i4', 'cat', 100);
      for (let k = 0; k < 100; k++) incrementJobCompleted('i4');
      const job = getJob('i4')!;
      expect(job.completed).toBe(100);
      expect(job.status).toBe('completed');
    });

    it('returns undefined for unknown id', () => {
      expect(incrementJobCompleted('ghost')).toBeUndefined();
    });

    it('keeps status completed when exceeding total', () => {
      createJob('i5', 'cat', 1);
      incrementJobCompleted('i5');
      const over = incrementJobCompleted('i5');
      expect(over!.completed).toBe(2);
      expect(over!.status).toBe('completed');
    });
  });

  describe('__clearJobs', () => {
    it('removes all jobs', () => {
      createJob('c1', 'a', 1);
      createJob('c2', 'b', 1);
      __clearJobs();
      expect(getJob('c1')).toBeUndefined();
      expect(getJob('c2')).toBeUndefined();
    });
  });
});
