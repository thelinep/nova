import {NextRequest,NextResponse} from 'next/server';
const {createStore}=require('@/lib/maataa-store.cjs');
const ai=require('@/lib/maataa-ai.cjs');
export const runtime='nodejs';
export const dynamic='force-dynamic';
const store=createStore();
function local(req:NextRequest){const host=req.headers.get('host');if(!host)return false;try{return ['localhost','127.0.0.1','[::1]'].includes(new URL('http://'+host).hostname)}catch{return false}}
function json(value:unknown,status=200){return NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}})}
export async function GET(req:NextRequest){if(!local(req))return json({error:'Local workspace only'},403);try{
 const id=req.nextUrl.searchParams.get('id');
 if(req.nextUrl.searchParams.get('export')&&id){const value=await store.export(id);return new NextResponse(JSON.stringify(value,null,2),{headers:{'Content-Type':'application/json','Content-Disposition':`attachment; filename="conversation-${id}.json"`,'Cache-Control':'no-store'}})}
 if(id)return json(await store.detail(id));
 if(req.nextUrl.searchParams.get('models'))return json(await ai.models());
 return json(await store.snapshot())
}catch(e){return json({error:e instanceof Error?e.message:'Request failed'},503)}}
export async function POST(req:NextRequest){if(!local(req)||!['http://'+req.headers.get('host'),'https://'+req.headers.get('host')].includes(req.headers.get('origin')||''))return json({error:'Same-origin local request required'},403);try{
 const raw=await req.text();if(raw.length>20000)return json({error:'Request too large'},413);const b=JSON.parse(raw);
 switch(b.action){
 case 'create':return json(await store.create(b));
 case 'categorize':return json(await store.categorize(b));
 case 'rename':return json(await store.rename(b));
 case 'archive':return json(await store.archive(b));
 case 'delete':return json(await store.remove(b));
 case 'draft':return json(await store.draft(b));
 case 'publish':return json(await store.publish(b));
 case 'load':case 'unload':await ai.control(b.model,b.action);return json({ok:true});
 case 'chat':{
 if(!['chat','query'].includes(b.mode))throw Error('Choose conversation or query mode');
 const history=await store.detail(b.id);const turn=await store.begin(b);
 try{const response=await ai.reply(b.model,b.prompt,history.messages,b.mode);await store.finish(turn.id,response,null);return json({response})}catch(e){await store.finish(turn.id,null,e instanceof Error?e.message:'Generation failed');throw e}
 }
 default:throw Error('Unknown action');
 }
 }catch(e){return json({error:e instanceof Error?e.message:'Request failed'},400)}}
