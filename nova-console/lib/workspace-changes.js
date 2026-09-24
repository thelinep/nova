'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_COPY_BYTES = 100 * 1024 * 1024;

function error(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function idFor(value){return 'change_'+hash(value).slice(0,16);}

function targetFile(scanner,store,rootId,relativePath){
  const root=scanner.approvedRoot(store,rootId);
  if(typeof relativePath!=='string'||!relativePath.trim())throw error('A relative file path is required.');
  if(path.isAbsolute(relativePath))throw error('Use a path relative to the approved root.');
  const candidate=path.resolve(root.path,relativePath.trim());
  if(candidate===root.path||!candidate.startsWith(root.path+path.sep))throw error('Target path leaves the approved root.',403);
  let resolved;
  try { resolved=fs.realpathSync.native(candidate); } catch(e){throw error('Target file is unavailable: '+e.message,404);}
  if(resolved!==candidate||fs.lstatSync(candidate).isSymbolicLink())throw error('Symbolic-link targets cannot be changed.',403);
  const stat=fs.statSync(candidate);
  if(!stat.isFile())throw error('Target must be a file.');
  if(stat.size>MAX_EDIT_BYTES)throw error('Target exceeds the 1 MiB patch limit.',413);
  const content=fs.readFileSync(candidate);
  if(content.includes(0))throw error('Binary files cannot be patched.');
  return {root,path:candidate,relativePath:path.relative(root.path,candidate),content:content.toString('utf8')};
}

function unifiedDiff(relativePath,before,after){
  const a=before.split(/\r?\n/),b=after.split(/\r?\n/);let prefix=0;
  while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  let suffix=0;while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
  const contextStart=Math.max(0,prefix-3),aEnd=Math.min(a.length,a.length-suffix+3),bEnd=Math.min(b.length,b.length-suffix+3);
  const lines=[`--- a/${relativePath}`,`+++ b/${relativePath}`,`@@ -${contextStart+1},${aEnd-contextStart} +${contextStart+1},${bEnd-contextStart} @@`];
  for(let i=contextStart;i<prefix;i++)lines.push(' '+a[i]);
  for(let i=prefix;i<a.length-suffix;i++)lines.push('-'+a[i]);
  for(let i=prefix;i<b.length-suffix;i++)lines.push('+'+b[i]);
  for(let i=Math.max(prefix,a.length-suffix);i<aEnd;i++)lines.push(' '+a[i]);
  return lines.join('\n');
}

function proposeChange(store,scanner,input){
  const target=targetFile(scanner,store,input.rootId,input.relativePath);
  const find=String(input.find??''),replacement=String(input.replacement??'');
  if(!find)throw error('The exact text to replace is required.');
  const occurrences=target.content.split(find).length-1;
  if(occurrences!==1)throw error(occurrences===0?'The exact text was not found in the current file.':'The exact text occurs more than once; provide a more specific selection.');
  const proposed=target.content.replace(find,replacement),now=new Date().toISOString();
  const proposal={id:idFor(target.root.id+'|'+target.relativePath+'|'+now),type:'workspace-change-proposal',status:'draft',rootId:target.root.id,rootPath:target.root.path,relativePath:target.relativePath,sourcePath:target.path,sourceSha256:hash(target.content),proposedSha256:hash(proposed),createdAt:now,updatedAt:now,diff:unifiedDiff(target.relativePath,target.content,proposed),edit:{find,replacement},impact:String(input.impact||`Replace one exact text region in ${target.relativePath}; ${find.length} characters become ${replacement.length} characters.`).trim().slice(0,1000),permissions:{approvedRootRead:true,originalWorkspaceWrite:false,workspaceCopyWrite:true,commandExecution:'parser checks only',network:false},checks:[],copy:null,approval:null,execution:null,rollback:null};
  store.put('workspaceChanges',proposal);return proposal;
}

function proposedContent(proposal,current){
  if(proposal.edit&&typeof proposal.edit.find==='string'){
    if(current.split(proposal.edit.find).length-1!==1)throw error('The stored patch no longer applies cleanly.',409);
    return current.replace(proposal.edit.find,proposal.edit.replacement);
  }
  const removed=proposal.diff.split('\n').filter(line=>line.startsWith('-')&&!line.startsWith('---')).map(line=>line.slice(1)).join('\n');
  const added=proposal.diff.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).map(line=>line.slice(1)).join('\n');
  if(!current.includes(removed))throw error('The stored patch no longer applies cleanly.',409);
  return current.replace(removed,added);
}

