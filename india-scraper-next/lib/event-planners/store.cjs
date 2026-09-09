const path=require('node:path');
const sqlite3=require('sqlite3');
const plannerCategories=['event planner','event management company','wedding planner','party planner'];
const isPlanner=category=>plannerCategories.includes(String(category||'').trim().toLowerCase());
const plannerPredicate="lower(trim(category)) IN ('event planner','event management company','wedding planner','party planner')";
const directory=()=>path.join(process.cwd(),'data/event-planners');
const filename=()=>path.join(directory(),'collection.db');
const open=(readonly=true)=>new Promise((resolve,reject)=>{const db=new sqlite3.Database(filename(),readonly?sqlite3.OPEN_READONLY:sqlite3.OPEN_READWRITE|sqlite3.OPEN_CREATE,error=>error?reject(error):resolve(db));});
const all=(db,sql,params=[])=>new Promise((resolve,reject)=>db.all(sql,params,(error,rows)=>error?reject(error):resolve(rows)));
const run=(db,sql,params=[])=>new Promise((resolve,reject)=>db.run(sql,params,function(error){error?reject(error):resolve({changes:this.changes,lastID:this.lastID});}));
const close=db=>new Promise((resolve,reject)=>db.close(error=>error?reject(error):resolve()));
async function initialize(db){
  await run(db,'PRAGMA journal_mode=WAL');await run(db,'PRAGMA busy_timeout=5000');
  await run(db,'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  await run(db,`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,district TEXT NOT NULL,state TEXT NOT NULL,state_code TEXT NOT NULL,directory_url TEXT NOT NULL,query TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,started_at TEXT,finished_at TEXT,results INTEGER NOT NULL DEFAULT 0,note TEXT,source_url TEXT)`);
  await run(db,`CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT,phone TEXT,website TEXT,address TEXT,rating TEXT,reviews TEXT,latitude REAL,longitude REAL,maps_url TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,raw_json TEXT NOT NULL)`);
  await run(db,'CREATE TABLE IF NOT EXISTS discoveries (task_id TEXT NOT NULL,business_id TEXT NOT NULL,captured_at TEXT NOT NULL,raw_json TEXT NOT NULL,PRIMARY KEY(task_id,business_id))');
  await run(db,'CREATE INDEX IF NOT EXISTS task_status ON tasks(status,state,district)');
  await run(db,'CREATE INDEX IF NOT EXISTS discovery_business ON discoveries(business_id)');
}
async function summary(db){
  const meta=Object.fromEntries((await all(db,'SELECT key,value FROM meta')).map(r=>[r.key,JSON.parse(r.value)]));
  const counts=await all(db,'SELECT status,count(*) AS count,sum(results) AS listings FROM tasks GROUP BY status');
  const [{businesses}]=await all(db,'SELECT count(*) AS businesses FROM businesses');
  const [{total}]=await all(db,'SELECT count(*) AS total FROM tasks');
  meta.matchedPlanners=(await all(db,`SELECT count(*) AS n FROM businesses WHERE ${plannerPredicate}`))[0].n;
  return {...meta,totalDistricts:total,uniqueBusinesses:businesses,counts,states:await all(db,`SELECT state,count(*) AS total,sum(CASE WHEN status NOT IN ('pending','running') THEN 1 ELSE 0 END) AS attempted FROM tasks GROUP BY state ORDER BY state`),active:await all(db,"SELECT district,state,started_at FROM tasks WHERE status='running'")};
}
async function readSummary(){const db=await open();try{return await summary(db);}finally{await close(db);}}
function queryParams(params){const limit=Number(params.get('limit')||50),offset=Number(params.get('offset')||0);if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0||offset>1000000)throw Error('INVALID_PAGINATION');const q=(params.get('q')||'').trim(),state=params.get('state')||'';if(q.length>160||state.length>100)throw Error('INVALID_FILTER');return {limit,offset,q,state};}
async function search(params){const {limit,offset,q,state}=queryParams(params);const db=await open();try{
  const clauses=[plannerPredicate],values=[];
  if(q){clauses.push("(b.name LIKE ? ESCAPE '\\' OR b.address LIKE ? ESCAPE '\\')");const term='%'+q.replace(/[\\%_]/g,'\\$&')+'%';values.push(term,term);}
  if(state){clauses.push('EXISTS (SELECT 1 FROM discoveries d JOIN tasks t ON t.id=d.task_id WHERE d.business_id=b.id AND t.state=?)');values.push(state);}
  const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
  const [{total}]=await all(db,`SELECT count(*) AS total FROM businesses b${where}`,values);
  const records=await all(db,`SELECT b.id,b.name,b.category,b.phone,b.website,b.address,b.rating,b.reviews,b.latitude,b.longitude,b.maps_url,b.last_seen FROM businesses b${where} ORDER BY b.name,b.id LIMIT ? OFFSET ?`,[...values,limit,offset]);
  for(const r of records)r.discoveredIn=await all(db,'SELECT t.district,t.state,t.status FROM discoveries d JOIN tasks t ON t.id=d.task_id WHERE d.business_id=?',[r.id]);
  return {total,limit,offset,hasMore:offset+records.length<total,records,districtMembership:'UNVERIFIED_SEARCH_ASSOCIATION'};
}finally{await close(db);}}
function placeKey(url){const parsed=new URL(url);const decoded=decodeURIComponent(url);const token=decoded.match(/!1s([^!?#]+)/)?.[1]||parsed.searchParams.get('query_place_id')||parsed.searchParams.get('cid');if(token)return 'google:'+token;for(const key of ['authuser','hl','g_ep','rclk'])parsed.searchParams.delete(key);return 'google:'+parsed.href;}
module.exports={directory,filename,open,all,run,close,initialize,summary,readSummary,search,queryParams,placeKey,isPlanner};
