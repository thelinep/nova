'use strict';
/* App Builder: description → template project → development loop → checked batch → apply. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');
const runner = require('../lib/workspace-runner');
const planner = require('../lib/code-planner');
const devLoop = require('../lib/dev-loop');
const projects = require('../lib/workspace-projects');
const builder = require('../lib/app-builder');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(name,id){const row=stores.get(name)?.get(id);return row?JSON.parse(JSON.stringify(row)):null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,JSON.parse(JSON.stringify(row)));return row;},delete(name,id){stores.get(name)?.delete(id);}};}
function fakeOllama(replies,prompts){
  return {
    status:async()=>({reachable:true,models:[{name:'coder:test'}]}),
    show:async()=>({capabilities:['completion'],template:'x',details:{},model_info:{'llama.context_length':8192}}),
    chatFull:async(_m,messages)=>{prompts.push(messages[messages.length-1].content);const next=replies.shift();return {message:{content:JSON.stringify(next)},done_reason:'stop'};},
  };
}
function setup(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nova-apps-'));
  process.env.NOVA_PROJECTS_DIR=path.join(home,'Maataa Projects');
  const store=memoryStore(),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-apps-data-'));
  store.put('models',{id:'coder:test',name:'coder:test',runtime:'ollama'});
  const parent=builder.ensureProjectsRoot(store,scanner);
  return {store,dataDir,parent};
}
function deps(s,ollama){
  return {scanner,projects,runner,devLoop,loopDeps:{scanner,changes,runner,planner,ollama,dataDir:s.dataDir,planOptions:{qualificationBypass:true}}};
}

test('suggests a template and a free folder name from the description', () => {
  assert.equal(builder.suggestTemplate('A todo list website with dark mode'),'static-site');
  assert.equal(builder.suggestTemplate('REST API for books with CRUD'),'node-api');
  assert.equal(builder.suggestTemplate('एक React ऐप'),'vite-react');
  assert.equal(builder.suggestName('A todo list website with dark mode'),'todo-list-dark-mode');
  assert.match(builder.suggestName('मेरे लिए एक कैलकुलेटर ऐप'),/^app-\d{8}$/);
  assert.equal(builder.suggestName('todo list',n=>n==='todo-list'),'todo-list-2');
  const request=builder.composeRequest('static-site','a tip calculator');
  assert.equal(planner.analyzeRequest(request,['index.html','styles.css','main.js','test/site.test.js']).sufficientlySpecific,true,'the composed request passes the planner\'s specificity check');
  assert.equal(planner.analyzeRequest(builder.composeRequest('node-api','books CRUD'),['src/app.js','test/app.test.js']).sufficientlySpecific,true);
});

test('the projects folder is created and approved once', () => {
  const s=setup();
  assert.ok(fs.existsSync(process.env.NOVA_PROJECTS_DIR));
  assert.equal(builder.ensureProjectsRoot(s.store,scanner).id,s.parent.id);
  assert.equal(s.store.all('workspaceRoots').length,1);
});

test('draft writes nothing; start builds a tested app; nothing lands before approval', async () => {
  const s=setup(),prompts=[];
  const ollama=fakeOllama([{summary:'tip calculator',acceptanceCriteria:[{description:'npm test passes'}],changes:[
    {operation:'edit',relativePath:'index.html',find:'<body>',replacement:'<body>\n<main id="calc"><input id="bill"><output id="tip"></output></main>'},
  ]}],prompts);
  const draft=builder.draft(s.store,{scanner,projects},{description:'A tip calculator: enter the bill and see a 15% tip',parentRootId:s.parent.id,modelId:'coder:test'});
  assert.equal(draft.status,'drafted');
  assert.equal(draft.template,'static-site');
  assert.equal(draft.name,'tip-calculator-enter-bill');
  assert.equal(fs.existsSync(draft.targetPath),false,'drafting writes nothing');
  const started=builder.start(s.store,deps(s,ollama),draft.id);
  assert.equal(started.status,'building');
  assert.ok(fs.existsSync(path.join(started.targetPath,'package.json')),'the template project exists');
  const root=s.store.get('workspaceRoots',started.rootId);
  assert.deepEqual(root.commandAllowlist.actions.sort(),[...builder.COMMANDS].sort());
  for(let i=0;i<200&&s.store.get('workspaceLoops',started.loopId).status==='running';i++)await new Promise(r=>setTimeout(r,50));
  const done=builder.detail(s.store,draft.id);
  assert.equal(done.status,'ready',done.error||JSON.stringify(done.loop));
  assert.ok(done.batchId);
  assert.match(prompts[0],/Update index\.html, styles\.css and main\.js/);
  const before=fs.readFileSync(path.join(started.targetPath,'index.html'),'utf8');
  assert.doesNotMatch(before,/id="calc"/,'the project is untouched until the batch is approved');
  changes.approveBatch(s.store,scanner,done.batchId);
  changes.executeBatch(s.store,scanner,s.dataDir,done.batchId);
  assert.match(fs.readFileSync(path.join(started.targetPath,'index.html'),'utf8'),/id="calc"/);
  assert.equal(builder.detail(s.store,draft.id).status,'applied');
  assert.equal(spawnSync(process.execPath,['--test'],{cwd:started.targetPath}).status,0,'the new app passes its own tests');
  assert.throws(()=>builder.start(s.store,deps(s,ollama),draft.id),/already started/);
});

test('rejects vague input and a missing model', () => {
  const s=setup();
  assert.throws(()=>builder.draft(s.store,{scanner,projects},{description:'app',parentRootId:s.parent.id,modelId:'x'}),/Describe the app/);
  assert.throws(()=>builder.draft(s.store,{scanner,projects},{description:'A notes website with search',parentRootId:s.parent.id}),/Choose the local model/);
  assert.throws(()=>builder.draft(s.store,{scanner,projects},{description:'A notes website with search',parentRootId:'root_nope',modelId:'x'}));
});

test('API: folder, suggestion, draft and start are wired; an unreachable model ends the build with a reason', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-apps-api-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e', "const {server}=require('./server'); server.on('listening',()=>process.send(server.address()));"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, NOVA_LIBRARY_DIR: path.join(dataDir, 'library'), NOVA_PROJECTS_DIR: path.join(dataDir, 'Maataa Projects'), OLLAMA_HOST: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const [address] = await once(child, 'message');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (route, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(base + route, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject); req.end(data);
  });
  try {
    const templates = await call('/api/app-builder/templates');
    assert.deepEqual(templates.json.templates.map(t => t.id).sort(), ['node-api', 'static-site', 'vite-react']);
    const folder = await call('/api/app-builder/projects-folder', {});
    assert.equal(folder.status, 200);
    assert.equal(folder.json.label, 'Maataa Projects');
    const suggestion = await call('/api/app-builder/suggest', { description: 'Books REST API with CRUD' });
    assert.equal(suggestion.json.template, 'node-api');
    const drafted = await call('/api/app-builder/builds', { description: 'Books REST API with CRUD', parentRootId: folder.json.id, modelId: 'qwen2.5-coder:7b' });
    assert.equal(drafted.status, 201, JSON.stringify(drafted.json));
    assert.equal(fs.existsSync(drafted.json.targetPath), false);
    const started = await call(`/api/app-builder/builds/${drafted.json.id}/start`, {});
    assert.equal(started.status, 202, JSON.stringify(started.json));
    assert.ok(fs.existsSync(path.join(started.json.targetPath, 'src/app.js')), 'the template project was created');
    let detail;
    for (let i = 0; i < 100; i++) { detail = (await call(`/api/app-builder/builds/${drafted.json.id}`)).json; if (detail.status !== 'building') break; await new Promise(r => setTimeout(r, 100)); }
    assert.ok(['failed', 'needs-attention'].includes(detail.status), detail.status);
    assert.ok(detail.error, 'the reason is reported');
    assert.equal((await call(`/api/app-builder/builds/${drafted.json.id}/start`, {})).status, 409);
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