function copyWorkspace(scanner,rootPath,destination){
  const walked=scanner.walkFiles(rootPath,{}),total=walked.files.reduce((n,file)=>n+file.size,0);
  if(walked.truncated)throw error('Workspace copy refused because the file scan reached its cap.',413);
  if(total>MAX_COPY_BYTES)throw error('Workspace copy exceeds the 100 MiB safety limit.',413);
  fs.mkdirSync(destination,{recursive:true});
  for(const file of walked.files){const out=path.join(destination,file.relativePath);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(file.path,out);}
  return {files:walked.files.length,bytes:total,excluded:walked.skipped.length};
}

function runAcceptanceChecks(subject,copyPath){
  const criteria=subject.acceptanceChecks||[],ordered=subject.orderedFiles||[subject.relativePath],results=[];
  for(const criterion of criteria){
    let status='passed',detail='Acceptance criterion satisfied in the isolated workspace copy.';
    if(criterion.type==='model-criterion'){
      status='manual-review';detail='Model-proposed behavioral criterion is recorded but cannot be proven by a deterministic file check.';
    }else if(criterion.type==='missing-target'){
      status='failed';detail='The generated plan omitted a file explicitly named in the request.';
    }else if(criterion.type==='target-changed'){
      if(!ordered.includes(criterion.relativePath)){status='failed';detail='The requested target is absent from the proposed change set.';}
    }else if(criterion.type==='dependency-before'){
      const dependencyIndex=ordered.indexOf(criterion.dependency),targetIndex=ordered.indexOf(criterion.relativePath);
      if(dependencyIndex<0||targetIndex<0||dependencyIndex>=targetIndex){status='failed';detail='The required dependency order is not satisfied.';}
    }else if(criterion.type==='replacement-present'||criterion.type==='source-removed'){
      let content='';try{content=fs.readFileSync(path.join(copyPath,criterion.relativePath),'utf8');}catch(e){status='failed';detail='Acceptance target is unavailable in the isolated copy: '+e.message;}
      if(status==='passed'&&criterion.type==='replacement-present'&&!content.includes(criterion.text)){status='failed';detail='The expected replacement is absent from the isolated copy.';}
      if(status==='passed'&&criterion.type==='source-removed'&&content.includes(criterion.text)){status='failed';detail='The replaced source fragment remains in the isolated copy.';}
    }else if(criterion.type==='file-exists'||criterion.type==='file-absent'){
      const present=fs.existsSync(path.join(copyPath,criterion.relativePath));
      if(criterion.type==='file-exists'&&!present){status='failed';detail='The expected file is missing from the isolated copy.';}
      if(criterion.type==='file-absent'&&present){status='failed';detail='The file is still present in the isolated copy.';}
    }else{status='failed';detail='Unknown acceptance-check type.';}
    results.push({name:'Acceptance: '+criterion.description,status,detail,type:criterion.type});
  }
  return results;
}

