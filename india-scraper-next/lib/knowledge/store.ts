import db from '@/lib/db';
import { createEmbedder, cosineSimilarity, Embedder } from './embedder';
import { Chunk } from './chunker';

export interface KnowledgeSource {
  id?: number;
  source_type: 'text' | 'url' | 'document' | 'business' | 'unknown';
  source_key: string;
  title?: string | null;
  content_hash?: string | null;
  metadata?: Record<string, any> | null;
  last_checked_at?: string;
}

export interface KnowledgeChunk {
  id?: number;
  source_id: number;
  chunk_index: number;
  content: string;
  embedding?: number[] | null;
  metadata?: Record<string, any> | null;
}

export interface SearchResult {
  chunk: KnowledgeChunk;
  source: KnowledgeSource;
  score: number;
}

const DEFAULT_TOP_K = 5;

function serializeEmbedding(embedding: number[]): Buffer {
  const buffer = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

function deserializeEmbedding(buffer: Buffer): number[] {
  if (!buffer) return [];
  const arr = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  return Array.from(arr);
}

function hashContent(content: string): string {
  // Simple stable hash; sufficient for detecting content changes.
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(16);
}

export class KnowledgeStore {
  private embedder: Embedder;

  constructor(embedder?: Embedder) {
    this.embedder = embedder || createEmbedder();
  }

  async upsertSource(source: KnowledgeSource): Promise<number> {
    const existing = await this.getSourceByKey(source.source_key);
    if (existing?.id) {
      await new Promise<void>((resolve, reject) => {
        db.run(
          `UPDATE knowledge_seeker_sources
           SET source_type = ?, title = ?, content_hash = ?, metadata = ?, last_checked_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [source.source_type, source.title || null, source.content_hash || null, JSON.stringify(source.metadata || null), existing.id],
          (err) => (err ? reject(err) : resolve())
        );
      });
      return existing.id;
    }

    return new Promise<number>((resolve, reject) => {
      db.run(
        `INSERT INTO knowledge_seeker_sources (source_type, source_key, title, content_hash, metadata)
         VALUES (?, ?, ?, ?, ?)`,
        [source.source_type, source.source_key, source.title || null, source.content_hash || null, JSON.stringify(source.metadata || null)],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async getSourceByKey(source_key: string): Promise<KnowledgeSource | undefined> {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM knowledge_seeker_sources WHERE source_key = ?', [source_key], (err, row) => {
        if (err) reject(err);
        else resolve(row as KnowledgeSource | undefined);
      });
    });
  }

  async getSourceById(id: number): Promise<KnowledgeSource | undefined> {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM knowledge_seeker_sources WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row as KnowledgeSource | undefined);
      });
    });
  }

  async deleteSource(source_key: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      db.run('DELETE FROM knowledge_seeker_sources WHERE source_key = ?', [source_key], (err) =>
        err ? reject(err) : resolve()
      );
    });
  }

  async ingestChunks(source_key: string, chunks: Chunk[], source: Omit<KnowledgeSource, 'id'>): Promise<void> {
    const fullContent = chunks.map(c => c.content).join('\n');
    const contentHash = hashContent(fullContent);
    const existing = await this.getSourceByKey(source_key);

    if (existing?.content_hash === contentHash) {
      // No change; just refresh the checked timestamp.
      await new Promise<void>((resolve, reject) => {
        db.run(
          'UPDATE knowledge_seeker_sources SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?',
          [existing.id],
          (err) => (err ? reject(err) : resolve())
        );
      });
      return;
    }

    const sourceId = await this.upsertSource({ ...source, source_key, content_hash: contentHash });

    // Remove old chunks for this source.
    await new Promise<void>((resolve, reject) => {
      db.run('DELETE FROM knowledge_chunks WHERE source_id = ?', [sourceId], (err) =>
        err ? reject(err) : resolve()
      );
    });

    if (chunks.length === 0) return;

    const embeddings = await this.embedder.embedBatch(chunks.map(c => c.content));
    const stmt = db.prepare(
      `INSERT INTO knowledge_chunks (source_id, chunk_index, content, embedding, metadata)
       VALUES (?, ?, ?, ?, ?)`
    );

    await new Promise<void>((resolve, reject) => {
      let completed = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        stmt.run(
          sourceId,
          chunk.index,
          chunk.content,
          serializeEmbedding(embedding),
          JSON.stringify(chunk.metadata || source.metadata || null),
          (err: Error | null) => {
            if (err) reject(err);
            else if (++completed === chunks.length) resolve();
          }
        );
      }
    });

    stmt.finalize();
  }

  async search(query: string, topK = DEFAULT_TOP_K): Promise<SearchResult[]> {
    const queryEmbedding = await this.embedder.embed(query);
    const rows = await new Promise<any[]>((resolve, reject) => {
      db.all('SELECT * FROM knowledge_chunks', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const scored = await Promise.all(
      rows.map(async (row) => {
        const embedding = deserializeEmbedding(row.embedding);
        const score = cosineSimilarity(queryEmbedding, embedding);
        const source = await this.getSourceById(row.source_id);
        return {
          chunk: {
            id: row.id,
            source_id: row.source_id,
            chunk_index: row.chunk_index,
            content: row.content,
            metadata: row.metadata ? JSON.parse(row.metadata) : null,
          } as KnowledgeChunk,
          source: source || ({ source_type: 'unknown', source_key: '' } as KnowledgeSource),
          score,
        };
      })
    );

    return scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async listSources(): Promise<KnowledgeSource[]> {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM knowledge_seeker_sources ORDER BY last_checked_at DESC', (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []) as KnowledgeSource[]);
      });
    });
  }
}
