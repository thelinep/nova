'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const scanner=require('../lib/workspace-scanner');
const changes=require('../lib/workspace-changes');
const runner=require('../lib/workspace-runner');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){return stores.get(name)?.get(id)||null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row;}};}
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nova-runner-root-'));execFileSync('git',['init','-q'],{cwd:root});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node check.js',format:'node format.js',build:'node build.js'}}));fs.writeFileSync(path.join(root,'check.js'),'console.log("tests ok")\n');fs.writeFileSync(path.join(root,'format.js'),'console.log("format ok")\n');fs.writeFileSync(path.join(root,'build.js'),'console.log("build ok")\n');return root;}

test('controlled commands require a repository allowlist and persist bounded output',async()=>{
  const rootPath=fixture(),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-runner-data-')),store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  await assert.rejects(()=>runner.run(store,scanner,changes,dataDir,{rootId:root.id,action:'test'}),/not allowlisted/);
  runner.allowRepository(store,scanner,root.id,['test','git-status','not-a-command']);
  const result=await runner.run(store,scanner,changes,dataDir,{rootId:root.id,action:'test'});
  assert.equal(result.status,'passed');assert.match(result.output,/tests ok/);assert.ok(result.workspaceCopy.path.startsWith(dataDir));assert.equal(result.outputLimitBytes,256*1024);
  const status=await runner.run(store,scanner,changes,dataDir,{rootId:root.id,action:'git-status'});
  assert.equal(status.status,'passed');assert.equal(status.workspaceCopy,null);assert.match(status.output,/package.json/);
});

test('one active command is enforced per workspace',async()=>{
  const rootPath=fixture(),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-runner-data-')),store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  runner.allowRepository(store,scanner,root.id,['diagnostics']);runner._active.set(root.id,'existing');
  await assert.rejects(()=>runner.run(store,scanner,changes,dataDir,{rootId:root.id,action:'diagnostics'}),/already active/);
  runner._active.delete(root.id);
});

test('restart recovery marks orphaned commands interrupted',()=>{
  const store=memoryStore();store.put('workspaceRuns',{id:'run_orphan',rootId:'root_1',status:'running',startedAt:new Date().toISOString()});
  assert.equal(runner.recoverInterrupted(store),1);
  assert.equal(store.get('workspaceRuns','run_orphan').status,'interrupted');
  assert.equal(store.get('workspaceRuns','run_orphan').recovery.resumable,false);
});

test('command capture enforces timeout and records termination',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nova-capture-'));
  const result=await runner.capture(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,timeoutMs:80,homeDir:root,cacheDir:root});
  assert.equal(result.timedOut,true);assert.notEqual(result.signal,null);
});

test('command capture truncates output at the declared byte ceiling',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nova-capture-'));
  const result=await runner.capture(process.execPath,['-e',`process.stdout.write('x'.repeat(${runner.constants.OUTPUT_LIMIT+4096}))`],{cwd:root,timeoutMs:5000,homeDir:root,cacheDir:root});
  assert.equal(result.code,0);assert.equal(result.truncated,true);assert.equal(result.output.length,runner.constants.OUTPUT_LIMIT);
});

test('an active command can be cancelled and leaves the workspace copy isolated',async()=>{
  const rootPath=fixture(),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-runner-cancel-')),store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  fs.writeFileSync(path.join(rootPath,'package.json'),JSON.stringify({scripts:{test:'node -e "setInterval(()=>{},1000)"'}}));
  runner.allowRepository(store,scanner,root.id,['test']);
  const promise=runner.run(store,scanner,changes,dataDir,{rootId:root.id,action:'test'});
  let record;for(let i=0;i<100;i++){record=store.all('workspaceRuns')[0];if(record&&runner._active.get(root.id)?.child)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(record);runner.cancel(store,record.id);
  const result=await promise;
  assert.equal(result.status,'cancelled');assert.equal(result.cancelRequested,true);assert.ok(result.workspaceCopy.path.startsWith(dataDir));
  assert.equal(runner._active.has(root.id),false);
});

test('finished and unknown commands cannot be cancelled',()=>{
  const store=memoryStore();store.put('workspaceRuns',{id:'done',rootId:'root',status:'passed'});
  assert.throws(()=>runner.cancel(store,'missing'),/Unknown workspace run/);
  assert.throws(()=>runner.cancel(store,'done'),/Only an active run/);
});
