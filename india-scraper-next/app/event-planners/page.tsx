'use client';
import {useEffect,useState} from 'react';
import type {CollectionSummary,PlannerResults} from '@/lib/event-planners/store.cjs';
function safeLink(value:string|null){try{const url=new URL(value||'');return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}}
export default function EventPlanners(){
  const [summary,setSummary]=useState<CollectionSummary|null>(null),[results,setResults]=useState<PlannerResults|null>(null),[error,setError]=useState('');
  const [q,setQ]=useState(''),[state,setState]=useState(''),[query,setQuery]=useState({q:'',state:'',offset:0});
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    async function refresh(){try{
      const [s,r]=await Promise.all([fetch('/api/event-planners?mode=summary',{signal:controller.signal}),fetch('/api/event-planners?'+new URLSearchParams({q:query.q,state:query.state,offset:String(query.offset),limit:'50'}),{signal:controller.signal})]);
      const [sb,rb]=await Promise.all([s.json(),r.json()]);if(!s.ok||!r.ok)throw Error(sb.error||rb.error);
      if(active){setSummary(sb);setResults(rb);setError('');}
    }catch(e){if(active&&e instanceof Error&&e.name!=='AbortError')setError(e.message);}}
    void refresh();const timer=setInterval(refresh,10000);return()=>{active=false;controller.abort();clearInterval(timer);};
  },[query]);
  const attempted=summary?.counts.filter(c=>!['pending','running'].includes(c.status)).reduce((n,c)=>n+c.count,0)||0;
  return <main className="min-h-screen bg-slate-950 p-5 text-slate-100 sm:p-9"><div className="mx-auto max-w-6xl">
    <nav className="mb-7 flex gap-5 text-sm text-teal-300"><a href="/">Business collector</a><a href="/locations">Location catalogue</a><a href="/knowledge">Knowledge collector</a></nav>
    <h1 className="text-3xl font-semibold">Event planners across India</h1>
    <p className="mt-3 text-slate-300">Live Google Maps collection · refreshes every 10 seconds · public business listings</p>
    <p className="mt-2 text-sm text-slate-400">Search and CSV show only listings categorized as Event planner, Event management company, Wedding planner, or Party planner. Other search candidates are retained separately in the JSON download. The unique listings count includes all candidates.</p>
    <div className="my-6 grid gap-3 sm:grid-cols-3">{[['Unique listings',summary?.uniqueBusinesses],['District searches attempted',summary?`${attempted} / ${summary.totalDistricts}`:null],['Runner',summary?.runnerState]].map(([label,value])=><div key={String(label)} className="rounded-xl border border-slate-700 bg-slate-900 p-4"><p className="text-sm text-slate-400">{label}</p><p className="mt-2 text-2xl">{value??'Preparing…'}</p></div>)}</div>
    <p className="rounded-xl border border-amber-900 bg-amber-950/30 p-4 text-sm text-amber-200">Google may show limited or nearby results. This is not an exhaustive business census. District labels identify the searches that found a listing; district membership and operating status are unverified.</p>
    {error&&<p role="alert" className="my-4 text-red-300">{error}</p>}
    {summary&&<section className="my-5 space-y-2 text-sm" aria-label="Collection progress"><p>{summary.active.map(a=>`Searching ${a.district}, ${a.state}`).join(' · ')||'No district currently active'}</p><p className="text-slate-400">{summary.counts.map(c=>`${c.status.replaceAll('_',' ')}: ${c.count}`).join(' · ')}</p>{summary.pauseReason&&<p className="text-amber-300">Paused: {summary.pauseReason}</p>}{summary.lastError&&<p className="text-red-300">{summary.lastError}</p>}<p className="text-slate-400">Last progress: {summary.lastProgressAt||'Waiting for first result'}</p></section>}
    <form onSubmit={e=>{e.preventDefault();setQuery({q,state,offset:0});}} className="my-5 flex flex-wrap gap-3">
      <input aria-label="Search collected planners" className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-900 p-3" value={q} maxLength={160} onChange={e=>setQ(e.target.value)} placeholder="Business name or address" />
      <select aria-label="Search state" className="max-w-full rounded border border-slate-600 bg-slate-900 p-3" value={state} onChange={e=>setState(e.target.value)}><option value="">All search states</option>{summary?.states.map(s=><option key={s.state}>{s.state}</option>)}</select>
      <button className="rounded bg-teal-400 px-5 py-3 font-semibold text-slate-950">Search</button>
    </form>
    <div className="my-4 flex flex-wrap justify-between gap-3 text-sm"><span>{results?.total??0} matching listings</span><div className="flex gap-4 text-teal-300"><a href="/api/event-planners?format=csv">Download latest CSV</a><a href="/api/event-planners?format=json">Download JSON + coverage</a></div></div>
    <div className="grid gap-3 md:grid-cols-2">{results?.records.map(r=><article key={r.id} className="min-w-0 rounded-xl border border-slate-700 bg-slate-900 p-5"><h2 className="text-lg font-medium text-teal-200">{r.name}</h2><p className="mt-1 text-sm text-slate-400">{r.category||'Category not supplied'}{r.rating?` · ${r.rating} stars`:''}</p><p className="my-3 text-sm">{r.address||'Address not supplied'}<br/>{r.phone||'Phone not supplied'}</p><p className="mb-3 text-xs text-slate-400">Found by: {r.discoveredIn.map(d=>`${d.district}, ${d.state}`).join('; ')}</p><div className="flex gap-4 text-sm text-teal-300">{safeLink(r.maps_url)&&<a href={safeLink(r.maps_url)!} target="_blank" rel="noreferrer">Google Maps ↗</a>}{safeLink(r.website)&&<a href={safeLink(r.website)!} target="_blank" rel="noreferrer">Business website ↗</a>}</div></article>)}</div>
    {!results?.records.length&&!error&&<p className="p-6 text-slate-400">No matching listings collected yet.</p>}
    <div className="mt-5 flex justify-between"><button className="rounded bg-slate-700 px-4 py-2 disabled:opacity-40" disabled={!results||results.offset===0} onClick={()=>setQuery({...query,offset:Math.max(0,query.offset-50)})}>Previous</button><button className="rounded bg-slate-700 px-4 py-2 disabled:opacity-40" disabled={!results?.hasMore} onClick={()=>setQuery({...query,offset:query.offset+50})}>Next</button></div>
  </div></main>;
}
