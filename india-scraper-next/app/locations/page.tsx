'use client';
import {FormEvent,useEffect,useState} from 'react';
import LocationMap from '@/components/LocationMap';
import type {LocationRecord,SearchResult,Summary} from '@/lib/locations/catalog.cjs';
const number=(n:number)=>n.toLocaleString('en-US');
const initial={q:'',corpus:'',category:'',state:'',limit:'100',offset:'0',bbox:''};
function sourceUrl(value:unknown) { try {const url=new URL(String(value));return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;} }
export default function Locations() {
  const [filters,setFilters]=useState(initial),[request,setRequest]=useState(initial);
  const [summary,setSummary]=useState<Summary|null>(null),[result,setResult]=useState<SearchResult|null>(null);
  const [selected,setSelected]=useState<LocationRecord|null>(null),[error,setError]=useState(''),[summaryError,setSummaryError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{const controller=new AbortController();fetch('/api/locations?mode=summary',{signal:controller.signal}).then(async r=>{const body=await r.json();if(!r.ok)throw Error(body.error);setSummary(body);}).catch(e=>{if(e.name!=='AbortError')setSummaryError(e.message);});return()=>controller.abort();},[]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setSelected(null);setResult(null);
    const params=new URLSearchParams(Object.entries(request).filter(([,v])=>v!==''));
    fetch(`/api/locations?${params}`,{signal:controller.signal}).then(async r=>{const body=await r.json();if(!r.ok)throw Error(body.error);setResult(body);}).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[request]);
  function submit(event:FormEvent){event.preventDefault();setRequest({...filters,offset:'0',bbox:''});}
  function exportResults(){if(!result)return;const blob=new Blob([JSON.stringify({releaseState:'CONTROLLED_PREVIEW',scope:'CURRENT_RESULT_PAGE',filters:request,totalMatches:result.total,records:result.records},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='brahmini-locations-page.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const categories=[...new Set(summary?.categories.filter(c=>!filters.corpus||c.corpus===filters.corpus).map(c=>c.category)||[])].filter(Boolean);
  const states=[...new Set(summary?.states.filter(c=>!filters.corpus||c.corpus===filters.corpus).map(c=>c.state)||[])];
  const inputClass='w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white';
  const evidence=selected?.sourceRecord;
  const link=sourceUrl(evidence?.official_source_url);
  return <main className="min-h-screen bg-slate-950 text-slate-100">
    <div className="mx-auto max-w-[1700px] p-4 sm:p-8">
      <nav className="mb-8 flex flex-wrap gap-5 text-sm text-teal-300"><a href="/" className="underline">Business collector</a><a href="/knowledge" className="underline">Knowledge collector</a><a href="/locations/campaign" className="underline">Full TLPS campaign explorer →</a></nav>
      <header className="mb-7"><p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">Brahmini / Location knowledge</p><h1 className="text-3xl font-semibold sm:text-4xl">Find places. Keep the evidence.</h1><p className="mt-3 max-w-3xl text-slate-300">Search the absorbed TLPS campaign and global GeoNames snapshots. Inspect source records, explore the map, and export a bounded result page.</p></header>
      <div className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Catalogue totals">
        {[['Campaign records',summary?.campaign],['GeoNames records',summary?.global],['Execution-ready sites',summary?.executionReady]].map(([label,value])=><div key={String(label)} className="rounded-xl border border-slate-700 bg-slate-900 p-4"><p className="text-sm text-slate-400">{label}</p><p className="mt-1 text-2xl font-semibold">{typeof value==='number'?number(value):'—'}</p></div>)}
      </div>
      <p className="mb-6 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-200">Controlled preview · source listing does not establish availability, permission, safety, rates, field survey, or operational readiness. Cross-source duplicates remain separate. GeoNames snapshot: 23 July 2026.</p>
      <form onSubmit={submit} className="mb-5 grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <label className="text-sm lg:col-span-2">Search names and places<input className={inputClass} value={filters.q} onChange={e=>setFilters({...filters,q:e.target.value})} maxLength={160} placeholder="Paris, Mumbai, railway…" /></label>
        <label className="text-sm">Collection<select aria-label="Collection" className={inputClass} value={filters.corpus} onChange={e=>setFilters({...filters,corpus:e.target.value,category:'',state:''})}><option value="">All collections</option><option value="campaign">TLPS campaign</option><option value="global">GeoNames global</option></select></label>
        <label className="text-sm">Category<select aria-label="Category" className={inputClass} value={filters.category} onChange={e=>setFilters({...filters,category:e.target.value})}><option value="">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select></label>
        <label className="text-sm">State / country<select aria-label="State / country" className={inputClass} value={filters.state} onChange={e=>setFilters({...filters,state:e.target.value})}><option value="">All regions</option>{states.map(s=><option key={s}>{s}</option>)}</select></label>
        <div className="flex items-end gap-2"><label className="text-sm">Per page<select aria-label="Per page" className={inputClass} value={filters.limit} onChange={e=>setFilters({...filters,limit:e.target.value})}>{[50,100,250,500].map(n=><option key={n}>{n}</option>)}</select></label><button className="rounded-lg bg-teal-400 px-4 py-2.5 font-semibold text-slate-950" type="submit">Search</button></div>
      </form>
      {(error||summaryError)&&<p role="alert" className="mb-4 rounded bg-red-950 p-4 text-red-200">{error||summaryError}</p>}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p role="status">{loading?'Searching local catalogue…':result?`${number(result.total)} matches · showing ${number(result.records.length?result.offset+1:0)}–${number(result.offset+result.records.length)}`:'Catalogue unavailable'}</p>
        <div className="flex flex-wrap gap-3">{request.bbox&&<button className="text-amber-300 underline" onClick={()=>setRequest({...request,bbox:'',offset:'0'})}>Clear map boundary</button>}<button className="text-teal-300 underline disabled:opacity-40" disabled={!result?.records.length} onClick={exportResults}>Export this page (JSON)</button></div>
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <LocationMap records={result?.records||[]} selected={selected} onSelect={setSelected} onBounds={bbox=>setRequest({...request,bbox,offset:'0'})} />
        <section className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900" aria-label="Location results">
          <div className="max-h-[565px] overflow-y-auto divide-y divide-slate-800">
            {result?.records.map(record=><button key={record.id} onClick={()=>setSelected(record)} className={`block w-full px-4 py-3 text-left hover:bg-slate-800 ${selected?.id===record.id?'bg-slate-800 ring-1 ring-inset ring-teal-500':''}`}><span className="block font-medium text-teal-200">{record.name||record.id}</span><span className="block text-sm text-slate-300">{record.category} · {record.state}</span><span className="block text-xs text-slate-400">{record.corpus==='global'?'GeoNames':`TLPS / ${record.dataset}`} · {String(record.sourceRecord.status||'Unverified')}</span></button>)}
            {!loading&&result?.total===0&&<p className="p-6 text-slate-300">No records match these filters. Broaden the search or clear the map boundary.</p>}
          </div>
          <div className="flex justify-between border-t border-slate-700 p-3"><button className="rounded bg-slate-700 px-3 py-2 disabled:opacity-40" disabled={loading||!result||result.offset===0} onClick={()=>setRequest({...request,offset:String(Math.max(0,Number(request.offset)-Number(request.limit)))})}>Previous</button><button className="rounded bg-slate-700 px-3 py-2 disabled:opacity-40" disabled={loading||!result?.hasMore} onClick={()=>setRequest({...request,offset:String(Number(request.offset)+Number(request.limit))})}>Next</button></div>
        </section>
      </div>
      <section className="mt-5 rounded-2xl border border-slate-700 bg-slate-900 p-5" aria-label="Source evidence">
        <h2 className="text-xl font-semibold">{selected?selected.name:'Inspect a source record'}</h2>
        {selected&&evidence?<><p className="mt-2 text-sm text-slate-400">{selected.id} · {selected.latitude??'No latitude'}, {selected.longitude??'No longitude'}</p><dl className="my-4 grid gap-3 text-sm sm:grid-cols-3">{['verification_status','permission_status','field_survey_status'].map(key=><div key={key}><dt className="text-slate-400">{key.replaceAll('_',' ')}</dt><dd className="break-words text-amber-200">{String(evidence[key]||'Not supplied')}</dd></div>)}</dl>{link&&<a href={link} target="_blank" rel="noreferrer" className="text-teal-300 underline">Open original source ↗</a>}<details className="mt-4"><summary className="cursor-pointer text-teal-300">Original record and provenance</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{JSON.stringify(evidence,null,2)}</pre></details></>:<p className="mt-2 text-slate-400">Select a map pin or result to see its original fields, source link, and verification gates. Imported records are read-only. Planning edits and radar controls are available in the campaign explorer.</p>}
      </section>
    </div>
  </main>;
}
