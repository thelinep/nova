/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/jobs', () => ({
  getJob: jest.fn(),
}));

import { getJob } from '@/lib/jobs';
import { GET } from '@/app/api/job/[jobId]/route';

const mockedGetJob = getJob as jest.Mock;

function makeRequest(): NextRequest {
  return new NextRequest(new Request('http://localhost/api/job/abc'));
}

function ctx(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

describe('GET /api/job/[jobId]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the job when found', async () => {
    const job = {
      jobId: 'abc',
      category: 'plumbers',
      total: 10,
      completed: 4,
      status: 'running',
      startTime: new Date().toISOString(),
    };
    mockedGetJob.mockReturnValue(job);
    const res = await GET(makeRequest(), ctx('abc'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(job);
    expect(mockedGetJob).toHaveBeenCalledWith('abc');
  });

  it('returns 404 when job not found', async () => {
    mockedGetJob.mockReturnValue(undefined);
    const res = await GET(makeRequest(), ctx('missing'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data).toEqual({ error: 'Job not found' });
  });

  it('awaits params promise (Next 16 async params)', async () => {
    mockedGetJob.mockReturnValue(undefined);
    // Should not throw even though params is a Promise
    await expect(GET(makeRequest(), ctx('xyz'))).resolves.toBeDefined();
    expect(mockedGetJob).toHaveBeenCalledWith('xyz');
  });
});
