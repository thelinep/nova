const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const puppeteer=require('puppeteer');
const root=path.join(__dirname,'../data/event-planners');
const source='https://igod.gov.in/sg/district/states';
async function fetchText(url){const response=await fetch(url,{headers:url.includes('/organizations_more/')?{'X-Requested-With':'XMLHttpRequest'}:{},signal:AbortSignal.timeout(40000)});if(!response.ok)throw Error(`${response.status}: ${url}`);return response.text();}
async function main(){
  await fs.mkdir(root,{recursive:true});
  const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page=await browser.newPage();
    const html=await fetchText(source);
    const states=await page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html');return [...d.querySelectorAll('a[href]')].filter(a=>/\/sg\/[^/]+\/E042\/organizations$/.test(a.href)).map(a=>({name:a.textContent.trim(),url:a.href,stateCode:a.href.split('/sg/')[1].split('/')[0]}));},html);
    if(states.length!==36)throw Error(`Expected 36 state/UT entries, found ${states.length}`);
    const districts=[],coverage=[];
    async function parse(html){return page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html');return [...d.querySelectorAll('.search-row')].map(row=>{const a=row.querySelector('.search-title');const detail=row.querySelector('a[href*="/sub_districts"]');return a?{name:a.textContent.replace(/\s+/g,' ').trim(),website:a.getAttribute('href'),directoryId:detail?.getAttribute('href')?.match(/\/district\/([^/]+)/)?.[1]||null}:null;}).filter(Boolean);},html);}
    for(const state of states){
      const body=await fetchText(state.url);
      const expected=Number(body.match(/([\d,]+)\s+Results/i)?.[1]?.replaceAll(',',''));
      if(!Number.isInteger(expected)||expected<1)throw Error(`Missing directory count for ${state.name}`);
      const rows=await parse(body),pages=[{url:state.url,sha256:crypto.createHash('sha256').update(body).digest('hex')}];
      while(rows.length<expected){
        const url=state.url.replace('/organizations',`/organizations_more/${rows.length}/${Math.min(5,expected-rows.length)}`);
        const next=await fetchText(url);const batch=await parse(next);if(!batch.length)throw Error(`Incomplete directory pagination for ${state.name}`);
        pages.push({url,sha256:crypto.createHash('sha256').update(next).digest('hex')});rows.push(...batch);
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      const unique=new Map(rows.map(r=>[r.name,r]));
      if(unique.size!==expected)throw Error(`Directory count mismatch ${state.name}: ${unique.size}/${expected}`);
      for(const r of unique.values())districts.push({...r,key:state.stateCode+':'+(r.directoryId||r.name),state:state.name,stateCode:state.stateCode,directoryUrl:state.url});
      coverage.push({state:state.name,stateCode:state.stateCode,expected,observed:unique.size,pages});
      console.log(`${state.name}: ${unique.size}/${expected}`);
    }
    const result={capturedAt:new Date().toISOString(),source,scope:'ALL_ENTRIES_IN_IGOD_STATE_DISTRICT_DIRECTORY',limitations:'Government website-directory entries are the query coverage frame, not proof of every current LGD district or every business. District membership of Maps results remains unverified.',states:coverage.length,total:districts.length,coverage,districts};
    await fs.writeFile(path.join(root,'districts.json'),JSON.stringify(result,null,2)+'\n');console.log(`Prepared ${districts.length} district queries across ${coverage.length} states/UTs`);
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1});
