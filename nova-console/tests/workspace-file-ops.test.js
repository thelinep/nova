'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');
const planner = require('../lib/code-planner');
const { createBatch, checkBatch, approveBatch, executeBatch, rollbackBatch } = changes;

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){return stores.get(name)?.get(id)||null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row;}};}
function setup(files){
  const rootPath=fs.mkdtempSync(path.join(os.tmpdir(),'nova-ops-')),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-ops-data-'));
  for(const [rel,content] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(rootPath,rel)),{recursive:true});fs.writeFileSync(path.join(rootPath,rel),content);}
  const store=memoryStore(),root=scanner.approveRoot(store,{path:rootPath});
  return {rootPath:fs.realpathSync(rootPath),dataDir,store,root,read:rel=>fs.readFileSync(path.join(rootPath,rel),'utf8'),exists:rel=>fs.existsSync(path.join(rootPath,rel))};
}

test('create, edit, rename and delete apply atomically after checks and approval, then roll back', () => {
  const w=setup({'src/index.js':'const x = 1;\n','old.js':'module.exports = 1;\n','unused.txt':'bye\n'});
  const batch=createBatch(w.store,scanner,{rootId:w.root.id,summary:'Restructure',changes:[
    {operation:'create',relativePath:'src/lib/util.js',content:'module.exports = () => 2;\n'},
    {relativePath:'src/index.js',find:'const x = 1;',replacement:'const x = require("./lib/util")();',dependsOn:['src/lib/util.js']},
    {operation:'rename',relativePath:'old.js',toPath:'src/legacy/old.js'},
    {operation:'delete',relativePath:'unused.txt'},
  ]});
  assert.deepEqual(batch.operations,{create:1,edit:1,rename:1,delete:1});
  assert.match(batch.changes[0].diff,/^--- \/dev\/null/);
  const checked=checkBatch(w.store,scanner,w.dataDir,batch.id);
  assert.equal(checked.status,'checks-passed',JSON.stringify(checked.checks));
  assert.ok(!w.exists('src/lib/util.js'),'checks never touch the approved folder');
  assert.ok(fs.existsSync(path.join(checked.copy.path,'src/legacy/old.js')));
  approveBatch(w.store,scanner,batch.id);
  const applied=executeBatch(w.store,scanner,w.dataDir,batch.id);
  assert.equal(applied.status,'applied');
  assert.equal(w.read('src/lib/util.js'),'module.exports = () => 2;\n');
  assert.equal(w.read('src/index.js'),'const x = require("./lib/util")();\n');
  assert.equal(w.read('src/legacy/old.js'),'module.exports = 1;\n');
  assert.ok(!w.exists('old.js')&&!w.exists('unused.txt'));
  const rolled=rollbackBatch(w.store,scanner,w.dataDir,batch.id);
  assert.equal(rolled.status,'rolled-back');
  assert.equal(w.read('src/index.js'),'const x = 1;\n');
  assert.equal(w.read('old.js'),'module.exports = 1;\n');
  assert.equal(w.read('unused.txt'),'bye\n');
  assert.ok(!w.exists('src/lib')&&!w.exists('src/legacy'),'folders created by the batch are removed');
});

test('a single create is a valid batch, but a single edit still uses a proposal', () => {
  const w=setup({'a.txt':'old\n'});
  assert.equal(createBatch(w.store,scanner,{rootId:w.root.id,changes:[{operation:'create',relativePath:'b.txt',content:'new\n'}]}).changes.length,1);
  assert.throws(()=>createBatch(w.store,scanner,{rootId:w.root.id,changes:[{relativePath:'a.txt',find:'old',replacement:'new'}]}),/at least two/);
});

test('unsafe or conflicting operations are refused at draft time', () => {
  const w=setup({'a.txt':'a\n','b.txt':'b\n','.git/config':'x\n'});
  const draft=changes0=>()=>createBatch(w.store,scanner,{rootId:w.root.id,changes:changes0});
  assert.throws(draft([{operation:'create',relativePath:'a.txt',content:'x'}]),/already exists/);
  assert.throws(draft([{operation:'create',relativePath:'../escape.txt',content:'x'}]),/leaves the approved root/);
  assert.throws(draft([{operation:'create',relativePath:'/tmp/abs.txt',content:'x'}]),/relative/);
  assert.throws(draft([{operation:'create',relativePath:'.git/hooks/pre-commit',content:'x'}]),/version-control/);
  assert.throws(draft([{operation:'create',relativePath:'node_modules/x/index.js',content:'x'}]),/Generated/);
  assert.throws(draft([{operation:'create',relativePath:'a.txt/child.txt',content:'x'}]),/parent of the target is a file/);
  assert.throws(draft([{operation:'create',relativePath:'bin.dat',content:'a\0b'}]),/Binary/);
  assert.throws(draft([{operation:'delete',relativePath:'missing.txt'}]),/does not exist/);
  assert.throws(draft([{operation:'rename',relativePath:'a.txt',toPath:'b.txt'}]),/destination already exists/);
  assert.throws(draft([{operation:'rename',relativePath:'a.txt',toPath:'c.txt'},{operation:'create',relativePath:'c.txt',content:'x'}]),/only once/);
  assert.throws(draft([{operation:'chmod',relativePath:'a.txt'}]),/Unknown change operation/);
  fs.mkdirSync(path.join(w.rootPath,'real'));fs.symlinkSync(path.join(w.rootPath,'real'),path.join(w.rootPath,'link'));
  assert.throws(draft([{operation:'create',relativePath:'link/x.txt',content:'x'}]),/symbolic links/);
});

