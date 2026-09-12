'use strict';
/* ===========================================================================
 * NOVA Runtime — knowledge ingestion & search (Phase 2)
 *
 * Real chunking (lib/chunker.js) + real embeddings (Ollama, via
 * lib/ollama.js) + a real vector store. "Real vector store" here means:
 * embedding vectors are written straight into the same generic per-store
 * JSON-blob table Phase 1 already built for `knowledgeChunks` (no new
 * service, per the roadmap's own instruction to keep this inside the
 * existing SQLite file) and similarity search is real cosine similarity
 * computed over those vectors in application code. That's brute-force,
 * not an ANN index — the honest tradeoff for a local knowledge base sized
 * in the dozens-to-low-hundreds of chunks, where an index would add
 * complexity without changing a single result.
 * ========================================================================= */
const { chunkText } = require('./chunker');
const { cosineSimilarity, hybridRerank } = require('./rerank');

const DEFAULT_EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const EMBED_BATCH_SIZE = 16;
const MAX_DOC_BYTES = 2 * 1024 * 1024; // 2MB raw text per document

function nowIso() { return new Date().toISOString(); }
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function embedBatched(ollama, model, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const vectors = await ollama.embed(model, texts.slice(i, i + EMBED_BATCH_SIZE));
    out.push(...vectors);
  }
  return out;
}

function recomputeCollectionCounts(store, collectionId) {
  const collection = store.get('knowledgeCollections', collectionId);
  if (!collection) return null;
  const docs = store.all('knowledgeDocuments').filter(d => d.collectionId === collectionId);
  const chunks = store.all('knowledgeChunks').filter(c => c.collectionId === collectionId);
  collection.docCount = docs.length;
  collection.chunkCount = chunks.length;
  collection.status = docs.length ? 'ready' : 'pending';
  collection.lastIndexed = nowIso();
  store.put('knowledgeCollections', collection);
  return collection;
}

/** Chunk + embed `text` and write the resulting chunk rows under an
 *  existing document id. Shared by fresh ingestion and re-index so a
 *  re-index doesn't mint a new document identity for the same source. */
async function chunkAndEmbedIntoDoc(store, ollama, { docId, docName, collectionId, text, embeddingModel }) {
  const rawChunks = chunkText(text, { maxChars: 1000, overlap: 120 });
  if (!rawChunks.length) {
    const err = new Error('Document produced zero chunks after splitting — is it empty?');
    err.statusCode = 400; throw err;
  }
  let vectors;
  try {
    vectors = await embedBatched(ollama, embeddingModel, rawChunks.map(c => c.text));
  } catch (e) {
    const err = new Error(`Embedding failed via Ollama (model "${embeddingModel}"): ${e.message}`);
    err.statusCode = 502; throw err;
  }
  const rows = rawChunks.map((c, i) => ({
    id: uid('ck'), docId, docName, collectionId,
    text: c.text, heading: c.heading || null, isCode: !!c.isCode,
    embedded: true, embedding: vectors[i] || null,
    embeddingModel, embeddingDims: vectors[i] ? vectors[i].length : 0,
  }));
  rows.forEach(row => store.put('knowledgeChunks', row));
  return rows;
}

async function ingestDocument(store, ollama, { collectionId, name, text, embeddingModel }) {
  if (!collectionId || !name || typeof text !== 'string' || !text.trim()) {
    const err = new Error('Expected {collectionId, name, text}'); err.statusCode = 400; throw err;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_DOC_BYTES) {
    const err = new Error(`Document is ${(bytes / 1e6).toFixed(1)}MB — the cap is ${(MAX_DOC_BYTES / 1e6).toFixed(0)}MB`);
    err.statusCode = 413; throw err;
  }
  const collection = store.get('knowledgeCollections', collectionId);
  if (!collection) { const err = new Error('Unknown collection: ' + collectionId); err.statusCode = 404; throw err; }
  const model = embeddingModel || collection.embeddingModel || DEFAULT_EMBED_MODEL;

  const docId = uid('kd');
  const chunkRows = await chunkAndEmbedIntoDoc(store, ollama, { docId, docName: name, collectionId, text, embeddingModel: model });

  const docRow = {
    id: docId, collectionId, name, text, sizeKb: +(bytes / 1024).toFixed(1),
    chunkCount: chunkRows.length, status: 'embedded', indexedAt: nowIso(), embeddingModel: model,
  };
  store.put('knowledgeDocuments', docRow);
  const collectionAfter = recomputeCollectionCounts(store, collectionId);
  return { document: docRow, chunkCount: chunkRows.length, collection: collectionAfter };
}

