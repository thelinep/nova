const {chromium}=require('@playwright/test');
const fs=require('node:fs/promises');
const path=require('node:path');
(async()=>{
  const baseURL=process.env.TLPS_CAPTURE_URL||'http://127.0.0.1:3194';
  // Provenance stays in the code repo; screenshots go to the brahmini-data submodule.
  const evidenceDirectory=path.join(process.cwd(),'docs/tlps-validation');
  const directory=path.join(process.cwd(),'data/tlps/media/tlps-validation');
  await fs.mkdir(directory,{recursive:true});await fs.mkdir(evidenceDirectory,{recursive:true});
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1150}});
    const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(`${baseURL}/locations`);
    await page.getByText('708,222',{exact:true}).waitFor();
    await page.getByLabel('Collection',{exact:true}).selectOption('global');
    await page.getByLabel('Search names and places').fill('Mumbai');
    const response=page.waitForResponse(r=>r.url().includes('/api/locations?')&&r.url().includes('q=Mumbai'));
    await page.getByRole('button',{name:'Search',exact:true}).click();
    const queryResult=await (await response).json();
    await page.getByRole('region',{name:'Location results'}).getByRole('button').first().click();
    await page.locator('.leaflet-interactive').first().waitFor({state:'visible'});
    await page.waitForTimeout(700);
    await page.screenshot({path:path.join(directory,'locations-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Fit results',exact:true}).click();
    await page.waitForTimeout(700);
    await page.screenshot({path:path.join(directory,'locations-mobile.png'),fullPage:true});
    const mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${baseURL}/locations/campaign`);
    const frame=page.frameLocator('iframe');
    await frame.locator('#mRecords').filter({hasText:'55731'}).waitFor();
    await frame.locator('[data-view="mapview"]').click();
    await frame.locator('#map.leaflet-container').waitFor({state:'visible'});
    await frame.locator('#map .pin-cluster').first().waitFor({state:'visible'});
    await page.waitForTimeout(700);
    await page.screenshot({path:path.join(directory,'campaign-desktop.png'),fullPage:true});
    const buildDirectory=process.env.BRAHMINI_NEXT_DIST_DIR||'.next-tlps';
    const provenance={capturedAt:new Date().toISOString(),baseURL,buildId:(await fs.readFile(path.join(process.cwd(),buildDirectory,'BUILD_ID'),'utf8')).trim(),query:'Mumbai',corpus:'global',matches:queryResult.total,pageErrors,mobileOverflow,screenshots:['locations-desktop.png','locations-mobile.png','campaign-desktop.png']};
    await fs.writeFile(path.join(evidenceDirectory,'capture.json'),JSON.stringify(provenance,null,2)+'\n');
    console.log(JSON.stringify(provenance,null,2));
    if(pageErrors.length||mobileOverflow)process.exitCode=1;
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
