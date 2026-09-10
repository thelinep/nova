import {NextRequest} from 'next/server';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const allowed=new Set(['TLPS-VALIDATION.md','EVENT-PLANNERS.md','QUERY-STUDIO.md','MAATAA-LOCAL-WORKSPACE.md','HELPERS-AND-SCHEDULER.md']);

export async function GET(request:NextRequest,{params}:{params:Promise<{name:string}>}){
  const host=request.headers.get('host');
  try{if(!host||!['localhost','127.0.0.1','[::1]'].includes(new URL('http://'+host).hostname))return new Response('Local evidence only',{status:403})}catch{return new Response('Local evidence only',{status:403})}
  const {name}=await params;
  if(!allowed.has(name))return new Response('Evidence document not found',{status:404});
  try{return new Response(await readFile(path.join(process.cwd(),'docs',name),'utf8'),{headers:{'Content-Type':'text/markdown; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
  catch{return new Response('Evidence document unavailable',{status:404})}
}
