import { NextResponse } from 'next/server';
import { getSources } from '@/lib/knowledge';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json(await getSources());
  } catch {
    return NextResponse.json({ error: 'Unable to load collected knowledge' }, { status: 500 });
  }
}
