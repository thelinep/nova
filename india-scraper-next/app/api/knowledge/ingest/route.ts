import { NextRequest, NextResponse } from 'next/server';
import { KnowledgeStore } from '@/lib/knowledge/store';
import { chunkText } from '@/lib/knowledge/chunker';

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type = 'text', key, title, content, url, chunkSize, chunkOverlap } = body;

    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 });
    }

    let sourceType: 'text' | 'url' | 'document' | 'business' = 'text';
    let sourceKey = key;
    let sourceTitle = title || key;
    let textContent = content || '';

    if (type === 'url' && url) {
      sourceType = 'url';
      sourceKey = url;
      sourceTitle = title || url;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        return NextResponse.json({ error: `Failed to fetch URL: ${res.status}` }, { status: 502 });
      }
      const html = await res.text();
      textContent = extractTextFromHtml(html);
    } else if (type === 'document' && content) {
      sourceType = 'document';
    } else if (type === 'text' && content) {
      sourceType = 'text';
    } else {
      return NextResponse.json({ error: 'content is required for text/document types' }, { status: 400 });
    }

    const store = new KnowledgeStore();
    const chunks = chunkText(textContent, { size: chunkSize || 300, overlap: chunkOverlap || 50 });

    await store.ingestChunks(
      sourceKey,
      chunks,
      { source_type: sourceType, source_key: sourceKey, title: sourceTitle, metadata: { type } }
    );

    return NextResponse.json({
      success: true,
      source_key: sourceKey,
      chunks: chunks.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Knowledge ingest error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
