import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
export const campaignFiles = ['district-context.json','district-headquarters.json','iocl-outlets.json','jiobp-outlets.json','media-ant-inventory.json','transport-inventory.json','world-capitals-currencies.json','world-film-locations.json'];
export async function campaignFile(file: string) {
  if (![...campaignFiles, 'index.html'].includes(file)) throw new Error('Unknown snapshot');
  return gunzipSync(await readFile(path.join(process.cwd(),'data/tlps/campaign',`${file}.gz`))).toString('utf8');
}
export function adaptExplorer(html: string) {
  // Keep the original compressed source byte-for-byte; namespace only the served view.
  const adapted = html
    .replaceAll('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/', '/vendor/leaflet/')
    .replaceAll('https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/', '/vendor/markercluster/')
    .replaceAll('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png')
    .replaceAll("maxZoom:20,attribution:'&copy; OpenStreetMap &copy; CARTO'", "maxZoom:19,attribution:'&copy; OpenStreetMap contributors'")
    .replaceAll('tlps-bkt-location-kbm', 'brahmini-tlps-campaign-v1')
    .replace(/loadExternal\('[^']*','([^']*)','data\/([^']+)'\)/g, "loadExternal('/api/tlps/snapshots/$2','$1')");
  const prelude = `const SEED=JSON.parse(document.getElementById('seed').textContent);
const SEED_IDS=new Set(SEED.records.map(r=>r.id));
function planningRecords(items){return Array.isArray(items)?items.filter(r=>r&&!SEED_IDS.has(r.id)&&/^LOC-\\d+$/.test(r.id)&&typeof r.name==='string'&&r.name.trim()&&[r.latitude,r.longitude].every((v,i)=>v===null||v===undefined||(typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=(i===0?90:180)))).map(r=>({...r,source_title:'Manual planning copy'})):[]}
let storedPlanning=[];try{storedPlanning=planningRecords(JSON.parse(localStorage.getItem('brahmini-tlps-campaign-v1')||'null')?.records)}catch{setTimeout(()=>alert('Saved planning data could not be read. Original source snapshots are still available.'),0)}
let db={...SEED,records:[...SEED.records,...storedPlanning]},records=db.records`;
  return adapted
    .replace(/const SEED=JSON.parse\(document.getElementById\('seed'\).textContent\)[\s\S]*?let records=db.records/,prelude)
    .replace(/function persist\(\)\{[^\n]+\}/,`function persist(){try{localStorage.setItem('brahmini-tlps-campaign-v1',JSON.stringify({schema_version:SEED.schema_version,records:planningRecords(records)}));update();return true}catch(error){alert('Planning edits could not be saved in this browser. Export JSON before closing this page. '+error.message);return false}}`)
    .replace(/importFile.onchange=[\s\S]*?;function resetSeed/,`importFile.onchange=e=>{let f=e.target.files[0];if(!f)return;let rd=new FileReader();rd.onload=()=>{try{let x=JSON.parse(rd.result),items=Array.isArray(x)?x:x.records;if(!Array.isArray(items))throw Error('records missing');let imported=planningRecords(items),source=records.filter(r=>SEED_IDS.has(r.id)||!/^LOC-\\d+$/.test(r.id)),locals=new Map(planningRecords(records).map(r=>[r.id,r]));imported.forEach(r=>locals.set(r.id,r));records=[...source,...locals.values()];if(!persist())return;renderRegistry();if(map)renderMap();alert('Imported '+imported.length+' manual planning records. Source snapshots are unchanged.')}catch(err){alert('Import failed: '+err.message)}};rd.readAsText(f)};function resetSeed`)
    .replace('function isEditableRecord(r){return !!r&&', 'function isEditableRecord(r){return !!r&&!SEED_IDS.has(r.id)&&')
    .replaceAll('persist();closeDrawer();','if(!persist())return;closeDrawer();');
}
