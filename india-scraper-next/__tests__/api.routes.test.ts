/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock the db module before importing the routes
jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: {
    all: jest.fn(),
    get: jest.fn(),
    run: jest.fn(),
  },
}));

import db from '@/lib/db';
import { GET as districtsGET } from '@/app/api/districts/route';
import { GET as historyGET } from '@/app/api/history-results/route';
import { GET as refinedGET } from '@/app/api/refined-results/route';

const mockedDb = db as unknown as {
  all: jest.Mock;
  get: jest.Mock;
  run: jest.Mock;
};

function mockAll(rows: any[], err: Error | null = null) {
  mockedDb.all.mockImplementation((sql: string, paramsOrCb: any, cb?: any) => {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    callback(err, rows);
  });
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new Request(url, { headers: { Host: new URL(url).host } }));
}

describe('GET /api/districts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects absent or nonlocal Host headers before accessing the database', async () => {
    for (const host of [undefined, 'attacker.example', 'localhost.attacker.example']) {
      const req = new NextRequest('http://localhost/api/districts', { headers: host ? { Host: host } : {} });
      expect((await districtsGET(req)).status).toBe(403);
    }
    expect(mockedDb.all).not.toHaveBeenCalled();
  });

  it('returns list of districts', async () => {
    const rows = [
      { id: 1, name: 'Anantapur', state: 'Andhra Pradesh' },
      { id: 2, name: 'Pune', state: 'Maharashtra' },
    ];
    mockAll(rows);
    const res = await districtsGET(makeRequest('http://localhost/api/districts'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual(rows);
    expect(mockedDb.all).toHaveBeenCalledWith(
      expect.stringContaining('FROM districts'),
      expect.any(Function)
    );
  });

  it('orders by name', async () => {
    mockAll([]);
    await districtsGET(makeRequest('http://localhost/api/districts'));
    expect(mockedDb.all.mock.calls[0][0]).toContain('ORDER BY name');
  });

  it('returns empty array when no districts', async () => {
    mockAll([]);
    const res = await districtsGET(makeRequest('http://localhost/api/districts'));
    expect(await res.json()).toEqual([]);
  });

  it('propagates db errors (rejects)', async () => {
    mockAll([], new Error('db failure'));
    await expect(districtsGET(makeRequest('http://localhost/api/districts'))).rejects.toThrow('db failure');
  });
});

describe('GET /api/history-results', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all history rows without filters', async () => {
    const rows = [{ id: 1, business_name: 'Shop', district_name: 'Pune' }];
    mockAll(rows);
    const res = await historyGET(makeRequest('http://localhost/api/history-results'));
    const data = await res.json();
    expect(data).toEqual(rows);
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('FROM scraped_data');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });

  it('filters by category', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results?category=plumbers'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('h.category = ?');
    expect(params).toContain('plumbers');
  });

  it('filters by district_id and parses it as integer', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results?district_id=7'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('h.district_id = ?');
    expect(params).toContain(7);
  });

  it('combines category and district filters with AND', async () => {
    mockAll([]);
    await historyGET(
      makeRequest('http://localhost/api/history-results?category=a&district_id=3')
    );
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('h.category = ? AND h.district_id = ?');
    expect(params).toEqual(['a', 3]);
  });

  it('limits results to 1000 and orders by scraped_at DESC', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results'));
    const [sql] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('ORDER BY h.scraped_at DESC LIMIT 1000');
  });

  it('ignores empty-string category param', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results?category='));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });
});

describe('GET /api/refined-results', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns refined rows without filters', async () => {
    const rows = [{ id: 1, business_name: 'Cafe', district_name: 'Jaipur' }];
    mockAll(rows);
    const res = await refinedGET(makeRequest('http://localhost/api/refined-results'));
    expect(await res.json()).toEqual(rows);
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('FROM refined_data');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });

  it('filters by category', async () => {
    mockAll([]);
    await refinedGET(makeRequest('http://localhost/api/refined-results?category=dentists'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('r.category = ?');
    expect(params).toEqual(['dentists']);
  });

  it('filters by district_id', async () => {
    mockAll([]);
    await refinedGET(makeRequest('http://localhost/api/refined-results?district_id=11'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('r.district_id = ?');
    expect(params).toEqual([11]);
  });

  it('combines both filters', async () => {
    mockAll([]);
    await refinedGET(
      makeRequest('http://localhost/api/refined-results?category=x&district_id=2')
    );
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('r.category = ? AND r.district_id = ?');
    expect(params).toEqual(['x', 2]);
  });

  it('limits to 500 and orders by last_updated DESC', async () => {
    mockAll([]);
    await refinedGET(makeRequest('http://localhost/api/refined-results'));
    const [sql] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('ORDER BY r.last_updated DESC LIMIT 500');
  });
});