function checkProposal(store,scanner,dataDir,id){
  const proposal=store.get('workspaceChanges',id);if(!proposal)throw error('Unknown change proposal: '+id,404);
  const target=targetFile(scanner,store,proposal.rootId,proposal.relativePath);
  if(hash(target.content)!==proposal.sourceSha256)throw error('The source file changed after this proposal was created. Create a fresh proposal.',409);
  const proposed=proposedContent(proposal,target.content);
  const copyPath=path.join(dataDir,'workspace-copies',proposal.id);
  const copied=copyWorkspace(scanner,target.root.path,copyPath);
  const copiedTarget=path.join(copyPath,proposal.relativePath);fs.writeFileSync(copiedTarget,proposed,'utf8');
  const checks=[{name:'Source fingerprint',status:'passed',detail:'Current source matches the proposal SHA-256.'},{name:'Patch application',status:'passed',detail:'Patch applied only inside the NOVA workspace copy.'}];
  const ext=path.extname(copiedTarget).toLowerCase();
  if(ext==='.json'){
    try{JSON.parse(proposed);checks.push({name:'JSON parse',status:'passed',detail:'Copied JSON parses successfully.'});}catch(e){checks.push({name:'JSON parse',status:'failed',detail:e.message});}
  } else if(['.js','.cjs','.mjs'].includes(ext)){
    try{execFileSync(process.execPath,['--check',copiedTarget],{cwd:copyPath,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});checks.push({name:'JavaScript syntax',status:'passed',detail:'Node syntax check passed in the workspace copy.'});}catch(e){checks.push({name:'JavaScript syntax',status:'failed',detail:String(e.stderr||e.message).trim().slice(0,500)});}
  } else checks.push({name:'Parser check',status:'not-applicable',detail:'No built-in safe parser is configured for '+(ext||'this file type')+'.'});
  checks.push(...runAcceptanceChecks(proposal,copyPath));
  proposal.semanticValidation={status:checks.some(check=>check.status==='failed')?'failed':checks.some(check=>check.status==='manual-review')?'manual-review-required':'passed',checkedAt:new Date().toISOString(),limitation:'Deterministic checks cover exact file effects. Behavioral criteria marked manual-review require user or executable-test evidence.'};
  proposal.status=checks.some(check=>check.status==='failed')?'checks-failed':'checks-passed';proposal.updatedAt=new Date().toISOString();proposal.checkedAt=proposal.updatedAt;proposal.checks=checks;proposal.copy={path:copyPath,targetPath:copiedTarget,...copied};store.put('workspaceChanges',proposal);return proposal;
}

function approveProposal(store,scanner,id){
  const proposal=store.get('workspaceChanges',id);if(!proposal)throw error('Unknown change proposal: '+id,404);
  if(proposal.status!=='checks-passed')throw error('Safe checks must pass before this write batch can be approved.',409);
  const target=targetFile(scanner,store,proposal.rootId,proposal.relativePath);
  if(hash(target.content)!==proposal.sourceSha256)throw error('The source file changed after validation. Create a fresh proposal.',409);
  const now=new Date().toISOString();
  proposal.status='approved';proposal.updatedAt=now;proposal.approval={id:'approval_'+hash(proposal.id+'|'+now).slice(0,16),decision:'approved',approvedAt:now,affectedFiles:[{relativePath:proposal.relativePath,beforeSha256:proposal.sourceSha256,afterSha256:proposal.proposedSha256}],validationResults:proposal.checks.map(check=>({...check})),scope:'single write batch',consumedAt:null};
  store.put('workspaceChanges',proposal);return proposal;
}

function executeProposal(store,scanner,dataDir,id){
  const proposal=store.get('workspaceChanges',id);if(!proposal)throw error('Unknown change proposal: '+id,404);
  if(proposal.status!=='approved'||!proposal.approval||proposal.approval.decision!=='approved'||proposal.approval.consumedAt)throw error('This write batch needs an unused explicit approval.',409);
  const target=targetFile(scanner,store,proposal.rootId,proposal.relativePath);
  const beforeHash=hash(target.content);if(beforeHash!==proposal.sourceSha256)throw error('The source file changed after approval. The write was stopped.',409);
  const proposed=proposedContent(proposal,target.content);if(hash(proposed)!==proposal.proposedSha256)throw error('Proposed content does not match its approved hash.',409);
  const now=new Date().toISOString(),rollbackPath=path.join(dataDir,'workspace-rollbacks',proposal.id,proposal.relativePath);
  fs.mkdirSync(path.dirname(rollbackPath),{recursive:true});fs.writeFileSync(rollbackPath,target.content,{encoding:'utf8',flag:'wx'});
  const stat=fs.statSync(target.path),temporary=path.join(path.dirname(target.path),`.nova-${proposal.id}-${process.pid}.tmp`);
  try { fs.writeFileSync(temporary,proposed,{encoding:'utf8',mode:stat.mode});fs.renameSync(temporary,target.path); } finally { try{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}catch(_){} }
  const written=fs.readFileSync(target.path,'utf8'),afterHash=hash(written);
  if(afterHash!==proposal.proposedSha256){fs.writeFileSync(target.path,target.content,{encoding:'utf8',mode:stat.mode});throw error('Post-write verification failed; NOVA restored the original file.',500);}
  proposal.status='applied';proposal.updatedAt=now;proposal.appliedAt=now;proposal.approval.consumedAt=now;
  proposal.execution={status:'success',executedAt:now,affectedFiles:[{relativePath:proposal.relativePath,absolutePath:target.path,beforeSha256:beforeHash,afterSha256:afterHash}],validationResults:proposal.checks.map(check=>({...check}))};
  proposal.rollback={available:true,backupPath:rollbackPath,originalSha256:beforeHash,currentSha256:afterHash,instructions:'Create and explicitly approve a separate rollback write batch before restoring this backup.'};
  store.put('workspaceChanges',proposal);return proposal;
}

