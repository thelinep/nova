'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const OUTPUT_LIMIT = 256 * 1024;
const active = new Map();
const ACTIONS = new Set(['test','format','build','git-status','diagnostics']);
function error(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
function id(){return 'run_'+crypto.randomBytes(8).toString('hex');}
function gitRoot(rootPath){return fs.realpathSync.native(require('node:child_process').execFileSync('git',['rev-parse','--show-toplevel'],{cwd:rootPath,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim());}

function allowRepository(store,scanner,rootId,actions){
  const root=scanner.approvedRoot(store,rootId);
  let top;try{top=gitRoot(root.path);}catch(_){throw error('Controlled commands require a Git repository root.',409);}
  if(top!==root.path)throw error('Approve the repository root before allowing commands.',409);
  const allowed=[...new Set((actions||[]).filter(action=>ACTIONS.has(action)))];
  if(!allowed.length)throw error('Select at least one controlled command.');
  root.commandAllowlist={actions:allowed,approvedAt:new Date().toISOString(),repositoryPath:top};store.put('workspaceRoots',root);return root;
}

function commandFor(action,cwd){
  const packagePath=path.join(cwd,'package.json'),cargoPath=path.join(cwd,'Cargo.toml');
  if(action==='git-status')return{file:'git',args:['status','--short','--branch'],timeoutMs:10000,readOnly:true};
  if(action==='diagnostics')return{file:'git',args:['diff','--check'],timeoutMs:15000,readOnly:true};
  if(fs.existsSync(packagePath)){
    const scripts=JSON.parse(fs.readFileSync(packagePath,'utf8')).scripts||{};
    const script=action==='format'?(scripts['format:check']?'format:check':scripts.format?action:null):scripts[action]?action:null;
    if(!script)throw error(`No controlled ${action} script is declared in package.json.`,409);
    return{file:'npm',args:['run',script],timeoutMs:action==='build'?180000:action==='test'?120000:60000,readOnly:false};
  }
  if(fs.existsSync(cargoPath)){
    if(action==='test')return{file:'cargo',args:['test'],timeoutMs:120000,readOnly:false};
    if(action==='format')return{file:'cargo',args:['fmt','--','--check'],timeoutMs:60000,readOnly:true};
    if(action==='build')return{file:'cargo',args:['build'],timeoutMs:180000,readOnly:false};
  }
  throw error(`No supported controlled ${action} command was found.`,409);
}

function capture(file,args,options){
  return new Promise(resolve=>{let output='',truncated=false,timedOut=false,settled=false;
    const allowedEnv=['PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT','WINDIR'].reduce((env,key)=>{if(process.env[key])env[key]=process.env[key];return env;},{});
    const child=spawn(file,args,{cwd:options.cwd,env:{...allowedEnv,CI:'1',NO_COLOR:'1',HOME:options.homeDir,npm_config_cache:options.cacheDir,CARGO_HOME:options.cacheDir},shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    options.onStart?.(child);
    const append=chunk=>{if(output.length>=OUTPUT_LIMIT){truncated=true;return;}const text=chunk.toString();const room=OUTPUT_LIMIT-output.length;output+=text.slice(0,room);if(text.length>room)truncated=true;};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const terminate=signal=>{try{process.platform==='win32'?child.kill(signal):process.kill(-child.pid,signal);}catch(_){}};
    const timer=setTimeout(()=>{timedOut=true;terminate('SIGTERM');setTimeout(()=>terminate('SIGKILL'),1000).unref();},options.timeoutMs);
    const done=(code,signal,spawnError)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code:spawnError?null:code,signal,output,truncated,timedOut,error:spawnError?.message||null});};
    child.on('error',e=>done(null,null,e));child.on('close',(code,signal)=>done(code,signal,null));
  });
}

async function run(store,scanner,workspaceChanges,dataDir,input){
  const root=scanner.approvedRoot(store,input.rootId),action=String(input.action||'');
  if(!ACTIONS.has(action))throw error('Unknown controlled command.');
  if(root.commandAllowlist?.repositoryPath!==root.path||!root.commandAllowlist.actions.includes(action))throw error('This command is not allowlisted for the repository.',403);
  if(active.has(root.id))throw error('Another command is already active for this workspace.',409);
  const runId=id(),startedAt=new Date().toISOString(),record={id:runId,type:'workspace-command',rootId:root.id,repositoryPath:root.path,action,status:'running',startedAt,finishedAt:null,output:'',outputLimitBytes:OUTPUT_LIMIT,truncated:false,timedOut:false,cancelRequested:false,workspaceCopy:null,isolation:{minimalEnvironment:true,processGroup:true,networkPolicy:'inherited-local-host-policy',dependencyCache:'dedicated per NOVA data directory'}};
  store.put('workspaceRuns',record);active.set(root.id,runId);
  try{
    let cwd=root.path,definition=commandFor(action,root.path);
    if(!definition.readOnly){cwd=path.join(dataDir,'execution-workspaces',runId);record.workspaceCopy={path:cwd,...workspaceChanges.copyWorkspace(scanner,root.path,cwd)};definition=commandFor(action,cwd);}
    record.command={executable:definition.file,args:definition.args,timeoutMs:definition.timeoutMs,cwd};store.put('workspaceRuns',record);
    const homeDir=path.join(dataDir,'execution-home',runId),cacheDir=path.join(dataDir,'dependency-cache');fs.mkdirSync(homeDir,{recursive:true});fs.mkdirSync(cacheDir,{recursive:true});
    const result=await capture(definition.file,definition.args,{cwd,timeoutMs:definition.timeoutMs,homeDir,cacheDir,onStart:child=>active.set(root.id,{runId,child})});
    const latest=store.get('workspaceRuns',runId)||record;Object.assign(record,result,{cancelRequested:latest.cancelRequested,status:latest.cancelRequested?'cancelled':result.code===0&&!result.timedOut?'passed':result.timedOut?'timed-out':'failed',finishedAt:new Date().toISOString()});store.put('workspaceRuns',record);return record;
  } finally { active.delete(root.id); }
}

function cancel(store,id){const record=store.get('workspaceRuns',id);if(!record)throw error('Unknown workspace run.',404);if(record.status!=='running')throw error('Only an active run can be cancelled.',409);const entry=active.get(record.rootId);if(!entry||entry.runId!==id)throw error('The active process is no longer available; restart recovery will reconcile it.',409);record.cancelRequested=true;record.cancelRequestedAt=new Date().toISOString();store.put('workspaceRuns',record);try{process.platform==='win32'?entry.child.kill('SIGTERM'):process.kill(-entry.child.pid,'SIGTERM');}catch(_){}return record;}

function recoverInterrupted(store){let count=0;for(const record of store.all('workspaceRuns'))if(record.status==='running'){record.status='interrupted';record.finishedAt=new Date().toISOString();record.recovery={reason:'NOVA restarted while the command was active.',resumable:false};store.put('workspaceRuns',record);count++;}return count;}

module.exports={allowRepository,run,cancel,recoverInterrupted,commandFor,capture,constants:{OUTPUT_LIMIT,ACTIONS},_active:active};
