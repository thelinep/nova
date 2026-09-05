/**
 * @jest-environment node
 */
import { KnowledgeStore } from '@/lib/knowledge/store';
import db from '@/lib/db';
import { createEmbedder } from '@/lib/knowledge/embedder';

const testEmbedder = createEmbedder('hash');

async function cleanStore(store: KnowledgeStore) {
  await new Promise<void>((resolve, reject) => {
    db.run('DELETE FROM knowledge_chunks', (err) => (err ? reject(err) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    db.run('DELETE FROM knowledge_sources', (err) => (err ? reject(err) : resolve()));
  });
}

describe('KnowledgeStore', () => {
  let store: KnowledgeStore;

  beforeEach(async () => {
    store = new KnowledgeStore(testEmbedder);
    await cleanStore(store);
  });

  afterAll(async () => {
    await cleanStore(store);
  });

  it('ingests text chunks and searches', async () => {
    await store.ingestChunks(
      'test:text',
      [
        { index: 0, content: 'apple pie recipe' },
        { index: 1, content: 'banana bread recipe' },
      ],
      { source_type: 'text', source_key: 'test:text', title: 'Recipes' }
    );

    const results = await store.search('apple pie', 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain('apple pie');
    expect(results[0].source.title).toBe('Recipes');
  });

  it('skips re-ingesting unchanged content', async () => {
    const source = { source_type: 'text' as const, source_key: 'test:stable', title: 'Stable' };
    await store.ingestChunks('test:stable', [{ index: 0, content: 'unchanged' }], source);
    const first = await store.listSources();
    await store.ingestChunks('test:stable', [{ index: 0, content: 'unchanged' }], source);
    const second = await store.listSources();
    expect(second[0].last_checked_at).toEqual(first[0].last_checked_at);
  });

  it('lists sources', async () => {
    await store.ingestChunks(
      'test:list',
      [{ index: 0, content: 'hello' }],
      { source_type: 'text', source_key: 'test:list', title: 'List Test' }
    );
    const sources = await store.listSources();
    expect(sources.some(s => s.source_key === 'test:list')).toBe(true);
  });

  it('deletes a source and its chunks', async () => {
    await store.ingestChunks(
      'test:delete',
      [{ index: 0, content: 'delete me' }],
      { source_type: 'text', source_key: 'test:delete', title: 'Delete Test' }
    );
    await store.deleteSource('test:delete');
    const sources = await store.listSources();
    expect(sources.some(s => s.source_key === 'test:delete')).toBe(false);
  });
});
