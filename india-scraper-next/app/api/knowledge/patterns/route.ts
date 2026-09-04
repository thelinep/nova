import { NextResponse } from 'next/server';
import { getPatterns } from '@/lib/knowledge';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json(await getPatterns());
  } catch {
    return NextResponse.json({ error: 'Unable to load saved URL patterns' }, { status: 500 });
  }
}
