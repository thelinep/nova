'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const scanner=require('../lib/workspace-scanner');
const git=require('../lib/workspace-git');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){return stores.get(name)?.get(id)||null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row;}};}
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nova-git-root-')),run=args=>execFileSync('git',args,{cwd:root});run(['init','-q']);run(['config','user.name','NOVA Test']);run(['config','user.email','nova@example.invalid']);fs.writeFileSync(path.join(root,'a.txt'),'before\n');fs.writeFileSync(path.join(root,'b.txt'),'stable\n');run(['add','a.txt','b.txt']);run(['commit','-qm','initial']);return{root,run};}

test('git snapshot shows branches, changes, diffs and persisted test evidence',()=>{const f=fixture(),store=memoryStore(),root=scanner.approveRoot(store,{path:f.root});store.put('workspaceRuns',{id:'test_1',rootId:root.id,action:'test',status:'passed',finishedAt:new Date().toISOString()});fs.writeFileSync(path.join(f.root,'a.txt'),'after\n');const view=git.snapshot(store,scanner,root.id);assert.equal(view.status[0].path,'a.txt');assert.match(view.workingDiff,/-before/);assert.ok(view.branches.some(branch=>branch.current));assert.equal(view.testEvidence[0].status,'passed');});

test('commit drafts require review of the unchanged exact staged snapshot',()=>{const f=fixture(),store=memoryStore(),root=scanner.approveRoot(store,{path:f.root});fs.writeFileSync(path.join(f.root,'a.txt'),'after\n');assert.throws(()=>git.createDraft(store,scanner,{rootId:root.id,files:['../outside'],message:'bad'}),/Only exact changed paths/);const draft=git.createDraft(store,scanner,{rootId:root.id,files:['a.txt'],message:'Update a'});assert.equal(draft.status,'awaiting-review');assert.deepEqual(draft.stagedFiles,['a.txt']);assert.throws(()=>git.commitDraft(store,scanner,draft.id),/Review the exact staged files/);git.reviewDraft(store,scanner,draft.id);fs.writeFileSync(path.join(f.root,'a.txt'),'changed again\n');f.run(['add','a.txt']);assert.throws(()=>git.commitDraft(store,scanner,draft.id),/changed after review/);});

test('reviewed exact staged files can produce one recorded commit',()=>{const f=fixture(),store=memoryStore(),root=scanner.approveRoot(store,{path:f.root});fs.writeFileSync(path.join(f.root,'a.txt'),'after\n');const draft=git.createDraft(store,scanner,{rootId:root.id,files:['a.txt'],message:'Update a'});git.reviewDraft(store,scanner,draft.id);const committed=git.commitDraft(store,scanner,draft.id);assert.equal(committed.status,'committed');assert.deepEqual(committed.commit.files,['a.txt']);assert.equal(f.run(['show','--format=','--name-only','HEAD']).toString().trim(),'a.txt');});