/* ---------------------------------------------------------------------------
 * Multi-operation change batches
 *
 * A batch holds 1..MAX_BATCH_CHANGES operations, applied atomically:
 *   edit    { relativePath, find, replacement }   one exact region (default)
 *   create  { operation:'create', relativePath, content }   file must not exist
 *   delete  { operation:'delete', relativePath }           file must exist
 *   rename  { operation:'rename', relativePath, toPath }   destination must not exist
 * Every path stays inside the approved root, never passes through a symlink,
 * and never touches generated or VCS folders (.git, node_modules, ...). Each
 * path may appear in only one operation. Preconditions are fingerprinted at
 * draft time and re-verified at check, approval, execution and rollback.
 * ------------------------------------------------------------------------- */
const OPERATIONS=new Set(['edit','create','delete','rename']);
const PROTECTED_SEGMENTS=new Set(['.git','node_modules','target','.next','dist','build','coverage','.cache']);
const MAX_BATCH_CHANGES=50;
const ABSENT='absent';

function operationOf(item){const op=String(item&&item.operation||'edit').toLowerCase();if(!OPERATIONS.has(op))throw error('Unknown change operation: '+op);return op;}

/** Resolves a path that may not exist yet. Every existing ancestor must be a
 *  real directory (no symlinks) inside the approved root. */
function plannedPath(root,relativePath){
  if(typeof relativePath!=='string'||!relativePath.trim())throw error('A relative file path is required.');
  const cleaned=relativePath.trim();
  if(path.isAbsolute(cleaned)||cleaned.includes('\0'))throw error('Use a path relative to the approved root.');
  const candidate=path.resolve(root.path,cleaned);
  if(candidate===root.path||!candidate.startsWith(root.path+path.sep))throw error('Target path leaves the approved root.',403);
  const relative=path.relative(root.path,candidate);
  const segments=relative.split(path.sep);
  if(segments.some(segment=>PROTECTED_SEGMENTS.has(segment)))throw error('Generated and version-control folders cannot be changed: '+relative,403);
  let current=root.path;
  for(const segment of segments.slice(0,-1)){
    current=path.join(current,segment);
    if(!fs.existsSync(current))break;
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink())throw error('Paths through symbolic links cannot be changed: '+relative,403);
    if(!stat.isDirectory())throw error('A parent of the target is a file, not a folder: '+relative,409);
  }
  return {path:candidate,relativePath:relative};
}

/** Current fingerprint of a path: 'absent', or the SHA-256 of its bytes. */
function fingerprint(absolutePath){
  if(!fs.existsSync(absolutePath))return ABSENT;
  const stat=fs.lstatSync(absolutePath);
  if(stat.isSymbolicLink())throw error('Symbolic-link targets cannot be changed.',403);
  if(!stat.isFile())throw error('Target must be a file: '+absolutePath,409);
  return hash(fs.readFileSync(absolutePath));
}

function assertText(content,relativePath){
  if(typeof content!=='string')throw error('File content must be text: '+relativePath);
  if(content.includes('\0'))throw error('Binary content cannot be created: '+relativePath);
  if(Buffer.byteLength(content)>MAX_EDIT_BYTES)throw error('New file exceeds the 1 MiB limit: '+relativePath,413);
}

