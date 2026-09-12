import {NextRequest,NextResponse} from 'next/server';
import {readSummary,search} from '@/lib/event-planners/store.cjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {isLocalRequest,localOnlyResponse} from '@/lib/local-only';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
  if(!isLocalRequest(request))return localOnlyResponse();
  try{
    const params=request.nextUrl.searchParams;
    const format=params.get('format');
    if(format){
      if(!['csv','json'].includes(format))return NextResponse.json({error:'Unknown export format'},{status:400});
      const data=await readFile(path.join(process.cwd(),'data/event-planners',`event-planners.${format}`),'utf8');
      return new Response(data,{headers:{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'application/json','Content-Disposition':`attachment; filename="event-planners.${format}"`,'Cache-Control':'no-store'}});
    }
    if(params.get('mode')==='summary')return NextResponse.json(await readSummary(),{headers:{'Cache-Control':'no-store'}});
    return NextResponse.json(await search(params),{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    if(error instanceof Error&&error.message.startsWith('INVALID_'))return NextResponse.json({error:error.message},{status:400});
    return NextResponse.json({error:'Collection is not available yet. Check the saved runner status.'},{status:503});
  }
}
