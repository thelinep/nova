const {test}=require('node:test');
const assert=require('node:assert/strict');
const {collectionView,workspaceView,helpersView,DELIVERY_MILESTONES}=require('../lib/roadmap.cjs');

test('roadmap derives collection progress without treating active work as complete',()=>{
 const view=collectionView({totalDistricts:10,uniqueBusinesses:24,runnerState:'running',counts:[{status:'limited_view',count:4},{status:'pending',count:5},{status:'running',count:1}]});
 assert.deepEqual(view,{total:10,completed:4,pending:5,active:1,businesses:24,percent:40,runnerState:'running',pauseReason:null,lastProgressAt:null});
});

test('roadmap separates local drafts, published updates and helper outcomes',()=>{
 const workspace=workspaceView({conversations:[{id:'c1'}],publications:[{status:'draft'},{status:'published'}]});
 assert.equal(workspace.conversations,1);assert.equal(workspace.drafts,1);assert.equal(workspace.published,1);
 const helpers=helpersView({helpers:[{enabled:1},{enabled:0}],runs:[{status:'queued'},{status:'complete'},{status:'failed'}],worker:{heartbeat:'2026-09-11T00:00:00.000Z'}},Date.parse('2026-09-11T00:03:00.000Z'));
 assert.equal(helpers.schedulerAvailable,true);assert.equal(helpers.scheduled,1);assert.equal(helpers.waiting,1);assert.equal(helpers.ready,1);assert.equal(helpers.needsAttention,1);
});

test('delivery milestones preserve planned and in-progress truth labels',()=>{
 assert.ok(DELIVERY_MILESTONES.some(item=>item.status==='planned'&&!item.commit));
 assert.ok(DELIVERY_MILESTONES.some(item=>item.status==='in_progress'));
 assert.ok(DELIVERY_MILESTONES.filter(item=>item.status==='complete').every(item=>item.commit));
});