function draftOperation(scanner,store,rootId,item){
  const op=operationOf(item),root=scanner.approvedRoot(store,rootId);
  const base={operation:op,dependsOn:(item.dependsOn||[]).map(String),impact:String(item.impact||'').slice(0,1000)};
  if(op==='edit'){
    const target=targetFile(scanner,store,rootId,item.relativePath);
    const find=String(item.find??''),replacement=String(item.replacement??'');
    if(!find||target.content.split(find).length-1!==1)throw error('Each batch change must identify one exact text region: '+target.relativePath);
    const proposed=target.content.replace(find,replacement);
    if(proposed===target.content)throw error('The change has no effect: '+target.relativePath);
    return {...base,relativePath:target.relativePath,paths:[target.relativePath],sourcePath:target.path,sourceSha256:hash(target.content),proposedSha256:hash(proposed),find,replacement,diff:unifiedDiff(target.relativePath,target.content,proposed)};
  }
  if(op==='create'){
    const target=plannedPath(root,item.relativePath),content=String(item.content??'');
    assertText(content,target.relativePath);
    if(fingerprint(target.path)!==ABSENT)throw error('File already exists; use an edit instead: '+target.relativePath,409);
    const lines=content.split(/\r?\n/);
    return {...base,relativePath:target.relativePath,paths:[target.relativePath],sourcePath:target.path,sourceSha256:ABSENT,proposedSha256:hash(content),content,diff:['--- /dev/null','+++ b/'+target.relativePath,'@@ -0,0 +1,'+lines.length+' @@',...lines.map(line=>'+'+line)].join('\n')};
  }
  if(op==='delete'){
    const target=plannedPath(root,item.relativePath),before=fingerprint(target.path);
    if(before===ABSENT)throw error('File to delete does not exist: '+target.relativePath,404);
    if(fs.statSync(target.path).size>MAX_EDIT_BYTES)throw error('File to delete exceeds the 1 MiB backup limit: '+target.relativePath,413);
    const raw=fs.readFileSync(target.path),text=raw.includes(0)?null:raw.toString('utf8');
    const diff=text==null?'--- a/'+target.relativePath+'\n+++ /dev/null\nBinary file deleted':['--- a/'+target.relativePath,'+++ /dev/null','@@ -1,'+text.split(/\r?\n/).length+' +0,0 @@',...text.split(/\r?\n/).map(line=>'-'+line)].join('\n');
    return {...base,relativePath:target.relativePath,paths:[target.relativePath],sourcePath:target.path,sourceSha256:before,proposedSha256:ABSENT,diff};
  }
  const from=plannedPath(root,item.relativePath),to=plannedPath(root,item.toPath);
  const before=fingerprint(from.path);
  if(before===ABSENT)throw error('File to rename does not exist: '+from.relativePath,404);
  if(fingerprint(to.path)!==ABSENT)throw error('Rename destination already exists: '+to.relativePath,409);
  return {...base,relativePath:from.relativePath,toPath:to.relativePath,paths:[from.relativePath,to.relativePath],sourcePath:from.path,destinationPath:to.path,sourceSha256:before,proposedSha256:before,diff:'rename from '+from.relativePath+'\nrename to '+to.relativePath};
}

function orderBatch(edits){
  const byPath=new Map(edits.map(edit=>[edit.relativePath,edit])),ordered=[],visiting=new Set(),done=new Set();
  function visit(edit){if(done.has(edit.relativePath))return;if(visiting.has(edit.relativePath))throw error('Change dependencies contain a cycle.');visiting.add(edit.relativePath);for(const dependency of edit.dependsOn||[]){const target=byPath.get(dependency)||edits.find(x=>x.toPath===dependency);if(!target)throw error('Unknown change dependency: '+dependency);visit(target);}visiting.delete(edit.relativePath);done.add(edit.relativePath);ordered.push(edit);}
  edits.forEach(visit);return ordered;
}

