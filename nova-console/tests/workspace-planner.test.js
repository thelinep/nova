'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../lib/workspace-scanner');
const { createConversationPlan, runPlan, setPlanRoot } = require('../lib/workspace-planner');

function memoryStore() {
  const stores = new Map();
  return {
    all(name) { return [...(stores.get(name)?.values() || [])]; },
    get(name,id) { return stores.get(name)?.get(id) || null; },
    put(name,row) { if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row; },
  };
}

test('conversation request creates and reuses a visible read-only scan plan', () => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'nova-plan-'));
  fs.mkdirSync(path.join(base,'tests'));
  fs.writeFileSync(path.join(base,'tests','broken.test.js'),'// TODO investigate failure\n');
  const store=memoryStore();
  const root=scanner.approveRoot(store,{path:base,label:'Fixture project'});
  const first=createConversationPlan(store,{request:'find broken tests in Fixture project',sessionId:'s1'});
  assert.equal(first.matched,true);
  assert.equal(first.reused,false);
  assert.equal(first.plan.rootId,root.id);
  assert.deepEqual(first.plan.profiles,['test-status','code-health']);
  assert.equal(first.plan.permissions.write.required,false);
  assert.equal(first.plan.permissions.executeCommands,false);
  assert.match(first.plan.expectedOutput.join(' '),/no test execution/i);
  const second=createConversationPlan(store,{request:'check test status for Fixture project'});
  assert.equal(second.reused,true);
  assert.equal(second.plan.id,first.plan.id);
  const completed=runPlan(store,scanner,first.plan.id);
  assert.equal(completed.plan.status,'completed');
  assert.equal(completed.report.type,'workspace-structured');
});

test('ambiguous folders require selection before a conversation plan can run', () => {
  const store=memoryStore();
  const one=scanner.approveRoot(store,{path:fs.mkdtempSync(path.join(os.tmpdir(),'nova-plan-a-')),label:'One'});
  scanner.approveRoot(store,{path:fs.mkdtempSync(path.join(os.tmpdir(),'nova-plan-b-')),label:'Two'});
  const drafted=createConversationPlan(store,{request:'review this project'});
  assert.equal(drafted.plan.rootSelectionRequired,true);
  assert.throws(()=>runPlan(store,scanner,drafted.plan.id),/Select an approved root/);
  const assigned=setPlanRoot(store,drafted.plan.id,one.id);
  assert.equal(assigned.folders[0].access,'read-only');
});

test('ordinary conversation does not create a workspace plan', () => {
  const store=memoryStore();
  assert.deepEqual(createConversationPlan(store,{request:'Explain quantum mechanics'}),{matched:false});
});
