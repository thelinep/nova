import { NextRequest, NextResponse } from 'next/server';
import { collectUrl, expandUrlPattern, savePattern, saveSource, validateCollectionUrl } from '@/lib/knowledge';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';

export const runtime = 'nodejs';

type Payload = { type?: string; url?: unknown; urls?: unknown; pattern?: unknown; start?: unknown; end?: unknown; label?: unknown; title?: unknown; content?: unknown };

export async function POST(request: NextRequest) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  let body: Payload;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  try {
    if (body.type === 'text') {
      if (typeof body.title !== 'string' || typeof body.content !== 'string' || !body.title.trim() || !body.content.trim()) throw new Error('Title and content are required');
      if (body.content.length > 2_000_000) throw new Error('Text is larger than 2 MB');
      await saveSource({ kind: 'text', url: null, title: body.title.trim(), content: body.content.trim(), content_type: 'text/plain' });
      return NextResponse.json({ collected: 1, failed: [] }, { status: 201 });
    }

    let urls: string[];
    if (body.type === 'pattern') {
      if (typeof body.pattern !== 'string' || !body.pattern.includes('{n}')) throw new Error('URL pattern must contain {n}');
      const pattern = body.pattern.trim();
      validateCollectionUrl(pattern.replaceAll('{n}', '0'));
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : pattern;
      await savePattern(label, pattern);
      urls = expandUrlPattern(pattern, body.start, body.end);
    } else if (body.type === 'urls') {
      if (!Array.isArray(body.urls) || body.urls.length === 0 || body.urls.length > 50) throw new Error('Provide 1 to 50 URLs');
      urls = body.urls.map(validateCollectionUrl);
    } else {
      urls = [validateCollectionUrl(body.url)];
    }

    const settled = await Promise.allSettled(urls.map(async (url) => saveSource(await collectUrl(url))));
    const failed = settled.flatMap((result, index) => result.status === 'rejected' ? [{ url: urls[index], error: result.reason instanceof Error ? result.reason.message : 'Collection failed' }] : []);
    return NextResponse.json({ collected: urls.length - failed.length, failed }, { status: failed.length ? 207 : 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Collection failed' }, { status: 400 });
  }
}
