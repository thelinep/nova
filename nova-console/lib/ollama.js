'use strict';
/* ===========================================================================
 * NOVA Runtime — Ollama client
 *
 * Talks to a real local Ollama daemon over its documented HTTP API
 * (default http://127.0.0.1:11434). Nothing here is simulated: model lists
 * come from GET /api/tags, loaded-model state from GET /api/ps, generation
 * from POST /api/chat (streaming) and POST /api/generate (load/unload/
 * benchmark probes), and every tok/s or TTFT number downstream is computed
 * from the real eval_count/eval_duration/prompt_eval_count/
 * prompt_eval_duration fields Ollama returns — never jittered math.
 * ========================================================================= */

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const REACHABILITY_TIMEOUT_MS = 1500;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

class OllamaClient {
  constructor(host) {
    this.host = host || DEFAULT_HOST;
  }

  url(p) { return this.host.replace(/\/+$/, '') + p; }

  /** Cheap reachability + model inventory check. Never throws — callers get
   *  {reachable:false, error} instead, because "Ollama isn't running" is an
   *  ordinary, expected state for this prototype, not a server error. */
  async status(externalSignal) {
    const t = withTimeout(REACHABILITY_TIMEOUT_MS);
    const signal = externalSignal ? AbortSignal.any([t.signal, externalSignal]) : t.signal;
    try {
      const [tagsRes, psRes] = await Promise.all([
        fetch(this.url('/api/tags'), { signal }),
        fetch(this.url('/api/ps'), { signal }).catch(() => null),
      ]);
      if (!tagsRes.ok) throw new Error(`Ollama responded ${tagsRes.status}`);
      const tags = await tagsRes.json();
      let running = [], loaded = [];
      if (psRes && psRes.ok) {
        const ps = await psRes.json();
        running = (ps.models || []).map(m => m.name);
        // What each loaded model really uses: memory, share on the GPU, context window, when Ollama unloads it.
        loaded = (ps.models || []).map(m => ({ name: m.name, size: Number(m.size) || null, sizeVram: Number(m.size_vram) || 0, contextLength: Number(m.context_length) || null, expiresAt: m.expires_at || null }));
      }
      return { reachable: true, host: this.host, models: tags.models || [], runningModelNames: running, loaded };
    } catch (e) {
      return { reachable: false, host: this.host, error: e.message, models: [], runningModelNames: [] };
    } finally {
      t.clear();
    }
  }

  /** Read authoritative model metadata used by production capability gates. */
  async show(modelName, signal) {
    const res = await fetch(this.url('/api/show'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama model inspection failed: ${res.status} ${await res.text().catch(() => '')}`);
    return res.json();
  }

  /** Preload a model into memory without generating anything — Ollama's
   *  documented trick is an empty-prompt /api/generate call. */
  async load(modelName, keepAlive) {
    const res = await fetch(this.url('/api/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: '', stream: false, keep_alive: keepAlive || '30m' }),
    });
    if (!res.ok) throw new Error(`Ollama load failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Evict a model from memory immediately (keep_alive:0). */
  async unload(modelName) {
    const res = await fetch(this.url('/api/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: '', stream: false, keep_alive: 0 }),
    });
    if (!res.ok) throw new Error(`Ollama unload failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Real (not jittered) benchmark: one real generation against a fixed
   *  prompt, timed by Ollama itself. Returns the raw response so the caller
   *  can derive prompt tok/s, decode tok/s, and TTFT from real counters. */
  async benchmark(modelName, prompt) {
    const res = await fetch(this.url('/api/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt: prompt || 'In one short paragraph, explain what a local-first application is.',
        stream: false,
        keep_alive: '30m',
      }),
    });
    if (!res.ok) throw new Error(`Ollama benchmark failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Streaming chat completion. Returns the raw fetch Response so the
   *  caller (the HTTP route) can pipe Ollama's newline-delimited JSON
   *  chunks straight through to the browser as they arrive. */
  async chatStream(modelName, messages, options, signal) {
    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, messages, stream: true, options: options || {} }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama chat failed: ${res.status} ${text}`);
    }
    return res;
  }

  /** Non-streaming chat completion, returning Ollama's FULL response object
   *  (message + the real usage counters: eval_count, eval_duration,
   *  prompt_eval_count, prompt_eval_duration, total_duration) rather than
   *  just the message. Phase 5's Automations and Evaluations both need
   *  real token counts and timings out of a non-streaming call — chat()
   *  below used to throw those fields away because the Phase 4 agent loop
   *  only ever needed the message, so this is the one real place both
   *  needs are served from without duplicating the fetch. */
  async chatFull(modelName, messages, opts) {
    opts = opts || {};
    const body = { model: modelName, messages, stream: false };
    if (opts.tools && opts.tools.length) body.tools = opts.tools;
    if (opts.options) body.options = opts.options;
    if (opts.format) body.format = opts.format;
    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text().catch(() => '')}`);
    return res.json();
  }

  /** Non-streaming chat completion, optionally with tool specs (the
   *  OpenAI-style `tools: [{type:'function', function:{name, description,
   *  parameters}}]` shape Ollama's /api/chat documents for models that
   *  support tool-calling — llama3.1, qwen2.5, mistral-nemo, firefunction,
   *  and others). Returns the raw assistant message
   *  ({role, content, tool_calls?}) untouched, so the real agent loop
   *  (lib/agent-loop.js) can inspect tool_calls directly rather than this
   *  client guessing at their shape. Non-streaming because the loop needs
   *  to decide — synchronously, before producing any more output — whether
   *  the model asked for a tool call or gave a final answer. Thin wrapper
   *  over chatFull() for callers that only care about the message. */
  async chat(modelName, messages, tools) {
    const json = await this.chatFull(modelName, messages, { tools });
    return json.message || { role: 'assistant', content: '' };
  }

  /** Real embeddings via Ollama's batch embed endpoint (POST /api/embed —
   *  the current one; the older singular /api/embeddings took one input
   *  at a time and is deprecated but still common in the wild, so this
   *  falls back to it if /api/embed 404s). `input` may be a string or an
   *  array of strings; the return shape is always number[][], one vector
   *  per input, in the same order. */
  async embed(modelName, input) {
    const inputs = Array.isArray(input) ? input : [input];
    if (!inputs.length) return [];
    let res = await fetch(this.url('/api/embed'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, input: inputs }),
    });
    if (res.status === 404) {
      // Older Ollama: one input per call against /api/embeddings.
      const out = [];
      for (const text of inputs) {
        const r = await fetch(this.url('/api/embeddings'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName, prompt: text }),
        });
        if (!r.ok) throw new Error(`Ollama embeddings failed: ${r.status} ${await r.text().catch(()=>'')}`);
        const j = await r.json();
        out.push(j.embedding);
      }
      return out;
    }
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text().catch(()=>'')}`);
    const json = await res.json();
    if (Array.isArray(json.embeddings)) return json.embeddings;
    if (Array.isArray(json.embedding)) return [json.embedding]; // single-input shape, just in case
    throw new Error('Ollama embed response had no embeddings array');
  }
}

module.exports = { OllamaClient, DEFAULT_HOST };
