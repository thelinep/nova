'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const scanner = require('../lib/workspace-scanner');
const projects = require('../lib/workspace-projects');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){return stores.get(name)?.get(id)||null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row;}};}
function parent(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-projects-'));const store=memoryStore();return{dir:fs.realpathSync(dir),store,root:scanner.approveRoot(store,{path:dir})};}
function withGitConfig(content,fn){
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'nova-gitcfg-')),'gitconfig');fs.writeFileSync(file,content);
  const previous=process.env.GIT_CONFIG_GLOBAL;process.env.GIT_CONFIG_GLOBAL=file;
  try{return fn();}finally{if(previous===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=previous;}
}
const IDENTITY='[user]\n\tname = Nova Test\n\temail = nova@example.invalid\n';

for (const template of projects.listTemplates().map(t => t.id)) {
  test(`${template} template creates a git repo whose own tests pass`, () => {
    const p=parent();
    const draft=projects.draftProject(p.store,scanner,{parentRootId:p.root.id,name:'demo-'+template,template});
    assert.equal(draft.status,'draft');
    assert.ok(!fs.existsSync(draft.targetPath),'drafting writes nothing');
    const created=withGitConfig(IDENTITY,()=>projects.createProject(p.store,scanner,draft.id));
    assert.equal(created.status,'created');
    assert.match(created.created.commit,/^[0-9a-f]{40}$/);
    const dir=created.created.path;
    for(const file of draft.files)assert.ok(fs.existsSync(path.join(dir,file.relativePath)),file.relativePath);
    assert.equal(execFileSync('git',['branch','--show-current'],{cwd:dir,encoding:'utf8'}).trim(),'main');
    assert.equal(execFileSync('git',['status','--porcelain'],{cwd:dir,encoding:'utf8'}).trim(),'','everything is committed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8')).name,'demo-'+template);
    assert.ok(p.store.get('workspaceRoots',created.created.rootId),'new folder is approved as a root');
    assert.deepEqual(fs.readdirSync(p.dir).filter(n=>n.startsWith('.nova-new-')),[],'staging folder is gone');
    const run=spawnSync(process.execPath,['--test'],{cwd:dir,encoding:'utf8',timeout:60000});
    assert.equal(run.status,0,run.stdout+run.stderr);
  });
}

test('without a git identity the repo is initialized but not committed', () => {
  const p=parent();
  const draft=projects.draftProject(p.store,scanner,{parentRootId:p.root.id,name:'no-identity',template:'node-api'});
  const created=withGitConfig('',()=>projects.createProject(p.store,scanner,draft.id));
  assert.equal(created.created.commit,null);
  assert.match(created.created.gitNote,/No initial commit/);
  assert.ok(fs.existsSync(path.join(created.created.path,'.git')));
});

test('names, titles, templates and parents are validated before anything is written', () => {
  const p=parent();
  const draft=input=>()=>projects.draftProject(p.store,scanner,{parentRootId:p.root.id,template:'node-api',...input});
  for(const name of ['','My App','../escape','-dash','a/b','node_modules','x'.repeat(65)])assert.throws(draft({name}),/project name/,name);
  assert.throws(draft({name:'ok',title:'<script>'}),/title/);
  assert.throws(draft({name:'ok',title:"it's"}),/title/);
  assert.throws(draft({name:'ok',template:'php'}),/Unknown project template/);
  fs.mkdirSync(path.join(p.dir,'taken'));
  assert.throws(draft({name:'taken'}),/already exists/);
  assert.throws(()=>projects.draftProject(p.store,scanner,{parentRootId:'root_missing',name:'ok',template:'node-api'}),/approved local root/);
});

test('a destination that appears after drafting stops creation without touching it', () => {
  const p=parent();
  const draft=projects.draftProject(p.store,scanner,{parentRootId:p.root.id,name:'race',template:'static-site'});
  fs.mkdirSync(path.join(p.dir,'race'));fs.writeFileSync(path.join(p.dir,'race','mine.txt'),'mine\n');
  assert.throws(()=>projects.createProject(p.store,scanner,draft.id),/appeared/);
  assert.deepEqual(fs.readdirSync(path.join(p.dir,'race')),['mine.txt']);
  assert.equal(p.store.get('workspaceProjects',draft.id).status,'draft');
});

test('a failure while creating leaves nothing behind, and a draft is single-use', () => {
  const p=parent();
  let draft=projects.draftProject(p.store,scanner,{parentRootId:p.root.id,name:'boom',template:'node-api'});
  const rename=fs.renameSync;fs.renameSync=()=>{throw new Error('injected failure');};
  try{assert.throws(()=>withGitConfig(IDENTITY,()=>projects.createProject(p.store,scanner,draft.id)),/nothing was left behind/);}finally{fs.renameSync=rename;}
  assert.deepEqual(fs.readdirSync(p.dir),[]);
  draft=projects.draftProject(p.store,scanner,{parentRootId:p.root.id,name:'once',template:'node-api'});
  withGitConfig(IDENTITY,()=>projects.createProject(p.store,scanner,draft.id));
  assert.throws(()=>projects.createProject(p.store,scanner,draft.id),/already used/);
});
