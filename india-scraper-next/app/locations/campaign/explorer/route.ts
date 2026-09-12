import { campaignFile, adaptExplorer } from '@/lib/locations/snapshots';
import { isLocalRequest } from '@/lib/local-only';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!isLocalRequest(request)) return new Response('Local-only request required', {status:403});
  try { return new Response(adaptExplorer(await campaignFile('index.html')), {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN'}}); }
  catch { return new Response('Campaign explorer source unavailable', {status:503}); }
}
