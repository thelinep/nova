'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../lib/model-qualifications');
const { memoryStore } = require('../scripts/validate-real-code-planner');
const digest = 'a'.repeat(64);
function qualify(store, capability, d = digest) {
  for (let trial = 1; trial <= 3; trial++) q.recordResult(store, {digest:d, capability, trial, runId:d+capability+trial, status:'passed'});
}
test('qualification requires three distinct trials, digest isolation, and zero failures', () => {
  const store = memoryStore();
  const row = {digest, capability:'single-file', runId:'same', status:'passed'};
  for(let i=0;i<3;i++) q.recordResult(store,row);
  assert.equal(q.isQualified(store,digest,'single-file'),false);
  qualify(store,'single-file');
  assert.equal(q.isQualified(store,digest,'single-file'),true);
  assert.equal(q.isQualified(store,'b'.repeat(64),'single-file'),false);
  q.recordResult(store,{...row,runId:'failed',status:'failed'});
  assert.equal(q.isQualified(store,digest,'single-file'),false);
  assert.throws(()=>q.recordResult(store,{...row,digest:'latest'}),/digest/);
});
test('selection prefers qualified llama3 and restricts smaller models and missing control checks', () => {
  const store = memoryStore();
  const models = [{name:'llama3.2:latest',digest:'b'.repeat(64)},{name:'llama3:latest',digest}];
  qualify(store,'single-file');
  assert.throws(()=>q.selectModel(store,models,'single-file'),/No installed/);
  for(const model of models) for(const cap of q.CAPABILITIES) qualify(store,cap,model.digest);
  assert.equal(q.selectModel(store,models,'single-file').model.name,'llama3:latest');
  assert.throws(()=>q.selectModel(store,[models[0]],'multi-file'),/No installed/);
  assert.throws(()=>q.selectModel(store,[{name:'maataa:latest',digest,details:{parameter_size:'3.2B'}}],'multi-file'),/No installed/);
});
test('production cannot bypass missing digests; ambiguity previews never contact Ollama', async () => {
  const p = require('../lib/code-planner');
  const scanner = {approvedRoot:()=>({path:'/tmp'}),walkFiles:()=>({files:[{relativePath:'a.js'}]})};
  const store = memoryStore();
  const preview = await p.preview(store,scanner,{}, {request:'Improve this'});
  assert.equal(preview.ready,false);
  assert.match(preview.clarification,/Please provide/);
  await assert.rejects(()=>p.plan(store,scanner,{}, {status:async()=>({reachable:true,models:[{name:'llama3:latest'}]})},{request:'Change value in a.js to 2'}),/No installed model is qualified/);
});

test('registry persists across SQLite reopen and preview reports actually omitted files', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const {openDb, Store} = require('../lib/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'nova-qualification-'));
  const source = path.join(dir,'source');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'a.js'),'const value = 1;\n');
  fs.writeFileSync(path.join(source,'large.txt'),'x'.repeat(40000));
  let connection = openDb(path.join(dir,'db'));
  try {
    for(const cap of q.CAPABILITIES) qualify(new Store(connection.db),cap);
    connection.db.close(); connection = openDb(path.join(dir,'db'));
    const store = new Store(connection.db);
    assert.equal(q.isQualified(store,digest,'multi-file'),true);
    const scanner = require('../lib/workspace-scanner');
    const root = scanner.approveRoot(store,{path:source});
    const preview = await require('../lib/code-planner').preview(store,scanner,{
      status:async()=>({reachable:true,models:[{name:'llama3:latest',digest}]}),
      show:async()=>({capabilities:['completion'],template:'chat',details:{parameter_size:'8B'},model_info:{'llama.context_length':8192}})
    },{rootId:root.id,request:'Change value in a.js from 1 to 2'});
    assert.equal(preview.ready,true);
    assert.deepEqual(preview.repositoryScope.omittedFiles,['large.txt']);
    assert.equal(preview.selectedModel.digest,digest);
  } finally {connection.db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