function createBatch(store,scanner,input){
  if(!Array.isArray(input.changes)||!input.changes.length)throw error('A batch requires at least one change.');
  if(input.changes.length>MAX_BATCH_CHANGES)throw error('A batch may contain at most '+MAX_BATCH_CHANGES+' changes.');
  const root=scanner.approvedRoot(store,input.rootId);
  const drafted=input.changes.map(item=>draftOperation(scanner,store,input.rootId,item));
  if(drafted.every(x=>x.operation==='edit')&&drafted.length<2)throw error('A multi-file batch requires at least two changes.');
  const seen=new Set();
  for(const change of drafted)for(const p of change.paths){if(seen.has(p))throw error('Each file may appear only once in a batch: '+p);seen.add(p);}
  const ordered=orderBatch(drafted),now=new Date().toISOString();
  const counts={};for(const change of ordered)counts[change.operation]=(counts[change.operation]||0)+1;
  const batch={id:'batch_'+hash(input.rootId+'|'+now+'|'+crypto.randomBytes(4).toString('hex')).slice(0,16),type:'workspace-change-batch',rootId:root.id,rootPath:root.path,status:'draft',summary:String(input.summary||'Multi-file code change').slice(0,1000),operations:counts,createdAt:now,updatedAt:now,orderedFiles:ordered.map(x=>x.relativePath),changes:ordered,checks:[],copy:null,approval:null,execution:null,rollback:null};
  store.put('workspaceChangeBatches',batch);return batch;
}

/** Throws unless every path is still in the state recorded at draft time. */
function verifyPreconditions(scanner,store,batch,stage){
  const root=scanner.approvedRoot(store,batch.rootId);
  for(const change of batch.changes){
    const source=plannedPath(root,change.relativePath);
    if(fingerprint(source.path)!==change.sourceSha256)throw error('Source changed after '+stage+': '+change.relativePath,409);
    if(change.operation==='rename'&&fingerprint(plannedPath(root,change.toPath).path)!==ABSENT)throw error('Rename destination appeared after '+stage+': '+change.toPath,409);
  }
  return root;
}

function contentAfter(change,current){
  if(change.operation==='edit')return current.replace(change.find,change.replacement);
  if(change.operation==='create')return change.content;
  return null;
}

function parserCheck(file,content,cwd){
  const ext=path.extname(file).toLowerCase();
  if(ext==='.json'){JSON.parse(content);return 'JSON parses.';}
  if(['.js','.cjs','.mjs'].includes(ext)){execFileSync(process.execPath,['--check',file],{cwd,timeout:5000,stdio:'ignore'});return 'Node syntax check passed.';}
  return null;
}

function checkBatch(store,scanner,dataDir,id){
  const batch=store.get('workspaceChangeBatches',id);if(!batch)throw error('Unknown change batch.',404);
  const root=verifyPreconditions(scanner,store,batch,'batch creation');
  const copyPath=path.join(dataDir,'workspace-copies',batch.id);
  fs.rmSync(copyPath,{recursive:true,force:true});
  copyWorkspace(scanner,root.path,copyPath);
  const checks=[];
  for(const change of batch.changes){
    const copied=path.join(copyPath,change.relativePath);
    let status='passed',detail='Operation applied in isolated copy.';
    try{
      if(change.operation==='edit'||change.operation==='create'){
        const current=change.operation==='edit'?fs.readFileSync(change.sourcePath,'utf8'):'';
        const proposed=contentAfter(change,current);
        fs.mkdirSync(path.dirname(copied),{recursive:true});fs.writeFileSync(copied,proposed,'utf8');
        const parsed=parserCheck(copied,proposed,copyPath);if(parsed)detail+=' '+parsed;
      }else if(change.operation==='delete'){
        fs.rmSync(copied,{force:true});
        if(fs.existsSync(copied)){status='failed';detail='File is still present in the isolated copy.';}
      }else{
        const destination=path.join(copyPath,change.toPath);
        fs.mkdirSync(path.dirname(destination),{recursive:true});
        if(fs.existsSync(copied))fs.renameSync(copied,destination);
        else{status='failed';detail='Rename source is missing from the isolated copy (it may be excluded from scans).';}
      }
    }catch(e){status='failed';detail=String(e.message||e).slice(0,500);}
    checks.push({file:change.toPath?change.relativePath+' -> '+change.toPath:change.relativePath,operation:change.operation,name:'Operation and parser validation',status,detail});
  }
  checks.push(...runAcceptanceChecks(batch,copyPath));
  batch.checks=checks;batch.copy={path:copyPath};
  batch.semanticValidation={status:checks.some(x=>x.status==='failed')?'failed':checks.some(x=>x.status==='manual-review')?'manual-review-required':'passed',checkedAt:new Date().toISOString(),limitation:'Deterministic checks cover exact file effects. Behavioral criteria marked manual-review require user or executable-test evidence.'};
  batch.status=checks.some(x=>x.status==='failed')?'checks-failed':'checks-passed';batch.updatedAt=new Date().toISOString();
  store.put('workspaceChangeBatches',batch);return batch;
}

