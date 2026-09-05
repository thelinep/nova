export interface Chunk {
  index: number;
  content: string;
  metadata?: Record<string, any>;
}

export interface ChunkOptions {
  size?: number;
  overlap?: number;
  splitBy?: 'word' | 'sentence' | 'line';
}

function splitBySentence(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function splitByLine(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

function splitByWord(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Splits text into overlapping chunks.
 * Default strategy: word-based sliding window. Sentence/line modes keep whole units.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const { size = 300, overlap = 0, splitBy = 'word' } = options;
  if (!text || size <= 0) return [];

  const units =
    splitBy === 'sentence'
      ? splitBySentence(text)
      : splitBy === 'line'
      ? splitByLine(text)
      : splitByWord(text);

  if (units.length === 0) return [];

  const step = Math.max(1, size - overlap);
  const chunks: Chunk[] = [];

  for (let i = 0; i < units.length; i += step) {
    const slice = units.slice(i, i + size);
    if (slice.length === 0) continue;
    const content = splitBy === 'word' ? slice.join(' ') : slice.join('\n');
    if (!content.trim()) continue;
    chunks.push({ index: chunks.length, content: content.trim() });
  }

  return chunks;
}

/**
 * Prepares scraped business rows as knowledge chunks.
 */
export function chunkBusinessRecord(record: Record<string, any>): Chunk[] {
  const parts = [
    record.business_name,
    record.category ? `Category: ${record.category}` : '',
    record.contact_person ? `Contact: ${record.contact_person}` : '',
    record.phone ? `Phone: ${record.phone}` : '',
    record.address ? `Address: ${record.address}` : '',
    record.website ? `Website: ${record.website}` : '',
    record.rating ? `Rating: ${record.rating}` : '',
    record.reviews ? `Reviews: ${record.reviews}` : '',
    record.maps_url ? `Maps: ${record.maps_url}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return parts ? [{ index: 0, content: parts, metadata: { type: 'business', id: record.id } }] : [];
}
