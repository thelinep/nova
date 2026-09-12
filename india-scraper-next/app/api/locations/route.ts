import { NextRequest, NextResponse } from 'next/server';
import { InputError, search, summary } from '@/lib/locations/catalog.cjs';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  try {
    const params = request.nextUrl.searchParams;
    const mode = params.get('mode') || 'records';
    if (!['records', 'summary'].includes(mode)) return NextResponse.json({error:'Unknown mode'}, {status:400});
    const result = mode === 'summary' ? await summary() : await search(params);
    return NextResponse.json(result, {headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    if (error instanceof InputError) return NextResponse.json({error:error.message}, {status:400});
    console.error('Location catalogue query failed:', error);
    return NextResponse.json({error:'Location catalogue unavailable. Run npm run locations:import in the app directory.'}, {status:503});
  }
}
