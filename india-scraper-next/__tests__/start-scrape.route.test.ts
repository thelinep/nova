/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: { all: jest.fn() },
}));
jest.mock('@/lib/scraper', () => ({ scrapeDistrict: jest.fn() }));
jest.mock('@/lib/districtSeeder', () => ({ seedDistricts: jest.fn() }));
jest.mock('@/lib/jobs', () => ({
  createJob: jest.fn((id: string, cat: string, total: number) => ({
    jobId: id, category: cat, total, completed: 0, status: 'running', startTime: new Date().toISOString(),
  })),
  incrementJobCompleted: jest.fn(),
}));

import db from '@/lib/db';
import { scrapeDistrict } from '@/lib/scraper';
import { seedDistricts } from '@/lib/districtSeeder';
import { createJob, incrementJobCompleted } from '@/lib/jobs';
import { POST } from '@/app/api/start-scrape/route';

const mockedDb = db as unknown as { all: jest.Mock };
const mockedScrape = scrapeDistrict as jest.Mock;
const mockedSeed = seedDistricts as jest.Mock;
const mockedCreateJob = createJob as jest.Mock;
const mockedIncrement = incrementJobCompleted as jest.Mock;

function post(body: any): NextRequest {
  return new NextRequest(
    new Request('http://localhost/api/start-scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'localhost' },
      body: JSON.stringify(body),
    })
  );
}

function mockDistricts(rows: any[], onSecondCall?: any[]) {
  let call = 0;
  mockedDb.all.mockImplementation((sql: string, cb: any) => {
    call++;
    if (call === 1) cb(null, rows);
    else cb(null, onSecondCall ?? rows);
  });
}

// Flush the fire-and-forget background async work
async function flushBackground(times = 20) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('POST /api/start-scrape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CONCURRENCY;
    mockedScrape.mockResolvedValue(3);
  });
  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
    (console.error as jest.Mock).mockRestore();
  });

  it('returns 400 when category is missing', async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Category is required' });
  });

  it('returns 400 when category is empty string', async () => {
    const res = await POST(post({ category: '' }));
    expect(res.status).toBe(400);
  });

  it('starts scraping with existing districts and returns jobId + total', async () => {
    mockDistricts([
      { id: 1, name: 'Pune' },
      { id: 2, name: 'Jaipur' },
    ]);
    const res = await POST(post({ category: 'plumbers' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.message).toBe('Scraping started');
    expect(typeof data.jobId).toBe('string');
    expect(mockedCreateJob).toHaveBeenCalledWith(data.jobId, 'plumbers', 2);
    expect(mockedSeed).not.toHaveBeenCalled();
  });

  it('invokes scrapeDistrict for every district in background', async () => {
    mockDistricts([
      { id: 1, name: 'Pune' },
      { id: 2, name: 'Jaipur' },
      { id: 3, name: 'Surat' },
    ]);
    await POST(post({ category: 'dentists' }));
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledTimes(3);
    expect(mockedScrape).toHaveBeenCalledWith('dentists', 'Pune', 1);
    expect(mockedScrape).toHaveBeenCalledWith('dentists', 'Jaipur', 2);
    expect(mockedScrape).toHaveBeenCalledWith('dentists', 'Surat', 3);
    expect(mockedIncrement).toHaveBeenCalledTimes(3);
  });

  it('seeds districts when table is empty, then scrapes', async () => {
    mockDistricts([], [{ id: 9, name: 'NewDistrict' }]);
    const res = await POST(post({ category: 'cafes' }));
    expect(mockedSeed).toHaveBeenCalled();
    const data = await res.json();
    expect(data.total).toBe(1);
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledWith('cafes', 'NewDistrict', 9);
  });

  it('returns 500 when no districts exist even after seeding', async () => {
    mockDistricts([], []);
    const res = await POST(post({ category: 'cafes' }));
    expect(mockedSeed).toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'No districts found' });
    expect(mockedScrape).not.toHaveBeenCalled();
  });

  it('continues scraping other districts when one fails', async () => {
    mockDistricts([
      { id: 1, name: 'Good' },
      { id: 2, name: 'Bad' },
      { id: 3, name: 'AlsoGood' },
    ]);
    mockedScrape.mockImplementation((cat: string, name: string) =>
      name === 'Bad' ? Promise.reject(new Error('boom')) : Promise.resolve(5)
    );
    await POST(post({ category: 'x' }));
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledTimes(3);
    // increment still called for the failed one (in finally)
    expect(mockedIncrement).toHaveBeenCalledTimes(3);
  });

  it('caps worker count to number of districts', async () => {
    process.env.CONCURRENCY = '10';
    mockDistricts([{ id: 1, name: 'Only' }]);
    await POST(post({ category: 'x' }));
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledTimes(1);
  });
});
