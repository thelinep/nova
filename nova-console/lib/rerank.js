'use strict';
/* ===========================================================================
 * NOVA Runtime — ranking
 *
 * Real vector similarity (cosine over real embeddings), plus a real,
 * model-free hybrid rerank: BM25 lexical scoring fused with the vector
 * ranking via Reciprocal Rank Fusion (RRF). This is the honest call the
 * roadmap asked for on rerank — "wire a real cross-encoder, or relabel
 * the step rather than fake it." A cross-encoder needs a model this
 * project has no reliable way to run locally via Ollama; RRF-over-BM25
 * needs nothing but arithmetic and is a real, established hybrid-search
 * technique in its own right — not a stand-in for a cross-encoder, and
 * it's labeled everywhere as exactly what it is ("Hybrid rerank (BM25 +
 * vector, RRF)"), never as "reranked by a cross-encoder."
 * ========================================================================= */

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tokenize(text) {
  return ((text || '').toLowerCase().match(/[a-z0-9]+/g)) || [];
}

/** Real BM25 (Okapi) over the given candidate pool — IDF computed from
 *  that actual pool, not a fixed corpus, since a local knowledge base is
 *  small enough that per-query IDF is cheap and keeps the score honest
 *  for whatever's actually being searched. */
function bm25Scores(query, docsText, opts) {
  opts = opts || {};
  const k1 = opts.k1 ?? 1.5, b = opts.b ?? 0.75;
  const qTerms = [...new Set(tokenize(query))];
  const docTokens = docsText.map(tokenize);
  const docLens = docTokens.map(t => t.length);
  const avgLen = docLens.reduce((a, c) => a + c, 0) / (docLens.length || 1) || 1;
  const N = docsText.length;
  const df = new Map();
  for (const terms of docTokens) {
    for (const t of new Set(terms)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map(qTerms.map(t => {
    const n = df.get(t) || 0;
    return [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))];
  }));
  return docTokens.map((terms, i) => {
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const qt of qTerms) {
      const f = tf.get(qt) || 0;
      if (!f) continue;
      const denom = f + k1 * (1 - b + b * docLens[i] / avgLen);
      score += idf.get(qt) * (f * (k1 + 1)) / denom;
    }
    return score;
  });
}

/** Reciprocal Rank Fusion over any number of real rankings (each an array
 *  of item ids, best first). k=60 is the constant from the original RRF
 *  paper (Cormack et al.) — not tuned, just the standard default. */
function reciprocalRankFusion(rankings, k) {
  k = k || 60;
  const fused = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, idx) => { fused.set(id, (fused.get(id) || 0) + 1 / (k + idx + 1)); });
  }
  return fused;
}

/**
 * hybridRerank(query, candidates) — candidates: [{id, text, vectorScore}]
 * already sorted by vector similarity is not required; this re-derives
 * both rankings itself. Returns candidates with .rerankScore and .rank
 * added, sorted by the fused score, plus each input's raw .vectorScore
 * and .bm25Score preserved so the UI can show both real signals, not
 * just the fused number.
 */
function hybridRerank(query, candidates) {
  const vectorRanking = candidates.slice().sort((a, b) => b.vectorScore - a.vectorScore).map(c => c.id);
  const bm25 = bm25Scores(query, candidates.map(c => c.text));
  const withBm25 = candidates.map((c, i) => ({ ...c, bm25Score: bm25[i] }));
  const bm25Ranking = withBm25.slice().sort((a, b) => b.bm25Score - a.bm25Score).map(c => c.id);
  const fused = reciprocalRankFusion([vectorRanking, bm25Ranking]);
  const out = withBm25.map(c => ({ ...c, rerankScore: fused.get(c.id) || 0 }));
  out.sort((a, b) => b.rerankScore - a.rerankScore);
  out.forEach((c, i) => { c.rank = i + 1; });
  return out;
}

module.exports = { cosineSimilarity, tokenize, bm25Scores, reciprocalRankFusion, hybridRerank };
