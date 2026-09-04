/**
 * @jest-environment node
 */
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Helper to (re)load the module fresh with current process.env
async function load() {
  let mod: typeof import('@/lib/ollamaHelper');
  jest.isolateModules(() => {
    mod = require('@/lib/ollamaHelper');
  });
  return mod!;
}

describe('extractWithOllama', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    // restore a clean env without USE_OLLAMA
    process.env = { ...originalEnv };
    delete process.env.USE_OLLAMA;
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns null immediately when USE_OLLAMA=false', async () => {
    process.env.USE_OLLAMA = 'false';
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('some text');
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('parses JSON from a well-formed response', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        response: '{"contact_person":"John","phone":"123","company_name":"Acme","address":"1 Main St"}',
      },
    });
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('Acme plumbing, John 123');
    expect(result).toEqual({
      contact_person: 'John',
      phone: '123',
      company_name: 'Acme',
      address: '1 Main St',
    });
  });

  it('extracts JSON embedded in surrounding text', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { response: 'Sure! Here is the data: {"company_name":"Beta","phone":null} done.' },
    });
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('Beta corp');
    expect(result).toEqual({ company_name: 'Beta', phone: null });
  });

  it('returns null when response contains no JSON object', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: 'no json here' } });
    const { extractWithOllama } = await load();
    expect(await extractWithOllama('text')).toBeNull();
  });

  it('returns null when JSON is malformed', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: '{invalid json,}' } });
    const { extractWithOllama } = await load();
    expect(await extractWithOllama('text')).toBeNull();
  });

  it('returns null and logs when axios request fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('connection refused'));
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('text');
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it('posts to the default Ollama URL with default model', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: '{"a":1}' } });
    const { extractWithOllama } = await load();
    await extractWithOllama('hello');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        model: 'llama3',
        stream: false,
        format: 'json',
        prompt: expect.stringContaining('hello'),
      })
    );
  });

  it('respects OLLAMA_URL and OLLAMA_MODEL env overrides', async () => {
    process.env.OLLAMA_URL = 'http://example.com/gen';
    process.env.OLLAMA_MODEL = 'mistral';
    mockedAxios.post.mockResolvedValue({ data: { response: '{"x":2}' } });
    const { extractWithOllama } = await load();
    await extractWithOllama('test');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://example.com/gen',
      expect.objectContaining({ model: 'mistral' })
    );
  });

  it('includes the input text in the prompt', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: '{"a":1}' } });
    const { extractWithOllama } = await load();
    await extractWithOllama('UNIQUE_MARKER_TEXT');
    const call = mockedAxios.post.mock.calls[0][1] as any;
    expect(call.prompt).toContain('UNIQUE_MARKER_TEXT');
  });
});
