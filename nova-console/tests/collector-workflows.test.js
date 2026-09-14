'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const collector=require('../lib/collector-workflows');
function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){return stores.get(name)?.get(id)||null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row;}};}

test('collector creates a bounded Delhi plan and requires approval',()=>{
  const store=memoryStore();
  assert.throws(()=>collector.createPlan(store,{geography:'Mumbai',categories:['banquet halls']}),/Only the configured Delhi/);
  assert.throws(()=>collector.createPlan(store,{geography:'Delhi',categories:['unknown']}),/approved venue categories/);
  const plan=collector.createPlan(store,{geography:'Delhi',categories:['banquet halls','banquet halls','party halls']});
  assert.deepEqual(plan.categories,['banquet halls','party halls']);assert.equal(plan.queryCount,26);assert.equal(plan.status,'awaiting_approval');
  assert.throws(()=>collector.executePlan(store,plan.id),/Approve/);
  assert.equal(collector.approvePlan(store,plan.id).status,'approved');
});

test('collector recovery pauses interrupted runs with a resumable checkpoint note',()=>{
  const store=memoryStore();store.put('collectionRuns',{id:'run_1',status:'running',checkpoints:[]});store.put('collectionRuns',{id:'run_2',status:'completed',checkpoints:[]});
  assert.equal(collector.recoverInterrupted(store),1);
  const recovered=store.get('collectionRuns','run_1');assert.equal(recovered.status,'paused');assert.match(recovered.checkpoints[0].detail,/checkpoint will be reused/);
  assert.equal(store.get('collectionRuns','run_2').status,'completed');
});

test('inactive collector runs cannot be cancelled',()=>{
  const store=memoryStore();store.put('collectionRuns',{id:'run_1',status:'paused',checkpoints:[]});
  assert.throws(()=>collector.cancelRun(store,'missing'),/Unknown collection run/);
  assert.throws(()=>collector.cancelRun(store,'run_1'),/not active/);
});
