export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

const VECTOR_DIM = 384;

function normalize(v: number[]): number[] {
  const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (magnitude === 0) return v;
  return v.map(x => x / magnitude);
}

/**
 * Deterministic fallback embedder: hashes tokens into a fixed-size vector.
 * Useful for tests and environments without an external embedding provider.
 * Not semantically meaningful, but produces consistent vectors for identical text.
 */
class HashEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const vector = new Array(VECTOR_DIM).fill(0);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const token of tokens) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = (hash << 5) - hash + token.charCodeAt(i);
        hash |= 0;
      }
      const idx = Math.abs(hash) % VECTOR_DIM;
      vector[idx] += 1;
    }
    return normalize(vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

/**
 * OpenAI embedder. Requires OPENAI_API_KEY env var.
 */
class OpenAIEmbedder implements Embedder {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${response.status} ${error}`);
    }
    const data = await response.json();
    return data.data.map((item: any) => item.embedding as number[]);
  }
}

export function createEmbedder(provider?: string): Embedder {
  const resolved = provider || process.env.KNOWLEDGE_EMBEDDER || 'hash';

  if (resolved === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when using OpenAI embedder');
    return new OpenAIEmbedder(apiKey, process.env.OPENAI_EMBEDDING_MODEL);
  }

  return new HashEmbedder();
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