test('invalid created JSON fails checks and cannot be approved', () => {
  const w=setup({'a.txt':'a\n'});
  const batch=createBatch(w.store,scanner,{rootId:w.root.id,changes:[{operation:'create',relativePath:'config.json',content:'{ nope'}]});
  assert.equal(checkBatch(w.store,scanner,w.dataDir,batch.id).status,'checks-failed');
  assert.throws(()=>approveBatch(w.store,scanner,batch.id),/must pass validation/);
});

test('a path that changes after drafting blocks approval and execution', () => {
  const w=setup({'a.txt':'a\n'});
  const batch=createBatch(w.store,scanner,{rootId:w.root.id,changes:[{operation:'create',relativePath:'new.txt',content:'n\n'},{operation:'delete',relativePath:'a.txt'}]});
  checkBatch(w.store,scanner,w.dataDir,batch.id);
  fs.writeFileSync(path.join(w.rootPath,'new.txt'),'someone else\n');
  assert.throws(()=>approveBatch(w.store,scanner,batch.id),/Source changed/);
  assert.equal(w.read('new.txt'),'someone else\n');
  assert.equal(w.read('a.txt'),'a\n');
});

test('a mid-batch failure undoes creates, deletes and renames already applied', () => {
  const w=setup({'keep.txt':'k\n','gone.txt':'g\n','move.txt':'m\n'});
  const batch=createBatch(w.store,scanner,{rootId:w.root.id,changes:[
    {operation:'create',relativePath:'dir/first.txt',content:'1\n'},
    {operation:'delete',relativePath:'gone.txt'},
    {operation:'rename',relativePath:'move.txt',toPath:'moved/move.txt'},
    {operation:'create',relativePath:'second.txt',content:'2\n'},
  ]});
  checkBatch(w.store,scanner,w.dataDir,batch.id);approveBatch(w.store,scanner,batch.id);
  const rename=fs.renameSync;let calls=0;
  fs.renameSync=(a,b)=>{calls++;if(calls===3)throw new Error('injected failure');return rename(a,b);};
  try{assert.throws(()=>executeBatch(w.store,scanner,w.dataDir,batch.id),/all changed files were rolled back/);}finally{fs.renameSync=rename;}
  assert.ok(!w.exists('dir')&&!w.exists('second.txt')&&!w.exists('moved'));
  assert.equal(w.read('gone.txt'),'g\n');
  assert.equal(w.read('move.txt'),'m\n');
  assert.equal(w.store.get('workspaceChangeBatches',batch.id).status,'approved');
});

test('rollback refuses when a file changed after the batch was applied', () => {
  const w=setup({'a.txt':'a\n'});
  const batch=createBatch(w.store,scanner,{rootId:w.root.id,changes:[{operation:'create',relativePath:'b.txt',content:'b\n'}]});
  checkBatch(w.store,scanner,w.dataDir,batch.id);approveBatch(w.store,scanner,batch.id);executeBatch(w.store,scanner,w.dataDir,batch.id);
  fs.writeFileSync(path.join(w.rootPath,'b.txt'),'edited by hand\n');
  assert.throws(()=>rollbackBatch(w.store,scanner,w.dataDir,batch.id),/changed after the batch was applied/);
  assert.equal(w.read('b.txt'),'edited by hand\n');
});

test('planner accepts new-file requests and turns a create into a checked batch', async () => {
  const w=setup({'src/index.js':'module.exports = {};\n'});
  w.store.put('models',{id:'qwen:test',name:'qwen:test',runtime:'ollama'});
  const analysis=planner.analyzeRequest('Create src/date.js that exports formatDate so dates render as YYYY-MM-DD',['src/index.js']);
  assert.equal(analysis.sufficientlySpecific,true);
  assert.deepEqual(analysis.newTargets,['src/date.js']);
  const reply={summary:'Add date helper',acceptanceCriteria:[{description:'src/date.js exports formatDate'}],changes:[{operation:'create',relativePath:'src/date.js',content:'exports.formatDate = d => d.toISOString().slice(0, 10);\n'}]};
  const ollama={status:async()=>({reachable:true,models:[{name:'qwen:test'}]}),show:async()=>({capabilities:['completion'],template:'x',details:{},model_info:{'llama.context_length':8192}}),chatFull:async()=>({message:{content:JSON.stringify(reply)}})};
  const result=await planner.plan(w.store,scanner,changes,ollama,{rootId:w.root.id,modelId:'qwen:test',request:'Create src/date.js that exports formatDate so dates render as YYYY-MM-DD'},{qualificationBypass:true});
  assert.equal(result.type,'workspace-change-batch');
  assert.equal(result.changes[0].operation,'create');
  assert.ok(result.acceptanceChecks.some(c=>c.type==='file-exists'&&c.relativePath==='src/date.js'));
  assert.ok(!w.exists('src/date.js'),'planning never writes');
  const checked=checkBatch(w.store,scanner,w.dataDir,result.id);
  assert.equal(checked.status,'checks-passed',JSON.stringify(checked.checks));
});

test('planner rejects creates over existing files and deletes of unknown files', () => {
  const files=[{relativePath:'a.js',content:'x\n'}],known=new Set(['a.js']);
  const wrap=changes0=>JSON.stringify({summary:'s',acceptanceCriteria:[{description:'d'}],changes:changes0});
  assert.throws(()=>planner.validateDraft(wrap([{operation:'create',relativePath:'a.js',content:'y'}]),files,known),/already exists/);
  assert.throws(()=>planner.validateDraft(wrap([{operation:'delete',relativePath:'b.js'}]),files,known),/does not exist/);
  assert.throws(()=>planner.validateDraft(wrap([{operation:'rename',relativePath:'a.js',toPath:'../x.js'}]),files,known),/unsafe rename/);
  assert.equal(planner.validateDraft(wrap([{operation:'delete',relativePath:'a.js'}]),files,known).changes[0].operation,'delete');
});
