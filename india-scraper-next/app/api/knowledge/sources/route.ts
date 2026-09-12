import { NextRequest, NextResponse } from 'next/server';
import { getSources } from '@/lib/knowledge';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  try {
    return NextResponse.json(await getSources());
  } catch {
    return NextResponse.json({ error: 'Unable to load collected knowledge' }, { status: 500 });
  }
}
