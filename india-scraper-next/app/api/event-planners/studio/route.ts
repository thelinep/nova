import {NextRequest,NextResponse} from 'next/server';
import {execFile} from 'node:child_process';
import path from 'node:path';
const studio=require('@/lib/event-planners/studio.cjs');
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(){return NextResponse.json(await studio.get(),{headers:{'Cache-Control':'no-store'}});}
export async function POST(req:NextRequest){
 const origin=req.headers.get('origin');
 if(!origin||!['http://'+req.headers.get('host'),'https://'+req.headers.get('host')].includes(origin))return NextResponse.json({error:'Same-origin request required'},{status:403});
 try{const body=await req.json();if(body.action==='save')return NextResponse.json(await studio.save(body));
 if(body.action!=='test'||typeof body.methodId!=='string'||typeof body.districtId!=='string')throw Error('Invalid test request');
 const result=await new Promise<string>((resolve,reject)=>execFile(process.execPath,[path.join(process.cwd(),'scripts/test-event-query.cjs'),body.methodId,body.districtId],{timeout:120000,maxBuffer:1024*1024},(error,stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve(stdout)));
 return NextResponse.json(JSON.parse(result));
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Request failed'},{status:400});}
}
