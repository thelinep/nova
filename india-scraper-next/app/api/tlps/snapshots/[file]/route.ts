import { campaignFile, campaignFiles } from '@/lib/locations/snapshots';
import { isLocalRequest } from '@/lib/local-only';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, {params}: {params: Promise<{file:string}>}) {
  if (!isLocalRequest(request)) return new Response('Local-only request required', {status:403});
  const {file} = await params;
  if (!campaignFiles.includes(file)) return new Response('Not found', {status:404});
  try { return new Response(await campaignFile(file), {headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}}); }
  catch { return new Response('Snapshot unavailable', {status:503}); }
}
