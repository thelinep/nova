/**
 * @jest-environment node
 */
import { createEmbedder, cosineSimilarity } from '@/lib/knowledge/embedder';

describe('hash embedder', () => {
  it('produces normalized vectors', async () => {
    const embedder = createEmbedder('hash');
    const vec = await embedder.embed('hello world');
    expect(vec.length).toBe(384);
    const magnitude = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('returns identical embeddings for identical text', async () => {
    const embedder = createEmbedder('hash');
    const a = await embedder.embed('test phrase');
    const b = await embedder.embed('test phrase');
    expect(a).toEqual(b);
  });

  it('batch embeds multiple texts', async () => {
    const embedder = createEmbedder('hash');
    const vecs = await embedder.embedBatch(['a', 'b', 'c']);
    expect(vecs).toHaveLength(3);
    vecs.forEach(v => expect(v.length).toBe(384));
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});
