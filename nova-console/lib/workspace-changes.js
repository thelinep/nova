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

function orderBatch(edits){
  const byPath=new Map(edits.map(edit=>[edit.relativePath,edit])),ordered=[],visiting=new Set(),done=new Set();
  function visit(edit){if(done.has(edit.relativePath))return;if(visiting.has(edit.relativePath))throw error('Change dependencies contain a cycle.');visiting.add(edit.relativePath);for(const dependency of edit.dependsOn||[]){if(!byPath.has(dependency))throw error('Unknown change dependency: '+dependency);visit(byPath.get(dependency));}visiting.delete(edit.relativePath);done.add(edit.relativePath);ordered.push(edit);}
  edits.forEach(visit);return ordered;
}

function createBatch(store,scanner,input){
  if(!Array.isArray(input.changes)||input.changes.length<2)throw error('A multi-file batch requires at least two changes.');
  const seen=new Set(),edits=input.changes.map(item=>{const target=targetFile(scanner,store,input.rootId,item.relativePath);if(seen.has(target.relativePath))throw error('Each file may appear only once in a batch.');seen.add(target.relativePath);const find=String(item.find??''),replacement=String(item.replacement??'');if(!find||target.content.split(find).length-1!==1)throw error('Each batch change must identify one exact text region: '+target.relativePath);const proposed=target.content.replace(find,replacement);return{relativePath:target.relativePath,sourcePath:target.path,sourceSha256:hash(target.content),proposedSha256:hash(proposed),find,replacement,dependsOn:(item.dependsOn||[]).map(String),diff:unifiedDiff(target.relativePath,target.content,proposed),impact:String(item.impact||'').slice(0,1000)};});
  const ordered=orderBatch(edits),now=new Date().toISOString(),batch={id:'batch_'+hash(input.rootId+'|'+now).slice(0,16),type:'workspace-change-batch',rootId:input.rootId,rootPath:targetFile(scanner,store,input.rootId,ordered[0].relativePath).root.path,status:'draft',summary:String(input.summary||'Multi-file code change').slice(0,1000),createdAt:now,updatedAt:now,orderedFiles:ordered.map(x=>x.relativePath),changes:ordered,checks:[],copy:null,approval:null,execution:null,rollback:null};store.put('workspaceChangeBatches',batch);return batch;
}

function checkBatch(store,scanner,dataDir,id){const batch=store.get('workspaceChangeBatches',id);if(!batch)throw error('Unknown change batch.',404);const copyPath=path.join(dataDir,'workspace-copies',batch.id);copyWorkspace(scanner,batch.rootPath,copyPath);const checks=[];for(const edit of batch.changes){const target=targetFile(scanner,store,batch.rootId,edit.relativePath);if(hash(target.content)!==edit.sourceSha256)throw error('Source changed after batch creation: '+edit.relativePath,409);const proposed=target.content.replace(edit.find,edit.replacement),copiedTarget=path.join(copyPath,edit.relativePath);fs.writeFileSync(copiedTarget,proposed,'utf8');let status='passed',detail='Patch applied in isolated copy.';try{if(path.extname(copiedTarget)==='.json')JSON.parse(proposed);else if(['.js','.cjs','.mjs'].includes(path.extname(copiedTarget)))execFileSync(process.execPath,['--check',copiedTarget],{cwd:copyPath,timeout:5000,stdio:'ignore'});}catch(e){status='failed';detail=e.message;}checks.push({file:edit.relativePath,name:'Patch and parser validation',status,detail});}checks.push(...runAcceptanceChecks(batch,copyPath));batch.checks=checks;batch.copy={path:copyPath};batch.semanticValidation={status:checks.some(x=>x.status==='failed')?'failed':checks.some(x=>x.status==='manual-review')?'manual-review-required':'passed',checkedAt:new Date().toISOString(),limitation:'Deterministic checks cover exact file effects. Behavioral criteria marked manual-review require user or executable-test evidence.'};batch.status=checks.some(x=>x.status==='failed')?'checks-failed':'checks-passed';batch.updatedAt=new Date().toISOString();store.put('workspaceChangeBatches',batch);return batch;}

function approveBatch(store,scanner,id){const batch=store.get('workspaceChangeBatches',id);if(!batch)throw error('Unknown change batch.',404);if(batch.status!=='checks-passed')throw error('The full batch must pass validation before approval.',409);for(const edit of batch.changes){const target=targetFile(scanner,store,batch.rootId,edit.relativePath);if(hash(target.content)!==edit.sourceSha256)throw error('Source changed after validation: '+edit.relativePath,409);}const now=new Date().toISOString();batch.status='approved';batch.updatedAt=now;batch.approval={id:'approval_'+hash(batch.id+'|'+now).slice(0,16),approvedAt:now,consumedAt:null,orderedFiles:[...batch.orderedFiles],hashes:batch.changes.map(x=>({relativePath:x.relativePath,before:x.sourceSha256,after:x.proposedSha256}))};store.put('workspaceChangeBatches',batch);return batch;}

function executeBatch(store,scanner,dataDir,id){const batch=store.get('workspaceChangeBatches',id);if(!batch)throw error('Unknown change batch.',404);if(batch.status!=='approved'||batch.approval?.consumedAt)throw error('This batch needs an unused explicit approval.',409);const prepared=batch.changes.map(edit=>{const target=targetFile(scanner,store,batch.rootId,edit.relativePath);if(hash(target.content)!==edit.sourceSha256)throw error('Source changed after approval: '+edit.relativePath,409);const proposed=target.content.replace(edit.find,edit.replacement);if(hash(proposed)!==edit.proposedSha256)throw error('Approved hash mismatch: '+edit.relativePath,409);return{edit,target,proposed,mode:fs.statSync(target.path).mode};});const rollbackDir=path.join(dataDir,'workspace-rollbacks',batch.id);fs.mkdirSync(rollbackDir,{recursive:true});for(const item of prepared){const backup=path.join(rollbackDir,item.edit.relativePath);fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,item.target.content,{flag:'wx'});}const written=[];try{for(const item of prepared){const temporary=path.join(path.dirname(item.target.path),`.nova-${batch.id}-${process.pid}.tmp`);fs.writeFileSync(temporary,item.proposed,{mode:item.mode});fs.renameSync(temporary,item.target.path);written.push(item);}}catch(cause){for(const item of written.reverse())fs.writeFileSync(item.target.path,item.target.content,{mode:item.mode});throw error('Batch write failed and all changed files were rolled back: '+cause.message,500);}const now=new Date().toISOString();batch.status='applied';batch.updatedAt=now;batch.approval.consumedAt=now;batch.execution={status:'success',executedAt:now,orderedFiles:[...batch.orderedFiles],hashes:prepared.map(x=>({relativePath:x.edit.relativePath,before:x.edit.sourceSha256,after:hash(fs.readFileSync(x.target.path))}))};batch.rollback={available:true,directory:rollbackDir,files:batch.changes.map(x=>x.relativePath)};store.put('workspaceChangeBatches',batch);return batch;}

module.exports={proposeChange,checkProposal,approveProposal,executeProposal,createBatch,checkBatch,approveBatch,executeBatch,orderBatch,unifiedDiff,targetFile,copyWorkspace,runAcceptanceChecks,constants:{MAX_EDIT_BYTES,MAX_COPY_BYTES}};
