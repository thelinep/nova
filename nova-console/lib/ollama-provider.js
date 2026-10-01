'use strict';

class OllamaProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OllamaProviderError';
    this.code = code || 'ollama_provider_error';
  }
}

/**
 * Create a constellation-router provider backed by an Ollama model.
 *
 *   const provider = ollamaProvider({
 *     id: 'ollama:llama3.1:8b',
 *     model: 'llama3.1:8b',
 *     chat: async (params) => ollama.chat(params),  // adapter
 *   });
 *
 * The `chat(params)` function must return one of:
 *   - a string
 *   - { content: string }
 *   - { message: { content: string } }
 *   - { response: string }
 * Any other shape throws OllamaProviderError.
 */
function ollamaProvider(options) {
  options = options || {};
  if (!options.id || typeof options.id !== 'string') {
    throw new OllamaProviderError('id required', 'bad_id');
  }
  if (!options.model || typeof options.model !== 'string') {
    throw new OllamaProviderError('model required', 'bad_model');
  }
  if (typeof options.chat !== 'function') {
    throw new OllamaProviderError('chat function required', 'bad_chat');
  }

  const id = options.id;
  const model = options.model;
  const chat = options.chat;
  const systemPrompt = options.systemPrompt || null;
  const temperature = options.temperature == null ? 0.8 : options.temperature;
  const maxTokens = options.maxTokens == null ? null : options.maxTokens;

  return {
    id,
    model,
    async generate(problem, context) {
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: problem });

      const params = {
        model,
        messages,
        temperature,
        stream: false,
      };
      if (maxTokens != null) params.max_tokens = maxTokens;

      let response;
      try {
        response = await chat(params);
      } catch (e) {
        throw new OllamaProviderError('chat failed: ' + (e.message || e), 'chat_failed');
      }

      return extractContent(response);
    },
  };
}

function extractContent(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response.content === 'string') return response.content;
  if (response && response.message && typeof response.message.content === 'string') {
    return response.message.content;
  }
  if (response && typeof response.response === 'string') return response.response;
  throw new OllamaProviderError('unexpected chat response shape', 'bad_response');
}

/**
 * Build N providers from a list of models sharing one chat adapter.
 *
 *   const providers = multiOllamaProviders({
 *     chat: (params) => ollama.chat(params),
 *     models: [
 *       { id: 'ollama:llama3.1:8b', model: 'llama3.1:8b' },
 *       { id: 'ollama:qwen2.5:7b',  model: 'qwen2.5:7b', temperature: 0.6 },
 *     ],
 *     systemPrompt: 'You are a careful programmer.',
 *   });
 */
function multiOllamaProviders(options) {
  options = options || {};
  if (typeof options.chat !== 'function') {
    throw new OllamaProviderError('chat function required', 'bad_chat');
  }
  if (!Array.isArray(options.models) || options.models.length === 0) {
    throw new OllamaProviderError('models array required', 'bad_models');
  }
  return options.models.map((m) => ollamaProvider({
    id: m.id,
    model: m.model,
    chat: options.chat,
    systemPrompt: m.systemPrompt != null ? m.systemPrompt : options.systemPrompt,
    temperature: m.temperature,
    maxTokens: m.maxTokens,
  }));
}


/**
 * Build a chat(params) adapter from an OllamaClient instance.
 * Uses chatFull(modelName, messages, opts) when available,
 * otherwise falls back to chat(modelName, messages, opts).
 */
function fromOllamaClient(client) {
  if (!client || typeof client !== 'object') {
    throw new OllamaProviderError('client required', 'bad_client');
  }
  const method = typeof client.chatFull === 'function' ? client.chatFull
               : typeof client.chat === 'function' ? client.chat
               : null;
  if (!method) {
    throw new OllamaProviderError('client must expose chatFull or chat', 'bad_client_method');
  }
  return async function chatAdapter(params) {
    const opts = {};
    if (params.temperature != null) opts.temperature = params.temperature;
    if (params.max_tokens != null) opts.num_predict = params.max_tokens;
    if (params.system != null) opts.system = params.system;
    return method.call(client, params.model, params.messages, opts);
  };
}

module.exports = { ollamaProvider, multiOllamaProviders, fromOllamaClient, extractContent, OllamaProviderError };

