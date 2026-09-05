/**
 * @jest-environment node
 */
import { chunkText, chunkBusinessRecord } from '@/lib/knowledge/chunker';

describe('chunkText', () => {
  it('splits text into word-based chunks with overlap', () => {
    const text = 'one two three four five six seven eight nine ten';
    const chunks = chunkText(text, { size: 4, overlap: 2 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content.split(' ').length).toBeLessThanOrEqual(4);
  });

  it('returns empty array for empty input', () => {
    expect(chunkText('', { size: 10 })).toEqual([]);
  });

  it('supports sentence splitting', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const chunks = chunkText(text, { splitBy: 'sentence', size: 2 });
    expect(chunks.length).toBe(2);
  });

  it('supports line splitting', () => {
    const text = 'line1\nline2\nline3\nline4';
    const chunks = chunkText(text, { splitBy: 'line', size: 2 });
    expect(chunks.length).toBe(2);
  });
});

describe('chunkBusinessRecord', () => {
  it('creates a single chunk from a business record', () => {
    const chunks = chunkBusinessRecord({
      id: 1,
      business_name: 'Test Cafe',
      category: 'cafe',
      phone: '1234567890',
      address: 'Main St',
      rating: '4.5',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Test Cafe');
    expect(chunks[0].content).toContain('Category: cafe');
    expect(chunks[0].content).toContain('Phone: 1234567890');
  });

  it('returns empty array when record has no useful fields', () => {
    expect(chunkBusinessRecord({ id: 1 })).toEqual([]);
  });
});
