'use strict';

const net = require('node:net');

/**
 * Coding Studio's model boundary.
 *
 * Implementations are local inference adapters. They receive the selected
 * model id and a bounded JSON generation request, and return a provider
 * independent response with text, finishReason, and token usage. Adapters do
 * not choose models, qualify digests, access workspace files, or apply edits.
 */

function adapterError(message, code = 'coding_model_adapter_error') {
  return Object.assign(new Error(message), { code });
}

function assertCodingModelAdapter(adapter) {
  if (!adapter || typeof adapter.generate !== 'function' || typeof adapter.resolveModel !== 'function') {
    throw adapterError('Coding model adapter must implement resolveModel(modelId) and generate(request).', 'bad_coding_model_adapter');
  }
  if (adapter.localOnly !== true) {
    throw adapterError('Coding model adapter must declare and enforce local-only inference.', 'external_transmission_denied');
  }
  return adapter;
}

function isLoopbackHost(host) {
  try {
    const url = new URL(host);
    if (url.protocol !== 'http:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === '::1') return true;
    return net.isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127;
  } catch {
    return false;
  }
}

function ollamaHost(ollama) {
  return typeof ollama.host === 'string' && ollama.host.trim()
    ? ollama.host
    : (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
}

function ollamaCodingModelAdapter(ollama, { requireLocal = true } = {}) {
  if (!ollama || typeof ollama !== 'object') throw adapterError('Ollama coding adapter requires a client object.', 'bad_ollama_client');
  return Object.freeze({
    id: 'ollama-local-coding',
    localOnly: Boolean(isLoopbackHost(ollamaHost(ollama))),
    async resolveModel(modelId, { signal } = {}) {
      if (requireLocal && !isLoopbackHost(ollamaHost(ollama))) {
        throw adapterError('Coding model resolution is restricted to a numeric loopback Ollama endpoint.', 'external_transmission_denied');
      }
      const status = await ollama.status(signal);
      const installed = status.models?.find(model => model.name === modelId);
      if (!status.reachable || !installed || typeof installed.digest !== 'string' || !installed.digest) return null;
      return { modelId: installed.name, digest: installed.digest };
    },
    async generate(request) {
      if (typeof ollama.chatFull !== 'function') throw adapterError('Ollama coding adapter requires chatFull(model, messages, options).', 'bad_ollama_client');
      if (!request || typeof request.modelId !== 'string' || !request.modelId || !Array.isArray(request.messages)) {
        throw adapterError('Coding generation requires modelId and messages.', 'bad_generation_request');
      }
      if (requireLocal && !isLoopbackHost(ollamaHost(ollama))) throw adapterError('Coding model inference is restricted to a numeric loopback Ollama endpoint.', 'external_transmission_denied');
      if (typeof request.modelDigest !== 'string' || !request.modelDigest) throw adapterError('Coding generation requires the selected model digest.', 'model_digest_unavailable');
      const resolved = await this.resolveModel(request.modelId, { signal: request.signal });
      if (!resolved || resolved.digest !== request.modelDigest) throw adapterError('The coding adapter could not confirm the selected model digest.', 'model_digest_changed');
      const response = await ollama.chatFull(request.modelId, request.messages, {
        signal: request.signal,
        format: request.responseFormat || 'json',
        options: {
          temperature: Number.isFinite(request.temperature) ? request.temperature : 0,
          num_predict: request.maxOutputTokens,
          num_ctx: request.maxContextTokens,
        },
      });
      if (response?.model !== request.modelId) {
        throw adapterError('Ollama returned a different or unverified model name for the coding request.', 'model_digest_changed');
      }
      // Ollama accepts a model name, not an immutable digest, for /api/chat.
      // Re-read the installed digest after inference and fail the task if the
      // mutable name changed while the request was running.
      const after = await this.resolveModel(request.modelId, { signal: request.signal });
      if (!after || after.digest !== request.modelDigest) {
        throw adapterError('The selected Ollama model digest changed during coding inference.', 'model_digest_changed');
      }
      return {
        text: String(response?.message?.content || ''),
        finishReason: response?.done_reason || null,
        usage: {
          inputTokens: response?.prompt_eval_count,
          outputTokens: response?.eval_count,
        },
      };
    },
  });
}

module.exports = { assertCodingModelAdapter, isLoopbackHost, ollamaCodingModelAdapter };
