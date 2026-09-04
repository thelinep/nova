jest.mock('@/lib/db', () => ({ __esModule: true, default: { run: jest.fn(), all: jest.fn() } }));

import { expandUrlPattern, validateCollectionUrl } from '@/lib/knowledge';

describe('knowledge collection guards', () => {
  it.each(['http://localhost:3000/a', 'http://127.0.0.1/a', 'http://10.1.2.3/a', 'http://192.168.0.5/a', 'file:///tmp/a', 'https://user:pass@example.com/a'])(
    'rejects unsafe collection URL %s', (url) => expect(() => validateCollectionUrl(url)).toThrow(),
  );

  it('normalizes a public HTTP URL', () => {
    expect(validateCollectionUrl('https://example.org/a path')).toBe('https://example.org/a%20path');
  });

  it('expands bounded numbered URL patterns', () => {
    expect(expandUrlPattern('https://example.org/page/{n}', 2, 4)).toEqual([
      'https://example.org/page/2', 'https://example.org/page/3', 'https://example.org/page/4',
    ]);
  });

  it('requires a pattern placeholder and a bounded range', () => {
    expect(() => expandUrlPattern('https://example.org/page', 1, 2)).toThrow('{n}');
    expect(() => expandUrlPattern('https://example.org/page/{n}', 1, 51)).toThrow('up to 50');
  });
});
