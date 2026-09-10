import {NextRequest,NextResponse} from 'next/server';
import {readSummary} from '@/lib/event-planners/store.cjs';
const {createStore}=require('@/lib/maataa-store.cjs');
const {createHelpers}=require('@/lib/maataa-helpers.cjs');
const roadmap=require('@/lib/roadmap.cjs');

export const runtime='nodejs';
export const dynamic='force-dynamic';

function isLocal(request:NextRequest){
  try{return ['localhost','127.0.0.1','[::1]'].includes(new URL('http://'+request.headers.get('host')).hostname)}catch{return false}
}

async function section<T>(load:()=>Promise<T>,shape:(value:T)=>unknown){
  try{return {available:true,data:shape(await load())}}
  catch{return {available:false,data:null}}
}

export async function GET(request:NextRequest){
  if(!isLocal(request))return NextResponse.json({error:'Open this roadmap on the Brahmini computer'},{status:403});
  const [collection,workspace,helpers]=await Promise.all([
    section(readSummary,roadmap.collectionView),
    section(()=>createStore().snapshot(),roadmap.workspaceView),
    section(()=>createHelpers().snapshot(),roadmap.helpersView),
  ]);
  return NextResponse.json({generatedAt:new Date().toISOString(),collection,workspace,helpers,milestones:roadmap.DELIVERY_MILESTONES},{headers:{'Cache-Control':'no-store'}});
}
