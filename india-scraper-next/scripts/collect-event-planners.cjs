#!/usr/bin/env node
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const puppeteer=require('puppeteer');
const store=require('../lib/event-planners/store.cjs');
const {open,all,run,close,initialize,summary,placeKey}=store;
const root=path.join(__dirname,'../data/event-planners');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let halted=false,browser,db,ownsLock=false;
const lock=path.join(root,'runner.lock');
const meta=async(key,value)=>run(db,'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,JSON.stringify(value)]);
async function exportSnapshot(){
  const status=await summary(db);status.updatedAt=new Date().toISOString();
  await fs.writeFile(path.join(root,'status.json.tmp'),JSON.stringify(status,null,2)+'\n');await fs.rename(path.join(root,'status.json.tmp'),path.join(root,'status.json'));
  const candidates=await all(db,'SELECT id,name,category,phone,website,address,rating,reviews,latitude,longitude,maps_url,first_seen,last_seen FROM businesses ORDER BY name,id');
  const records=candidates.filter(r=>store.isPlanner(r.category));
  const otherSearchCandidates=candidates.filter(r=>!store.isPlanner(r.category));
  const coverage=await all(db,'SELECT id,district,state,query,status,attempts,results,note,started_at,finished_at,source_url FROM tasks ORDER BY state,district');
  const discoveries=await all(db,'SELECT task_id,business_id,captured_at FROM discoveries');
  await fs.writeFile(path.join(root,'event-planners.json.tmp'),JSON.stringify({status,districtMembership:'UNVERIFIED_SEARCH_ASSOCIATION',categoryRule:'Exact displayed category: Event planner, Event management company, Wedding planner, Party planner',records,otherSearchCandidates,coverage,discoveries},null,2));await fs.rename(path.join(root,'event-planners.json.tmp'),path.join(root,'event-planners.json'));
  const columns=['id','name','category','phone','website','address','rating','reviews','latitude','longitude','maps_url','first_seen','last_seen'];
  const cell=value=>{const text=String(value??'');return '"'+(/^[=+@\-\t\r]/.test(text)?"'":'')+text.replaceAll('"','""')+'"';};
  await fs.writeFile(path.join(root,'event-planners.csv.tmp'),[columns.join(','),...records.map(r=>columns.map(c=>cell(r[c])).join(','))].join('\n')+'\n');await fs.rename(path.join(root,'event-planners.csv.tmp'),path.join(root,'event-planners.csv'));
}
async function inspect(page){return page.evaluate(()=>{
  const text=document.body.innerText;
  return {blocked:/\/sorry\//.test(location.href)||/unusual traffic|our systems have detected|verify you are human/i.test(text),consent:/consent.google/.test(location.hostname),limited:/limited view of Google Maps/i.test(text),empty:/no results found|Google Maps can't find/i.test(text),end:/You've reached the end of the list/i.test(text),feed:!!document.querySelector('[role="feed"]')};
});}
async function cards(page){return page.evaluate(()=>{
  const clean=el=>el?.textContent?.replace(/\s+/g,' ').trim()||null;
  return [...document.querySelectorAll('a.hfpxzc[aria-label]')].map(link=>{
    const card=link.closest('[role="article"]')||link.closest('.Nv2PK');if(!card)return null;
    const rows=[...card.querySelectorAll('.W4Efsd')].filter(el=>!el.querySelector('.W4Efsd')&&!el.querySelector('[role="img"]'));
    const identity=rows.find(el=>!el.querySelector('.UsdlK')&&!/^(Open|Closed|Closes|Temporarily)/i.test(clean(el)||''));
    const spans=identity?[...identity.children].map(clean).filter(Boolean):[];
    const category=spans[0]||null,address=spans.slice(1).join(' ').replace(/^[·\s\uE000-\uF8FF]+/,'')||null;
    const url=link.href,coords=url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    return {name:link.getAttribute('aria-label'),category,address,phone:clean(card.querySelector('.UsdlK')),website:card.querySelector('a[data-value="Website"]')?.href||null,rating:clean(card.querySelector('.MW4etd')),reviews:clean(card.querySelector('.UY7F9')),latitude:coords?Number(coords[1]):null,longitude:coords?Number(coords[2]):null,maps_url:url,visibleText:card.innerText,contact_person:null,source:'Google Maps public search',verification_status:'SOURCE_LISTED_UNVERIFIED',district_membership:'UNVERIFIED_SEARCH_ASSOCIATION'};
  }).filter(r=>r&&r.name);
});}
async function collect(page,task){
  const url='https://www.google.com/maps/search/'+encodeURIComponent(task.query)+'?hl=en';
  const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
  if([403,429].includes(response?.status()))return {status:'blocked',note:`HTTP ${response.status()}`,records:[],url};
  await page.waitForSelector('[role="feed"], h1, iframe[src*="recaptcha"]',{timeout:15000}).catch(()=>{});
  let state=await inspect(page);if(state.blocked||state.consent)return {status:'blocked',note:state.consent?'Consent/sign-in requires operator review':'Google traffic challenge; stopped without bypass',records:[],url};
  const found=new Map();let unchanged=0,reason='scroll_limit';
  for(let round=0;round<40;round++){
    state=await inspect(page);if(state.blocked){reason='blocked';break;}
    const before=found.size;for(const record of await cards(page))found.set(placeKey(record.maps_url),record);
    if(state.end){reason='end_of_visible_list';break;}
    if(state.empty){reason='explicit_no_results';break;}
    if(found.size===before)unchanged++;else unchanged=0;
    if(unchanged>=3){reason=state.limited?'limited_view':'stalled_feed';break;}
    if(!state.feed){reason='unrecognized_layout';break;}
    await page.evaluate(()=>{const feed=document.querySelector('[role="feed"]');feed.scrollTop=feed.scrollHeight;});
    await pause(1200);
  }
  const status=reason==='blocked'?'blocked':reason==='explicit_no_results'?'no_results':state.limited?'limited_view':reason==='end_of_visible_list'?'visible_list_exhausted':reason==='unrecognized_layout'?'failed':'partial';
  return {status,note:reason+(state.limited?'; Google limited-view banner present':''),records:[...found.values()],url};
}
async function persist(task,result){
  const now=new Date().toISOString();await run(db,'BEGIN IMMEDIATE');
  try{
    for(const r of result.records){const id=placeKey(r.maps_url);await run(db,`INSERT INTO businesses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,phone=COALESCE(excluded.phone,businesses.phone),website=COALESCE(excluded.website,businesses.website),address=COALESCE(excluded.address,businesses.address),rating=excluded.rating,reviews=excluded.reviews,latitude=excluded.latitude,longitude=excluded.longitude,maps_url=excluded.maps_url,last_seen=excluded.last_seen,raw_json=excluded.raw_json`,[id,r.name,r.category,r.phone,r.website,r.address,r.rating,r.reviews,r.latitude,r.longitude,r.maps_url,now,now,JSON.stringify(r)]);await run(db,'INSERT OR IGNORE INTO discoveries VALUES (?,?,?,?)',[task.id,id,now,JSON.stringify(r)]);}
    await run(db,'UPDATE tasks SET status=?,finished_at=?,results=?,note=?,source_url=? WHERE id=?',[result.status,now,result.records.length,result.note,result.url,task.id]);await run(db,'COMMIT');
  }catch(error){await run(db,'ROLLBACK');throw error;}
}
async function main(){
  await fs.mkdir(root,{recursive:true});
  try{await fs.writeFile(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx'});ownsLock=true;}catch(error){if(error.code!=='EEXIST')throw error;const prior=JSON.parse(await fs.readFile(lock,'utf8'));let alive=true;try{process.kill(prior.pid,0);}catch{alive=false;}if(alive)throw Error(`Runner ${prior.pid} already active`);await fs.unlink(lock);await fs.writeFile(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx'});ownsLock=true;}
  db=await open(false);await initialize(db);await require('../lib/event-planners/studio.cjs').init(db);
  if(process.argv.includes('--export-only')){await exportSnapshot();return;}
  const bytes=await fs.readFile(path.join(root,'districts.json'));const manifest=JSON.parse(bytes);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const prior=await all(db,'SELECT value FROM meta WHERE key=?',['districtManifestSha256']);
  if(prior.length&&JSON.parse(prior[0].value)!==hash)throw Error('District manifest changed; use a new collection database to avoid mixing coverage frames.');
  await meta('districtManifestSha256',hash);await meta('districtSource',manifest.source);await meta('districtSnapshotAt',manifest.capturedAt);await meta('scope',manifest.scope);await meta('category','event planners');await meta('completeness','NOT_EXHAUSTIVE_GOOGLE_MAPS_SEARCH_SNAPSHOT');await meta('contactPolicy','Public business listings only; no personal contact inference');
  for(const district of manifest.districts)await run(db,'INSERT OR IGNORE INTO tasks (id,district,state,state_code,directory_url,query) VALUES (?,?,?,?,?,?)',[district.key,district.name,district.state,district.stateCode,district.directoryUrl,`event planners in ${district.name} district, ${district.state}, India`]);
  await run(db,"UPDATE tasks SET status='pending',note='Resuming interrupted task' WHERE status='running'");
  if(process.argv.includes('--retry-failed'))await run(db,"UPDATE tasks SET status='pending' WHERE status='failed'");
  const blocked=await all(db,"SELECT count(*) AS n FROM tasks WHERE status='blocked'");if(blocked[0].n)throw Error('A Google access challenge remains unresolved. Collection stays paused; do not bypass it.');
  await meta('runnerState','running');await meta('pauseReason',null);await meta('lastError',null);await meta('finishedAt',null);await meta('runnerPid',process.pid);await meta('lastStartedAt',new Date().toISOString());await exportSnapshot();
  const tasks=await all(db,"SELECT * FROM tasks WHERE status='pending' ORDER BY state,district");let index=0,processed=0;
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  // One browser page limits pressure on the source and keeps SQLite transactions serial.
  const page=await browser.newPage();await page.setViewport({width:1400,height:900});
  while(index<tasks.length&&!halted){
    if(await fs.access(path.join(root,'PAUSE')).then(()=>true,()=>false)){halted=true;await meta('pauseReason','Operator PAUSE file');break;}
    const task=tasks[index++];await run(db,"UPDATE tasks SET status='running',attempts=attempts+1,started_at=? WHERE id=?",[new Date().toISOString(),task.id]);
    try{const result=await collect(page,task);await persist(task,result);console.log(`${new Date().toISOString()} ${task.state} / ${task.district}: ${result.records.length} (${result.status})`);if(result.status==='blocked'){halted=true;await meta('pauseReason',result.note);await page.screenshot({path:path.join(root,'blocked.png')}).catch(()=>{});}}
    catch(error){await run(db,"UPDATE tasks SET status='failed',finished_at=?,note=? WHERE id=?",[new Date().toISOString(),error.message,task.id]);console.error(`${task.district}: ${error.message}`);halted=true;await meta('pauseReason','Search failed; remaining districts preserved: '+error.message);}
    await require('../lib/event-planners/studio.cjs').init(db);
    processed++;await meta('lastProgressAt',new Date().toISOString());await exportSnapshot();await pause(2000);
  }
  await meta('runnerState',halted?'paused':'finished');await meta('finishedAt',new Date().toISOString());await exportSnapshot();
}
if(require.main===module){process.on('SIGTERM',()=>{halted=true});process.on('SIGINT',()=>{halted=true});}
module.exports={collect};
if(require.main===module)main().catch(async error=>{console.error(error);if(db){await meta('runnerState','failed').catch(()=>{});await meta('lastError',error.message).catch(()=>{});await exportSnapshot().catch(()=>{});}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close().catch(()=>{});if(db)await close(db).catch(()=>{});if(ownsLock)await fs.unlink(lock).catch(()=>{});});
