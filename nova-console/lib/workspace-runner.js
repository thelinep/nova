'use strict';
/* ===========================================================================
 * NOVA Runtime — controlled repository commands
 *
 * Only allowlisted actions run, per approved Git repository root:
 *   test, format, build   run in a bounded copy under NOVA's data folder
 *                         (the project's node_modules is linked in, read-only
 *                         by convention, so installed packages resolve)
 *   git-status, diagnostics   read-only, in the real folder
 *   install               npm ci / npm install in the real folder. Needs
 *                         network, so it only runs while Settings > Privacy >
 *                         "Allow network access" is on. Package lifecycle
 *                         scripts are skipped unless the caller opts in.
 *   dev                   the project's dev (or start) script, long-running,
 *                         in the real folder so edits hot-reload. One per
 *                         workspace, stopped with cancel or when NOVA exits.
 * install and dev run in the background; poll getRun() for live output.
 * ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const OUTPUT_LIMIT = 256 * 1024;
const DEV_MAX_MS = 8 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PERSIST_INTERVAL_MS = 500;
const active = new Map();
const devServers = new Map();
const ACTIONS = new Set(['test','format','build','git-status','diagnostics','install','dev']);
const BACKGROUND_ACTIONS = new Set(['install','dev']);
const NETWORK_ACTIONS = new Set(['install']);
const LOCAL_URL = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}[^\s'"]*)/;

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

function packageScripts(cwd){return JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8')).scripts||{};}

function commandFor(action,cwd,options={}){
  const packagePath=path.join(cwd,'package.json'),cargoPath=path.join(cwd,'Cargo.toml');
  if(action==='git-status')return{file:'git',args:['status','--short','--branch'],timeoutMs:10000,readOnly:true};
  if(action==='diagnostics')return{file:'git',args:['diff','--check'],timeoutMs:15000,readOnly:true};
  if(fs.existsSync(packagePath)){
    if(action==='install'){
      const locked=fs.existsSync(path.join(cwd,'package-lock.json'));
      const args=[locked?'ci':'install','--no-audit','--no-fund'];
      if(!options.allowScripts)args.push('--ignore-scripts');
      return{file:'npm',args,timeoutMs:INSTALL_TIMEOUT_MS,readOnly:false,inPlace:true,network:true};
    }
    const scripts=packageScripts(cwd);
    if(action==='dev'){
      const script=scripts.dev?'dev':scripts.start?'start':null;
      if(!script)throw error('No dev or start script is declared in package.json.',409);
      return{file:'npm',args:['run',script],timeoutMs:DEV_MAX_MS,readOnly:false,inPlace:true,longRunning:true};
    }
    const script=action==='format'?(scripts['format:check']?'format:check':scripts.format?action:null):scripts[action]?action:null;
    if(!script)throw error(`No controlled ${action} script is declared in package.json.`,409);
    return{file:'npm',args:['run',script],timeoutMs:action==='build'?180000:action==='test'?120000:60000,readOnly:false};
  }
  if(fs.existsSync(cargoPath)){
    if(action==='test')return{file:'cargo',args:['test'],timeoutMs:120000,readOnly:false};
    if(action==='format')return{file:'cargo',args:['fmt','--','--check'],timeoutMs:60000,readOnly:true};
    if(action==='build')return{file:'cargo',args:['build'],timeoutMs:180000,readOnly:false};
    if(action==='dev')return{file:'cargo',args:['run'],timeoutMs:DEV_MAX_MS,readOnly:false,inPlace:true,longRunning:true};
  }
  throw error(`No supported controlled ${action} command was found.`,409);
}

/** Runs a command with a minimal environment in its own process group.
 *  options.keepTail keeps the newest output instead of the oldest (for
 *  long-running servers); options.onOutput is called after each chunk. */
