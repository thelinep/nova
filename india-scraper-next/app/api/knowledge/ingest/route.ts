import { NextRequest, NextResponse } from 'next/server';
import { KnowledgeStore } from '@/lib/knowledge/store';
import { chunkText } from '@/lib/knowledge/chunker';
import { collectUrl, validateCollectionUrl } from '@/lib/knowledge';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';

export async function POST(request: NextRequest) {
  if (!isLocalRequest(request)) return localOnlyResponse();
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
      // Collection goes through the same guarded path as the Knowledge
      // Collector UI (private-address/SSRF checks, redirect rejection, a
      // streamed 2MB cap) instead of an unguarded direct fetch() -- a raw
      // fetch of a user-supplied URL here would otherwise let this endpoint
      // be used to probe or hit internal network addresses.
      const validatedUrl = validateCollectionUrl(url);
      sourceKey = validatedUrl;
      const collected = await collectUrl(validatedUrl);
      sourceTitle = title || collected.title || validatedUrl;
      textContent = collected.content;
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
