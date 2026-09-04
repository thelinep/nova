import axios from 'axios';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';

export async function extractWithOllama(text: string): Promise<any> {
  if (process.env.USE_OLLAMA === 'false') return null;
  try {
    const prompt = `
      Extract the following fields from the text below and return a valid JSON object with keys: "contact_person", "phone", "company_name", "address".
      If a field is not present, set it to null.
      Text: "${text}"
    `;
    const response = await axios.post(OLLAMA_URL, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
    });
    const raw = response.data.response;
    const jsonMatch = raw.match(/\{.*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (error) {
    console.error('Ollama extraction failed:', error);
    return null;
  }
}