function capture(file,args,options){
  return new Promise(resolve=>{let output='',dropped=0,truncated=false,timedOut=false,settled=false;
    const passthrough=['PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT','WINDIR',...(options.network?['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']:[])];
    const allowedEnv=passthrough.reduce((env,key)=>{if(process.env[key])env[key]=process.env[key];return env;},{});
    const child=spawn(file,args,{cwd:options.cwd,env:{...allowedEnv,CI:'1',NO_COLOR:'1',HOME:options.homeDir,npm_config_cache:options.cacheDir,CARGO_HOME:options.cacheDir,...(options.extraEnv||{})},shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    options.onStart?.(child);
    const append=chunk=>{const text=chunk.toString();
      if(options.keepTail){output+=text;if(output.length>OUTPUT_LIMIT){const excess=output.length-OUTPUT_LIMIT;output=output.slice(excess);dropped+=excess;truncated=true;}}
      else{if(output.length>=OUTPUT_LIMIT){truncated=true;return;}const room=OUTPUT_LIMIT-output.length;output+=text.slice(0,room);if(text.length>room)truncated=true;}
      options.onOutput?.(output,dropped);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const terminate=signal=>{try{process.platform==='win32'?child.kill(signal):process.kill(-child.pid,signal);}catch(_){}};
    const timer=setTimeout(()=>{timedOut=true;terminate('SIGTERM');setTimeout(()=>terminate('SIGKILL'),1000).unref();},options.timeoutMs);
    const done=(code,signal,spawnError)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code:spawnError?null:code,signal,output,outputStart:dropped,truncated,timedOut,error:spawnError?.message||null});};
    child.on('error',e=>done(null,null,e));child.on('close',(code,signal)=>done(code,signal,null));
  });
}

function linkDependencies(rootPath,copyPath){
  const modules=path.join(rootPath,'node_modules');
  if(!fs.existsSync(modules)||fs.existsSync(path.join(copyPath,'node_modules')))return false;
  fs.symlinkSync(modules,path.join(copyPath,'node_modules'),'dir');return true;
}

function finalStatus(definition,latest,result){
  if(latest.cancelRequested)return definition.longRunning?'stopped':'cancelled';
  if(result.timedOut)return 'timed-out';
  if(result.code===0)return definition.longRunning?'exited':'passed';
  return 'failed';
}

async function run(store,scanner,workspaceChanges,dataDir,input){
  const root=scanner.approvedRoot(store,input.rootId),action=String(input.action||'');
  if(!ACTIONS.has(action))throw error('Unknown controlled command.');
  if(root.commandAllowlist?.repositoryPath!==root.path||!root.commandAllowlist.actions.includes(action))throw error('This command is not allowlisted for the repository.',403);
  if(NETWORK_ACTIONS.has(action)&&!store.get('preferences','default')?.webAccess)throw error('Installing packages needs network access, and this workspace is LOCAL ONLY. Turn on Settings > Privacy > "Allow network access", then try again.',403);
  const isDev=action==='dev';
  if(isDev&&devServers.has(root.id))throw error('A dev server is already running for this workspace. Stop it first.',409);
  if(!isDev&&active.has(root.id))throw error('Another command is already active for this workspace.',409);
  if(action==='install'&&devServers.has(root.id))throw error('Stop the dev server before installing packages.',409);
  if(isDev&&active.get(root.id)?.action==='install')throw error('Wait for the package install to finish before starting the dev server.',409);
  const allowScripts=action==='install'&&input.allowScripts===true;
  let definition=commandFor(action,root.path,{allowScripts});
  const runId=id(),startedAt=new Date().toISOString();
  const record={id:runId,type:'workspace-command',rootId:root.id,repositoryPath:root.path,action,status:'running',startedAt,finishedAt:null,output:'',outputStart:0,outputLimitBytes:OUTPUT_LIMIT,truncated:false,timedOut:false,cancelRequested:false,workspaceCopy:null,url:null,
    isolation:{minimalEnvironment:true,processGroup:true,location:definition.readOnly||definition.inPlace?'approved folder':'workspace copy',networkPolicy:definition.network?'package registry access (network preference on)':'inherited-local-host-policy',lifecycleScripts:action==='install'?(allowScripts?'allowed by explicit request':'skipped (--ignore-scripts)'):undefined,dependencyCache:'dedicated per NOVA data directory'}};
  store.put('workspaceRuns',record);
  const registry=isDev?devServers:active;
  registry.set(root.id,{runId,action});
  const execute=async()=>{
    try{
      let cwd=root.path;
      if(!definition.readOnly&&!definition.inPlace){
        cwd=path.join(dataDir,'execution-workspaces',runId);
        record.workspaceCopy={path:cwd,...workspaceChanges.copyWorkspace(scanner,root.path,cwd)};
        record.workspaceCopy.linkedDependencies=linkDependencies(root.path,cwd);
        definition=commandFor(action,cwd);
      }
      record.command={executable:definition.file,args:definition.args,timeoutMs:definition.timeoutMs,cwd};store.put('workspaceRuns',record);
      const homeDir=path.join(dataDir,'execution-home',runId),cacheDir=path.join(dataDir,'dependency-cache');fs.mkdirSync(homeDir,{recursive:true});fs.mkdirSync(cacheDir,{recursive:true});
      const port=Number(input.port);
      const extraEnv=isDev?{HOST:'127.0.0.1',HOSTNAME:'127.0.0.1',BROWSER:'none',NEXT_TELEMETRY_DISABLED:'1',...(Number.isInteger(port)&&port>=1024&&port<=65535?{PORT:String(port)}:{})}:{};
      let lastPersist=0,pendingPersist=null;
      const persist=()=>{pendingPersist=null;lastPersist=Date.now();const latest=store.get('workspaceRuns',runId);if(latest){if(latest.status!=='running')return;record.cancelRequested=latest.cancelRequested;}store.put('workspaceRuns',record);};
      const result=await capture(definition.file,definition.args,{cwd,timeoutMs:definition.timeoutMs,homeDir,cacheDir,network:definition.network,keepTail:definition.longRunning,extraEnv,
        onStart:child=>registry.set(root.id,{runId,action,child}),
        onOutput:(output,dropped)=>{record.output=output;record.outputStart=dropped;let urlFound=false;if(!record.url){const match=output.match(LOCAL_URL);if(match){record.url=match[1].replace(/[),.;]+$/,'');urlFound=true;}}
          // Persist at most every PERSIST_INTERVAL_MS, but always flush the last chunk so quiet servers show their latest output.
          const wait=PERSIST_INTERVAL_MS-(Date.now()-lastPersist);
          if(urlFound||wait<=0){if(pendingPersist){clearTimeout(pendingPersist);}persist();}
          else if(!pendingPersist)pendingPersist=setTimeout(persist,wait);}});
      if(pendingPersist)clearTimeout(pendingPersist);
      const latest=store.get('workspaceRuns',runId)||record;
      Object.assign(record,result,{cancelRequested:latest.cancelRequested,cancelRequestedAt:latest.cancelRequestedAt,status:finalStatus(definition,latest,result),finishedAt:new Date().toISOString()});
      store.put('workspaceRuns',record);return record;
    }catch(cause){
      Object.assign(record,{status:'failed',finishedAt:new Date().toISOString(),error:cause.message||String(cause)});store.put('workspaceRuns',record);
      if(BACKGROUND_ACTIONS.has(action))return record;throw cause;
    }finally{registry.delete(root.id);}
  };
  if(BACKGROUND_ACTIONS.has(action)&&input.wait!==true){execute();return record;}
  return execute();
}

