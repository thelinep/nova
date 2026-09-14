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
