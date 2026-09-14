'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../lib/workspace-scanner');
const { proposeChange, checkProposal, approveProposal, executeProposal, createBatch, checkBatch, approveBatch, executeBatch } = require('../lib/workspace-changes');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){return stores.get(name)?.get(id)||null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row;}};}

test('draft patch preserves original and runs syntax checks in a bounded workspace copy',()=>{
  const rootPath=fs.mkdtempSync(path.join(os.tmpdir(),'nova-change-root-'));
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-change-data-'));
  fs.mkdirSync(path.join(rootPath,'src'));
  const source=path.join(rootPath,'src','main.js');
  fs.writeFileSync(source,'const answer = 41;\nconsole.log(answer);\n');
  const store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  const proposal=proposeChange(store,scanner,{rootId:root.id,relativePath:'src/main.js',find:'const answer = 41;',replacement:'const answer = 42;',impact:'Correct the expected answer.'});
  assert.equal(proposal.status,'draft');
  assert.match(proposal.diff,/^-const answer = 41;/m);
  assert.match(proposal.diff,/^\+const answer = 42;/m);
  assert.equal(proposal.permissions.originalWorkspaceWrite,false);
  const checked=checkProposal(store,scanner,dataDir,proposal.id);
  assert.equal(checked.status,'checks-passed');
  assert.equal(fs.readFileSync(source,'utf8'),'const answer = 41;\nconsole.log(answer);\n');
  assert.equal(fs.readFileSync(checked.copy.targetPath,'utf8'),'const answer = 42;\nconsole.log(answer);\n');
  assert.equal(checked.checks.find(item=>item.name==='JavaScript syntax').status,'passed');
});

test('patch proposals reject ambiguous text, path escape and stale source',()=>{
  const rootPath=fs.mkdtempSync(path.join(os.tmpdir(),'nova-change-root-'));
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-change-data-'));
  fs.writeFileSync(path.join(rootPath,'file.txt'),'repeat\nrepeat\n');
  const store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  assert.throws(()=>proposeChange(store,scanner,{rootId:root.id,relativePath:'../outside.txt',find:'a',replacement:'b'}),/leaves the approved root/);
  assert.throws(()=>proposeChange(store,scanner,{rootId:root.id,relativePath:'file.txt',find:'repeat',replacement:'done'}),/more than once/);
  const proposal=proposeChange(store,scanner,{rootId:root.id,relativePath:'file.txt',find:'repeat\nrepeat',replacement:'done'});
  fs.writeFileSync(path.join(rootPath,'file.txt'),'changed elsewhere\n');
  assert.throws(()=>checkProposal(store,scanner,dataDir,proposal.id),/changed after this proposal/);
});

test('each original-workspace write requires approval and records rollback evidence',()=>{
  const rootPath=fs.mkdtempSync(path.join(os.tmpdir(),'nova-write-root-'));
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-write-data-'));
  const source=path.join(rootPath,'settings.json');
  fs.writeFileSync(source,'{"enabled":false}\n');
  const store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  const proposal=proposeChange(store,scanner,{rootId:root.id,relativePath:'settings.json',find:'false',replacement:'true',impact:'Enable the reviewed setting.'});
  assert.throws(()=>executeProposal(store,scanner,dataDir,proposal.id),/needs an unused explicit approval/);
  assert.throws(()=>approveProposal(store,scanner,proposal.id),/Safe checks must pass/);
  checkProposal(store,scanner,dataDir,proposal.id);
  const approved=approveProposal(store,scanner,proposal.id);
  assert.equal(approved.status,'approved');
  assert.equal(approved.approval.affectedFiles[0].beforeSha256,proposal.sourceSha256);
  const applied=executeProposal(store,scanner,dataDir,proposal.id);
  assert.equal(fs.readFileSync(source,'utf8'),'{"enabled":true}\n');
  assert.equal(applied.status,'applied');
  assert.equal(applied.execution.affectedFiles[0].afterSha256,proposal.proposedSha256);
  assert.equal(fs.readFileSync(applied.rollback.backupPath,'utf8'),'{"enabled":false}\n');
  assert.equal(applied.rollback.originalSha256,proposal.sourceSha256);
  assert.equal(applied.approval.consumedAt,applied.appliedAt);
  assert.throws(()=>executeProposal(store,scanner,dataDir,proposal.id),/needs an unused explicit approval/);
});

test('multi-file batches validate dependency order and apply atomically after one approval',()=>{
  const rootPath=fs.mkdtempSync(path.join(os.tmpdir(),'nova-batch-root-')),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-batch-data-'));
  fs.writeFileSync(path.join(rootPath,'config.json'),'{"enabled":false}\n');
  fs.writeFileSync(path.join(rootPath,'main.js'),'const enabled = false;\n');
  const store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  const batch=createBatch(store,scanner,{rootId:root.id,summary:'Enable feature across config and code',changes:[
    {relativePath:'main.js',find:'false',replacement:'true',dependsOn:['config.json']},
    {relativePath:'config.json',find:'false',replacement:'true'},
  ]});
  assert.deepEqual(batch.orderedFiles,['config.json','main.js']);
  assert.throws(()=>executeBatch(store,scanner,dataDir,batch.id),/explicit approval/);
  assert.equal(checkBatch(store,scanner,dataDir,batch.id).status,'checks-passed');
  const approved=approveBatch(store,scanner,batch.id);
  assert.equal(approved.approval.hashes.length,2);
  const applied=executeBatch(store,scanner,dataDir,batch.id);
  assert.equal(fs.readFileSync(path.join(rootPath,'config.json'),'utf8'),'{"enabled":true}\n');
  assert.equal(fs.readFileSync(path.join(rootPath,'main.js'),'utf8'),'const enabled = true;\n');
  assert.equal(fs.readFileSync(path.join(applied.rollback.directory,'config.json'),'utf8'),'{"enabled":false}\n');
});
