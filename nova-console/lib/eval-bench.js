'use strict';
/* ===========================================================================
 * NOVA Runtime — real fixed evaluation benchmark (Phase 5)
 *
 * Replaces the console's old evalRunBtn handler, which invented its whole
 * row with +rand(80,92)/+rand(86,97)/etc — none of it derived from an
 * actual model response. This is a small, fixed, grounded-QA benchmark
 * ("NOVA Bench 10"): every item pairs a short context passage with a
 * question whose answer only appears in that passage, run for real against
 * the loaded model (Ollama's real /api/chat, non-streaming, temperature 0),
 * and scored by real substring/marker checks against the model's own reply
 * — not by drawing a random number in the target's neighborhood.
 *
 * Honest scope note: this is a hand-built 10-item benchmark, not a
 * standard published eval suite (MMLU, TruthfulQA, etc.) — building or
 * downloading one of those is real future work, not something to fake the
 * shape of here. "Grounded" is scored only over the 7 items whose answer
 * is specific to this project's own source (b1-b5, b9, b10) rather than
 * general knowledge (Paris/freezing point/primary colors, b6-b8) — getting
 * those right is real evidence the model actually used the supplied
 * context rather than already knowing the answer.
 * ========================================================================= */

const DATASET_NAME = 'Maataa Bench 10';
const CITATION_MARK = '[source]';

const BENCH_SET = [
  { id: 'b1', groundOnly: true, context: 'Maataa Workstation listens on port 8787 by default, configurable via the PORT environment variable.', prompt: 'What port does Maataa Workstation listen on by default?', expect: ['8787'] },
  { id: 'b2', groundOnly: true, context: 'Maataa Workstation persists every store to a real SQLite database via Node’s built-in node:sqlite module, avoiding any native compile step.', prompt: 'What database does Maataa Workstation use for persistence?', expect: ['sqlite'] },
  { id: 'b3', groundOnly: true, context: 'A workflow run that is still "running" when the server process restarts is resumed from its last persisted node by a function called resumeInFlightRuns().', prompt: 'What function resumes an in-flight workflow run after a restart?', expect: ['resumeinflightruns'] },
  { id: 'b4', groundOnly: true, context: 'The real agent tool-calling loop is capped at a maximum of 6 tool-call rounds before it errors out.', prompt: 'How many tool-call rounds is the agent loop capped at?', expect: ['6', 'six'] },
  { id: 'b5', groundOnly: true, context: 'Each connected MCP server has an approval policy that can be set to auto, ask, or deny.', prompt: 'Name one of the three MCP approval policy values.', expect: ['auto', 'ask', 'deny'] },
  { id: 'b6', groundOnly: false, context: 'The capital of France is Paris.', prompt: 'What is the capital of France?', expect: ['paris'] },
  { id: 'b7', groundOnly: false, context: 'Water freezes at 0 degrees Celsius at standard atmospheric pressure.', prompt: 'At what temperature does water freeze, in Celsius?', expect: ['0'] },
  { id: 'b8', groundOnly: false, context: 'The three primary colors in traditional color theory are red, blue, and yellow.', prompt: 'Name one primary color in traditional color theory.', expect: ['red', 'blue', 'yellow'] },
  { id: 'b9', groundOnly: true, context: 'Ollama exposes its real installed-model listing through the documented GET /api/tags endpoint.', prompt: 'Which HTTP endpoint does Ollama expose to list installed models?', expect: ['/api/tags', 'api/tags'] },
  { id: 'b10', groundOnly: true, context: 'A workspace is only ever considered LOCAL ONLY when network access is disabled and the loaded model runs locally rather than remotely.', prompt: 'Under what condition is a workspace considered LOCAL ONLY?', expect: ['disabled'] },
];

function buildMessages(item) {
  return [
    { role: 'system', content: 'Answer strictly and only from the given context, in one short sentence, and end your answer with the exact marker ' + CITATION_MARK + '.' },
    { role: 'user', content: 'Context: ' + item.context + '\n\nQuestion: ' + item.prompt },
  ];
}

function scoreItem(item, replyText) {
  const lower = (replyText || '').toLowerCase();
  const correct = item.expect.some(kw => lower.includes(kw.toLowerCase()));
  const cited = lower.includes(CITATION_MARK.toLowerCase());
  return { correct, cited };
}

/** Runs the fixed benchmark for real against `modelId` (an Ollama model
 *  name/id) and returns real aggregate metrics plus a per-item trace. */
async function runEvaluation(store, ollama, telemetry, modelId) {
  const model = store.get('models', modelId);
  const modelName = model ? model.id : modelId;
  const before = telemetry ? await telemetry.read().catch(() => null) : null;

  let correctCount = 0, citedCount = 0, groundedCorrect = 0, groundOnlyTotal = 0;
  let ttftSum = 0, decodeSum = 0, decodeSamples = 0, scored = 0;
  const perItem = [];

  for (const item of BENCH_SET) {
    if (item.groundOnly) groundOnlyTotal++;
    let raw;
    const t0 = Date.now();
    try {
      raw = await ollama.chatFull(modelName, buildMessages(item), { options: { temperature: 0 } });
    } catch (e) {
      perItem.push({ id: item.id, error: e.message || String(e) });
      continue;
    }
    const replyText = (raw.message && raw.message.content) || '';
    const { correct, cited } = scoreItem(item, replyText);
    if (correct) { correctCount++; if (item.groundOnly) groundedCorrect++; }
    if (cited) citedCount++;
    const ttftMs = (raw.total_duration != null && raw.eval_duration != null)
      ? Math.max(0, Math.round((raw.total_duration - raw.eval_duration) / 1e6))
      : (Date.now() - t0);
    const decodeTps = (raw.eval_count && raw.eval_duration) ? (raw.eval_count / (raw.eval_duration / 1e9)) : null;
    ttftSum += ttftMs;
    if (decodeTps != null) { decodeSum += decodeTps; decodeSamples++; }
    scored++;
    perItem.push({ id: item.id, correct, cited, ttftMs, decodeTps, reply: replyText.slice(0, 200) });
  }

  const after = telemetry ? await telemetry.read().catch(() => null) : null;
  const peakRam = before && after ? Math.max(before.ram.usedGb, after.ram.usedGb) : (after ? after.ram.usedGb : null);
  const beforeVram = before && before.gpu && before.gpu.available ? before.gpu.vramUsedGb : null;
  const afterVram = after && after.gpu && after.gpu.available ? after.gpu.vramUsedGb : null;
  const peakVram = (beforeVram != null || afterVram != null)
    ? Math.max(beforeVram || 0, afterVram || 0)
    : null;

  const total = BENCH_SET.length || 1;
  return {
    dataset: DATASET_NAME,
    modelId,
    temperature: 0,
    accuracy: +(100 * correctCount / total).toFixed(1),
    grounded: groundOnlyTotal ? +(100 * groundedCorrect / groundOnlyTotal).toFixed(1) : 0,
    citation: +(100 * citedCount / total).toFixed(1),
    avgTtft: scored ? Math.round(ttftSum / scored) : 0,
    decode: decodeSamples ? +(decodeSum / decodeSamples).toFixed(1) : 0,
    peakRam: peakRam != null ? +peakRam.toFixed(1) : null,
    peakVram: peakVram != null ? +peakVram.toFixed(1) : null,
    perItem,
  };
}

module.exports = { BENCH_SET, DATASET_NAME, CITATION_MARK, runEvaluation };
