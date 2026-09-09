import { campaignFile, adaptExplorer } from '@/lib/locations/snapshots';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return new Response(adaptExplorer(await campaignFile('index.html')), {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN'}}); }
  catch { return new Response('Campaign explorer source unavailable', {status:503}); }
}
