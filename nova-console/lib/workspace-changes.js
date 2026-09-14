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

module.exports={proposeChange,checkProposal,approveProposal,executeProposal,unifiedDiff,targetFile,copyWorkspace,constants:{MAX_EDIT_BYTES,MAX_COPY_BYTES}};
