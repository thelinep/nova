'use client';
import Script from 'next/script';
import {useEffect, useRef, useState} from 'react';
import type {LocationRecord} from '@/lib/locations/catalog.cjs';
// Leaflet is pinned and vendored; it is loaded only in the browser.
declare global { interface Window { L?: any } }
export default function LocationMap({records, selected, onSelect, onBounds}: {records:LocationRecord[];selected:LocationRecord|null;onSelect:(record:LocationRecord)=>void;onBounds:(bbox:string)=>void}) {
  const container=useRef<HTMLDivElement>(null), map=useRef<any>(null), layer=useRef<any>(null);
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false),[tilesFailed,setTilesFailed]=useState(false);
  const onSelectRef=useRef(onSelect); onSelectRef.current=onSelect;
  useEffect(()=>{
    if(!ready || !container.current || !window.L) return;
    const L=window.L;
    const instance=L.map(container.current,{worldCopyJump:true,minZoom:2}).setView([22,35],3);
    map.current=instance;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).on('tileerror',()=>setTilesFailed(true)).addTo(instance);
    layer.current=L.layerGroup().addTo(instance);
    const observer=new ResizeObserver(()=>instance.invalidateSize()); observer.observe(container.current);
    return ()=>{observer.disconnect();instance.remove();map.current=null;layer.current=null;};
  },[ready]);
  useEffect(()=>{
    if(!layer.current || !window.L) return;
    layer.current.clearLayers();
    const points:number[][]=[];
    for(const record of records) {
      if(record.latitude===null || record.longitude===null) continue;
      points.push([record.latitude,record.longitude]);
      const label=document.createElement('span'); label.textContent=`${record.name} · ${record.category}`;
      window.L.circleMarker([record.latitude,record.longitude],{radius:6,color:record.corpus==='global'?'#2dd4bf':'#fbbf24',fillColor:record.corpus==='global'?'#0f766e':'#b45309',fillOpacity:0.8,weight:2})
        .bindTooltip(label).on('click',()=>onSelectRef.current(record)).addTo(layer.current);
    }
    if(points.length) map.current?.fitBounds(points,{padding:[30,30],maxZoom:12});
  },[records,ready]);
  useEffect(()=>{if(selected?.latitude!=null && selected.longitude!=null) map.current?.setView([selected.latitude,selected.longitude],Math.max(map.current.getZoom(),10));},[selected]);
  function fit() {
    const points=records.filter(r=>r.latitude!==null&&r.longitude!==null).map(r=>[r.latitude,r.longitude]);
    if(points.length) map.current?.fitBounds(points,{padding:[30,30],maxZoom:12});
  }
  function searchArea() {
    if(!map.current) return;
    const b=map.current.getBounds(), width=b.getEast()-b.getWest();
    const longitude=(n:number)=>((n+180)%360+360)%360-180;
    onBounds([width>=360?-180:longitude(b.getWest()),Math.max(-90,b.getSouth()),width>=360?180:longitude(b.getEast()),Math.min(90,b.getNorth())].join(','));
  }
  return <section aria-label="Location map" className="relative overflow-hidden rounded-2xl border border-slate-700 bg-slate-800">
    <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
    <Script src="/vendor/leaflet/leaflet.js" strategy="afterInteractive" onReady={()=>setReady(true)} onError={()=>setFailed(true)} />
    <div className="flex flex-wrap gap-2 p-3 text-sm">
      <button disabled={!ready} className="rounded bg-teal-800 px-3 py-2 disabled:opacity-40" onClick={fit}>Fit results</button>
      <button disabled={!ready} className="rounded bg-slate-700 px-3 py-2 disabled:opacity-40" onClick={searchArea}>Search this map area</button>
      <span className="self-center text-slate-300">Teal: GeoNames · Amber: campaign</span>
    </div>
    <div ref={container} data-testid="location-map" className="h-[420px] w-full sm:h-[540px]" style={{background:'#172b35'}} />
    {!ready && <p className="p-3">{failed?'Map library unavailable. Search and records remain usable.':'Loading map…'}</p>}
    {tilesFailed && <p role="status" className="p-3 text-amber-200">Some map tiles could not load. Local pins and search remain available.</p>}
    <p className="p-3 text-xs text-slate-300">Map shows the current result page only. Basemap tiles require internet. GeoNames: CC BY 4.0. Coordinates and planning anchors are not venue approval.</p>
  </section>;
}
