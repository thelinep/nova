import { NextRequest, NextResponse } from 'next/server';
import { KnowledgeStore } from '@/lib/knowledge/store';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const q = searchParams.get('q');
    const topK = parseInt(searchParams.get('topK') || '5', 10);

    if (!q) {
      return NextResponse.json({ error: 'q query parameter is required' }, { status: 400 });
    }

    const store = new KnowledgeStore();
    const results = await store.search(q, topK);

    return NextResponse.json({
      query: q,
      results: results.map(r => ({
        score: r.score,
        content: r.chunk.content,
        source_type: r.source.source_type,
        source_key: r.source.source_key,
        title: r.source.title,
        metadata: r.chunk.metadata,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Knowledge search error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