function entryFor(record){
  const entry=(record.action==='dev'?devServers:active).get(record.rootId);
  return entry&&entry.runId===record.id?entry:null;
}

function cancel(store,id){const record=store.get('workspaceRuns',id);if(!record)throw error('Unknown workspace run.',404);if(record.status!=='running')throw error('Only an active run can be cancelled.',409);const entry=entryFor(record);if(!entry||!entry.child)throw error('The active process is no longer available; restart recovery will reconcile it.',409);record.cancelRequested=true;record.cancelRequestedAt=new Date().toISOString();store.put('workspaceRuns',record);try{process.platform==='win32'?entry.child.kill('SIGTERM'):process.kill(-entry.child.pid,'SIGTERM');}catch(_){}setTimeout(()=>{try{process.platform==='win32'?entry.child.kill('SIGKILL'):process.kill(-entry.child.pid,'SIGKILL');}catch(_){}},3000).unref();return record;}

/** A run with output after `since` characters (for polling live logs). */
function getRun(store,id,since){
  const record=store.get('workspaceRuns',id);if(!record)throw error('Unknown workspace run.',404);
  const start=record.outputStart||0,total=start+String(record.output||'').length;
  const from=Math.max(0,Math.min(total,Number(since)||0)-start);
  return {...record,output:String(record.output||'').slice(from),outputFrom:start+from,outputTotal:total};
}

/** Terminates every command and dev server NOVA started (on shutdown). */
function stopAll(){
  for(const entry of [...active.values(),...devServers.values()]){if(!entry.child)continue;try{process.platform==='win32'?entry.child.kill('SIGTERM'):process.kill(-entry.child.pid,'SIGTERM');}catch(_){}}
}

function recoverInterrupted(store){let count=0;for(const record of store.all('workspaceRuns'))if(record.status==='running'){record.status='interrupted';record.finishedAt=new Date().toISOString();record.recovery={reason:'NOVA restarted while the command was active.',resumable:false};store.put('workspaceRuns',record);count++;}return count;}

module.exports={allowRepository,run,cancel,getRun,stopAll,recoverInterrupted,commandFor,capture,constants:{OUTPUT_LIMIT,ACTIONS,DEV_MAX_MS,INSTALL_TIMEOUT_MS},_active:active,_devServers:devServers};
