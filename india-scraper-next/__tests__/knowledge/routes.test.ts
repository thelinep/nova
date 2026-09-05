/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock the knowledge store before importing the routes
jest.mock('@/lib/knowledge/store', () => ({
  __esModule: true,
  KnowledgeStore: jest.fn().mockImplementation(() => ({
    ingestChunks: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([
      {
        chunk: { content: 'hello world', metadata: null },
        source: { source_type: 'text', source_key: 'test', title: 'Test' },
        score: 0.95,
      },
    ]),
  })),
}));

// Mock the db module for the refresh route
jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: {
    all: jest.fn(),
    get: jest.fn(),
    run: jest.fn(),
    prepare: jest.fn(),
  },
}));

import db from '@/lib/db';
import { POST as ingestPOST } from '@/app/api/knowledge/ingest/route';
import { GET as searchGET } from '@/app/api/knowledge/search/route';
import { POST as refreshPOST } from '@/app/api/knowledge/refresh/route';

const mockedDb = db as unknown as {
  all: jest.Mock;
  get: jest.Mock;
  run: jest.Mock;
  prepare: jest.Mock;
};

function makeRequest(url: string, body?: any): NextRequest {
  return new NextRequest(new Request(url, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : undefined));
}

describe('POST /api/knowledge/ingest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when key is missing', async () => {
    const res = await ingestPOST(makeRequest('http://localhost/api/knowledge/ingest', { content: 'hello' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when text content is missing', async () => {
    const res = await ingestPOST(makeRequest('http://localhost/api/knowledge/ingest', { type: 'text', key: 'x' }));
    expect(res.status).toBe(400);
  });

  it('ingests text successfully', async () => {
    mockedDb.run.mockImplementation(function (this: any, sql: string, params: any[], cb: any) {
      const callback = typeof params === 'function' ? params : cb;
      if (sql.includes('INSERT INTO knowledge_sources')) {
        this.lastID = 1;
      }
      callback(null);
    });

    const res = await ingestPOST(makeRequest('http://localhost/api/knowledge/ingest', {
      type: 'text',
      key: 'test:text',
      title: 'Test',
      content: 'hello world',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.chunks).toBeGreaterThan(0);
  });
});

describe('GET /api/knowledge/search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedDb.all.mockImplementation((sql: string, params: any[], cb: any) => {
      const callback = typeof params === 'function' ? params : cb;
      callback(null, []);
    });
  });

  it('returns 400 when query is missing', async () => {
    const res = await searchGET(makeRequest('http://localhost/api/knowledge/search'));
    expect(res.status).toBe(400);
  });

  it('returns search results', async () => {
    const res = await searchGET(makeRequest('http://localhost/api/knowledge/search?q=hello'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.query).toBe('hello');
    expect(Array.isArray(data.results)).toBe(true);
  });
});

describe('POST /api/knowledge/refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedDb.all.mockImplementation((sql: string, params: any[], cb: any) => {
      const callback = typeof params === 'function' ? params : cb;
      callback(null, []);
    });
  });

  it('refines records by category', async () => {
    const res = await refreshPOST(makeRequest('http://localhost/api/knowledge/refresh', { category: 'caterers' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mockedDb.all.mock.calls[0][0]).toContain("category = ?");
  });
});