function approveBatch(store,scanner,id){
  const batch=store.get('workspaceChangeBatches',id);if(!batch)throw error('Unknown change batch.',404);
  if(batch.status!=='checks-passed')throw error('The full batch must pass validation before approval.',409);
  verifyPreconditions(scanner,store,batch,'validation');
  const now=new Date().toISOString();
  batch.status='approved';batch.updatedAt=now;
  batch.approval={id:'approval_'+hash(batch.id+'|'+now).slice(0,16),approvedAt:now,consumedAt:null,orderedFiles:[...batch.orderedFiles],operations:batch.changes.map(x=>({operation:x.operation,relativePath:x.relativePath,toPath:x.toPath||null,before:x.sourceSha256,after:x.proposedSha256})),hashes:batch.changes.map(x=>({relativePath:x.relativePath,before:x.sourceSha256,after:x.proposedSha256}))};
  store.put('workspaceChangeBatches',batch);return batch;
}

/** Creates missing parent folders and returns the ones it created, deepest
 *  last, so an undo can remove exactly those. */
function ensureParents(root,target){
  const created=[];let current=path.dirname(target);const missing=[];
  while(current!==root&&current.startsWith(root+path.sep)&&!fs.existsSync(current)){missing.unshift(current);current=path.dirname(current);}
  for(const dir of missing){fs.mkdirSync(dir);created.push(dir);}
  return created;
}
function removeCreatedDirs(dirs){for(const dir of [...dirs].reverse()){try{fs.rmdirSync(dir);}catch(_){}}}

function atomicWrite(target,content,mode,tag){
  const temporary=path.join(path.dirname(target),`.nova-${tag}-${process.pid}.tmp`);
  try{fs.writeFileSync(temporary,content,mode==null?undefined:{mode});fs.renameSync(temporary,target);}
  finally{try{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}catch(_){}}
}

/** Applies one operation. Returns the function that undoes it and the
 *  folders it had to create. */
function applyOperation(root,change,prepared,tag){
  if(change.operation==='edit'){
    atomicWrite(change.sourcePath,prepared.proposed,prepared.mode,tag);
    return {dirs:[],undo:()=>fs.writeFileSync(change.sourcePath,prepared.original,{mode:prepared.mode})};
  }
  if(change.operation==='create'){
    const dirs=ensureParents(root.path,change.sourcePath);
    try{atomicWrite(change.sourcePath,change.content,null,tag);}catch(e){removeCreatedDirs(dirs);throw e;}
    return {dirs,undo:()=>{fs.rmSync(change.sourcePath,{force:true});removeCreatedDirs(dirs);}};
  }
  if(change.operation==='delete'){
    fs.unlinkSync(change.sourcePath);
    return {dirs:[],undo:()=>fs.writeFileSync(change.sourcePath,prepared.original,{mode:prepared.mode})};
  }
  const dirs=ensureParents(root.path,change.destinationPath);
  try{fs.renameSync(change.sourcePath,change.destinationPath);}catch(e){removeCreatedDirs(dirs);throw e;}
  return {dirs,undo:()=>{fs.renameSync(change.destinationPath,change.sourcePath);removeCreatedDirs(dirs);}};
}