async function reindexCollection(store, ollama, collectionId) {
  const collection = store.get('knowledgeCollections', collectionId);
  if (!collection) { const err = new Error('Unknown collection: ' + collectionId); err.statusCode = 404; throw err; }
  const docs = store.all('knowledgeDocuments').filter(d => d.collectionId === collectionId);
  let reindexed = 0, skipped = 0;
  for (const doc of docs) {
    if (typeof doc.text !== 'string' || !doc.text.trim()) { skipped++; continue; } // seeded/legacy doc with no stored source text
    store.all('knowledgeChunks').filter(c => c.docId === doc.id).forEach(c => store.delete('knowledgeChunks', c.id));
    const chunkRows = await chunkAndEmbedIntoDoc(store, ollama, {
      docId: doc.id, docName: doc.name, collectionId, text: doc.text, embeddingModel: collection.embeddingModel || DEFAULT_EMBED_MODEL,
    });
    doc.chunkCount = chunkRows.length; doc.status = 'embedded'; doc.indexedAt = nowIso();
    doc.embeddingModel = collection.embeddingModel || DEFAULT_EMBED_MODEL;
    store.put('knowledgeDocuments', doc);
    reindexed++;
  }
  const collectionAfter = recomputeCollectionCounts(store, collectionId);
  return { collection: collectionAfter, reindexedDocs: reindexed, skippedDocs: skipped, totalDocs: docs.length };
}

/** Real vector search (+ optional real hybrid rerank) over stored chunks.
 *  Falls back cleanly with `usedRealEmbeddings:false` and a `reason` when
 *  there's nothing embedded to search — callers (the frontend) use that
 *  to decide whether to fall back to the old simulated picker, and to
 *  label results honestly either way. */
async function searchKnowledge(store, ollama, { query, collectionId, embeddingModel, topK, rerank }) {
  if (!query || !query.trim()) { const err = new Error('Expected {query}'); err.statusCode = 400; throw err; }
  const k = Math.min(Math.max(Number(topK) || 6, 1), 50);

  let pool = store.all('knowledgeChunks').filter(c => c.embedded && Array.isArray(c.embedding) && c.embedding.length);
  if (collectionId) pool = pool.filter(c => c.collectionId === collectionId);
  if (!pool.length) {
    return { results: [], usedRealEmbeddings: false, reason: 'No embedded chunks available' + (collectionId ? ' in this collection' : '') + ' yet — add a source in Knowledge first.' };
  }

  // Vectors from different embedding models live in different spaces and
  // can't be compared — scope the search to whichever model most of the
  // pool actually used (or the one the caller asked for).
  const modelCounts = new Map();
  for (const c of pool) modelCounts.set(c.embeddingModel, (modelCounts.get(c.embeddingModel) || 0) + 1);
  const targetModel = embeddingModel || [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const scoped = pool.filter(c => c.embeddingModel === targetModel);
  if (!scoped.length) {
    return { results: [], usedRealEmbeddings: false, reason: `No chunks embedded with "${targetModel}".` };
  }

  let queryVec;
  try {
    const vectors = await ollama.embed(targetModel, query);
    queryVec = vectors[0];
  } catch (e) {
    const err = new Error(`Query embedding failed via Ollama (model "${targetModel}"): ${e.message}`);
    err.statusCode = 502; throw err;
  }

  const scored = scoped.map(c => ({
    id: c.id, docId: c.docId, docName: c.docName, text: c.text,
    vectorScore: cosineSimilarity(queryVec, c.embedding),
  }));
  scored.sort((a, b) => b.vectorScore - a.vectorScore);
  const candidatePool = scored.slice(0, Math.max(k * 3, k));

  let results;
  if (rerank && candidatePool.length > 1) {
    results = hybridRerank(query, candidatePool).slice(0, k);
  } else {
    results = candidatePool.slice(0, k).map((c, i) => ({ ...c, rank: i + 1 }));
  }
  return { results, usedRealEmbeddings: true, embeddingModel: targetModel, poolSize: scoped.length, reranked: !!rerank };
}

function deleteDocument(store, docId) {
  const doc = store.get('knowledgeDocuments', docId);
  if (!doc) return null;
  store.all('knowledgeChunks').filter(c => c.docId === docId).forEach(c => store.delete('knowledgeChunks', c.id));
  store.delete('knowledgeDocuments', docId);
  return recomputeCollectionCounts(store, doc.collectionId);
}

module.exports = { ingestDocument, reindexCollection, searchKnowledge, deleteDocument, recomputeCollectionCounts, DEFAULT_EMBED_MODEL };
