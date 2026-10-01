'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const factory = require('../lib/neuron-factory');

function memoryStore() {
  const state = new Map();
  return { all(name){return [...(state.get(name)?.values()||[])];}, get(name,id){return state.get(name)?.get(id)||null;}, put(name,row){if(!state.has(name))state.set(name,new Map());state.get(name).set(row.id,row);return row;} };
}

test('micro tensor factory trains a purpose-bound dense tensor artifact', () => {
  const store = memoryStore();
  const blueprint = factory.createBlueprint(store, {
    name:'AND gate tensor', purpose:'Detect when both bounded input signals are active.', kind:'tensor', scale:'micro',
    config:{inputSize:2,hiddenSize:4,outputSize:1,epochs:250,learningRate:0.08,seed:7},
    examples:[{input:[0,0],target:[0]},{input:[0,1],target:[0]},{input:[1,0],target:[0]},{input:[1,1],target:[1]}],
  });
  assert.equal(blueprint.status,'ready');
  const result = factory.trainBlueprint(store, blueprint.id);
  assert.equal(result.artifact.kind,'tensor');
  assert.equal(result.artifact.engine,'dense-tensor-backprop-v1');
  assert.ok(result.artifact.metrics.finalLoss < 0.08);
  assert.equal(result.blueprint.status,'trained');
});

test('macro work requires one explicit approval and consumes it on training', () => {
  const store = memoryStore();
  const blueprint = factory.createBlueprint(store, {
    purpose:'Train a broader routing tensor for a reviewed macro workload.', kind:'tensor', scale:'macro',
    config:{inputSize:1,hiddenSize:2,outputSize:1,epochs:20}, examples:[{input:[0],target:[0]},{input:[1],target:[1]}],
  });
  assert.equal(blueprint.status,'awaiting-approval');
  assert.throws(()=>factory.trainBlueprint(store,blueprint.id),/not ready/);
  factory.approveBlueprint(store,blueprint.id);
  const result=factory.trainBlueprint(store,blueprint.id);
  assert.ok(result.blueprint.approval.consumedAt);
  assert.throws(()=>factory.approveBlueprint(store,blueprint.id),/Only an awaiting/);
});

test('qubit factory trains a state-vector circuit and states the physical boundary', () => {
  const store = memoryStore();
  const blueprint = factory.createBlueprint(store, {
    purpose:'Bias a simulated two-qubit circuit toward the 11 state.', kind:'qubit', scale:'micro',
    config:{qubits:2,layers:2,epochs:80,learningRate:0.3,seed:11}, targetDistribution:[0,0,0,1],
  });
  const result=factory.trainBlueprint(store,blueprint.id);
  assert.equal(result.artifact.simulated,true);
  assert.equal(result.artifact.physicalQubitsCreated,false);
  assert.match(result.artifact.truth,/No physical qubits/);
  assert.ok(result.artifact.distribution[3] > 0.7);
  assert.ok(Math.abs(result.artifact.distribution.reduce((a,b)=>a+b,0)-1)<1e-9);
});

test('factory rejects oversized, malformed and unsupported specifications', () => {
  const store=memoryStore();
  assert.throws(()=>factory.createBlueprint(store,{purpose:'too short',kind:'tensor',scale:'micro',config:{inputSize:1,outputSize:1},examples:[]}),/Purpose|requires/);
  assert.throws(()=>factory.createBlueprint(store,{purpose:'Simulate an unsupported number of local qubits.',kind:'qubit',scale:'micro',config:{qubits:5},targetDistribution:Array(32).fill(1)}),/qubits/);
  assert.throws(()=>factory.createBlueprint(store,{purpose:'Reject a target distribution with invalid probability mass.',kind:'qubit',scale:'micro',config:{qubits:1},targetDistribution:[0,0]}),/positive probability/);
});
