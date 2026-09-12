import { NextRequest, NextResponse } from 'next/server';
import { getPatterns } from '@/lib/knowledge';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  try {
    return NextResponse.json(await getPatterns());
  } catch {
    return NextResponse.json({ error: 'Unable to load saved URL patterns' }, { status: 500 });
  }
}
