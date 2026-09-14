'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const security=require('../lib/desktop-security');
const {STORE_NAMES}=require('../lib/db');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){return stores.get(name)?.get(id)||null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,row);return row;},clear(name){stores.set(name,new Map());}};}

test('audit records are encrypted at rest and form a verified hash chain',()=>{const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-security-'));security.appendAudit(dataDir,{action:'permission.granted',secretMarker:'must-not-be-plaintext'});security.appendAudit(dataDir,{action:'backup.created'});const raw=fs.readFileSync(path.join(dataDir,'security','audit.ndjson.enc'),'utf8');assert.doesNotMatch(raw,/must-not-be-plaintext|permission\.granted/);const records=security.readAudit(dataDir);assert.equal(records.length,2);assert.equal(records[1].previousHash,records[0].recordHash);assert.equal(fs.statSync(path.join(dataDir,'security','audit.key')).mode&0o777,0o600);});

test('encrypted backup restores stores and retains a pre-restore safety backup',()=>{const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-backup-')),store=memoryStore();store.put('preferences',{id:'prefs',theme:'dark'});const backup=security.createBackup(store,dataDir,'Known state');const raw=fs.readFileSync(backup.path,'utf8');assert.doesNotMatch(raw,/"theme":"dark"/);store.put('preferences',{id:'prefs',theme:'light'});const restored=security.restoreBackup(store,dataDir,backup.id);assert.equal(store.get('preferences','prefs').theme,'dark');assert.ok(store.get('securityBackups',restored.safetyBackupId));assert.equal(restored.stores,STORE_NAMES.length);});

test('permission registry pins exact paths and denies traversal identifiers',()=>{const store=memoryStore(),record=security.recordPermission(store,{rootId:'root_1',path:'/tmp/repo',capabilities:['filesystem:read'],source:'test'});assert.equal(record.exactPath,'/tmp/repo');assert.equal(record.symlinkPolicy,'deny');assert.equal(record.pathTraversalPolicy,'deny');assert.throws(()=>security.safeId('../backup'),/Invalid local security record identifier/);});