function executeBatch(store,scanner,dataDir,id){
  const batch=store.get('workspaceChangeBatches',id);if(!batch)throw error('Unknown change batch.',404);
  if(batch.status!=='approved'||batch.approval?.consumedAt)throw error('This batch needs an unused explicit approval.',409);
  const root=verifyPreconditions(scanner,store,batch,'approval');
  const prepared=batch.changes.map(change=>{
    if(change.operation==='create')return {};
    const original=fs.readFileSync(change.sourcePath),mode=fs.statSync(change.sourcePath).mode;
    if(change.operation!=='edit')return {original,mode};
    const proposed=contentAfter(change,original.toString('utf8'));
    if(hash(proposed)!==change.proposedSha256)throw error('Approved hash mismatch: '+change.relativePath,409);
    return {original,mode,proposed};
  });
  const rollbackDir=path.join(dataDir,'workspace-rollbacks',batch.id);
  fs.mkdirSync(rollbackDir,{recursive:true});
  batch.changes.forEach((change,i)=>{if(!prepared[i].original)return;const backup=path.join(rollbackDir,change.relativePath);fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,prepared[i].original,{flag:'wx'});});
  const undo=[],createdDirs=[];
  try{batch.changes.forEach((change,i)=>{const applied=applyOperation(root,change,prepared[i],batch.id+'-'+i);undo.push(applied.undo);createdDirs.push(...applied.dirs);});}
  catch(cause){
    for(const revert of undo.reverse()){try{revert();}catch(_){}}
    throw error('Batch write failed and all changed files were rolled back: '+cause.message,500);
  }
  const now=new Date().toISOString();
  const results=batch.changes.map(change=>{const finalPath=change.operation==='rename'?change.destinationPath:change.sourcePath;return {operation:change.operation,relativePath:change.relativePath,toPath:change.toPath||null,before:change.sourceSha256,after:fingerprint(finalPath)};});
  batch.status='applied';batch.updatedAt=now;batch.approval.consumedAt=now;
  batch.execution={status:'success',executedAt:now,orderedFiles:[...batch.orderedFiles],hashes:results,createdFolders:createdDirs.map(dir=>path.relative(root.path,dir))};
  batch.rollback={available:true,directory:rollbackDir,files:batch.changes.map(x=>x.relativePath),instructions:'Use Roll back batch to restore every file to its pre-batch state. Rollback refuses to run if any file changed after the batch was applied.'};
  store.put('workspaceChangeBatches',batch);return batch;
}

/** Reverses an applied batch, only when every touched path still matches
 *  the state the batch left it in. */
function rollbackBatch(store,scanner,dataDir,id){
  const batch=store.get('workspaceChangeBatches',id);if(!batch)throw error('Unknown change batch.',404);
  if(batch.status!=='applied'||!batch.rollback?.available)throw error('Only an applied batch with rollback evidence can be rolled back.',409);
  const root=scanner.approvedRoot(store,batch.rootId);
  batch.changes.forEach((change,i)=>{
    const after=batch.execution.hashes[i].after;
    const finalPath=change.operation==='rename'?plannedPath(root,change.toPath).path:plannedPath(root,change.relativePath).path;
    if(fingerprint(finalPath)!==after)throw error('File changed after the batch was applied, so rollback was stopped: '+(change.toPath||change.relativePath),409);
    if(change.operation==='rename'&&fingerprint(plannedPath(root,change.relativePath).path)!==ABSENT)throw error('The original path was reused after the rename: '+change.relativePath,409);
  });
  for(const change of [...batch.changes].reverse()){
    const backup=path.join(batch.rollback.directory,change.relativePath);
    if(change.operation==='edit'||change.operation==='delete'){const mode=fs.existsSync(change.sourcePath)?fs.statSync(change.sourcePath).mode:undefined;ensureParents(root.path,change.sourcePath);fs.writeFileSync(change.sourcePath,fs.readFileSync(backup),mode==null?undefined:{mode});}
    else if(change.operation==='create')fs.rmSync(change.sourcePath,{force:true});
    else{ensureParents(root.path,change.sourcePath);fs.renameSync(change.destinationPath,change.sourcePath);}
  }
  // Remove folders the batch created, deepest first, only if now empty.
  const folders=(batch.execution.createdFolders||[]).map(rel=>plannedPath(root,path.join(rel,'.keep')).path).map(p=>path.dirname(p));
  folders.sort((a,b)=>b.length-a.length).forEach(dir=>{try{fs.rmdirSync(dir);}catch(_){}});
  const now=new Date().toISOString();
  batch.status='rolled-back';batch.updatedAt=now;batch.rollback={...batch.rollback,available:false,rolledBackAt:now};
  store.put('workspaceChangeBatches',batch);return batch;
}

module.exports={proposeChange,checkProposal,approveProposal,executeProposal,createBatch,checkBatch,approveBatch,executeBatch,rollbackBatch,orderBatch,plannedPath,unifiedDiff,targetFile,copyWorkspace,runAcceptanceChecks,constants:{MAX_EDIT_BYTES,MAX_COPY_BYTES,MAX_BATCH_CHANGES}};
