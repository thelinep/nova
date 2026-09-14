'use strict';

const crypto = require('node:crypto');

const PROFILE_LABELS = {
  'code-health':'Code health', 'security-signals':'Security signals', 'test-status':'Test status',
  'documentation-gaps':'Documentation gaps', 'duplicate-files':'Duplicate files', 'repository-changes':'Repository changes',
};

function idFor(value) { return 'wplan_' + crypto.createHash('sha256').update(value).digest('hex').slice(0,16); }
function normalized(value) { return String(value||'').trim().toLocaleLowerCase().replace(/\s+/g,' '); }

function requestedProfiles(text) {
  const value=normalized(text), profiles=[];
  const add=id=>{if(!profiles.includes(id))profiles.push(id);};
  if(/broken tests?|test (status|health|failures?)|tests? broken/.test(value)){add('test-status');add('code-health');}
  if(/security|secret|credential|vulnerab/.test(value))add('security-signals');
  if(/documentation|docs?|readme|license/.test(value))add('documentation-gaps');
  if(/duplicate|copies|identical files?/.test(value))add('duplicate-files');
  if(/git|repository changes?|changed files?|working tree/.test(value))add('repository-changes');
  if(/code health|quality|maintain|todo|fixme/.test(value))add('code-health');
  if(/review|audit|scan|inspect|analyse|analyze/.test(value)&&/(project|folder|repo|repository|codebase|workspace)/.test(value)){
    ['code-health','security-signals','test-status','documentation-gaps','duplicate-files','repository-changes'].forEach(add);
  }
  return profiles;
}

function matchesWorkspaceRequest(text) {
  const value=normalized(text);
  return requestedProfiles(value).length>0 && /(review|audit|scan|inspect|find|check|analyse|analyze|status|duplicate|security|tests?|docs?|changes?)/.test(value);
}

function selectRoot(roots,text,explicitRootId){
  if(explicitRootId)return roots.find(root=>root.id===explicitRootId)||null;
  const value=normalized(text);
  const named=roots.filter(root=>value.includes(normalized(root.path))||value.includes(normalized(root.label)));
  if(named.length===1)return named[0];
  return roots.length===1?roots[0]:null;
}

function createConversationPlan(store,input){
  const request=String(input.request||'').trim();
  if(!request||!matchesWorkspaceRequest(request))return {matched:false};
  const roots=store.all('workspaceRoots'),root=selectRoot(roots,request,input.rootId);
  const profiles=requestedProfiles(request);
  const tools=['bounded file listing','file-name and content search','language and dependency detection'];
  if(profiles.includes('repository-changes'))tools.push('read-only Git status');
  if(profiles.includes('duplicate-files'))tools.push('bounded SHA-256 comparison');
  const expectedOutput=profiles.map(id=>PROFILE_LABELS[id]+' findings with file citations');
  if(profiles.includes('test-status'))expectedOutput.push('Test inventory and configuration status; no test execution');
  const rootKey=root?.id||'root-selection-required';
  const equivalenceKey=idFor(rootKey+'|'+profiles.slice().sort().join('|')+'|read-only');
  const reusable=store.all('workspacePlans').find(plan=>plan.equivalenceKey===equivalenceKey&&plan.status==='draft');
  if(reusable)return {matched:true,reused:true,plan:reusable};
  const now=new Date().toISOString();
  const plan={id:idFor(equivalenceKey+'|'+now),type:'workspace-scan-plan',status:'draft',request,sessionId:input.sessionId||null,createdAt:now,updatedAt:now,equivalenceKey,rootId:root?.id||null,folders:root?[{id:root.id,label:root.label,path:root.path,access:'read-only'}]:[],rootSelectionRequired:!root,profiles,tools,expectedOutput,permissions:{read:{required:true,roots:root?[root.path]:[],scope:'Exact approved root only'},write:{required:false,localFolders:[],novaStores:['workspacePlans','workspaceReports']},executeCommands:false,network:false},limitations:['The plan does not scan until Run plan is selected.','Test status inspects files and configuration; it does not execute tests.','Generated reports use the scanner caps and exclusions shown in Local Workspace.']};
  store.put('workspacePlans',plan);return {matched:true,reused:false,plan};
}

function runPlan(store,scanner,id){
  const plan=store.get('workspacePlans',id);
  if(!plan)throw Object.assign(new Error('Unknown workspace plan: '+id),{statusCode:404});
  if(!plan.rootId)throw Object.assign(new Error('Select an approved root before running this plan.'),{statusCode:409});
  const report=scanner.createStructuredReport(store,{rootId:plan.rootId,profiles:plan.profiles});
  plan.status='completed';plan.updatedAt=new Date().toISOString();plan.reportId=report.id;store.put('workspacePlans',plan);
  return {plan,report};
}

function setPlanRoot(store,id,rootId){
  const plan=store.get('workspacePlans',id),root=store.get('workspaceRoots',rootId);
  if(!plan)throw Object.assign(new Error('Unknown workspace plan: '+id),{statusCode:404});
  if(!root)throw Object.assign(new Error('Select an approved local root.'),{statusCode:403});
  plan.rootId=root.id;plan.folders=[{id:root.id,label:root.label,path:root.path,access:'read-only'}];plan.rootSelectionRequired=false;plan.permissions.read.roots=[root.path];plan.updatedAt=new Date().toISOString();
  store.put('workspacePlans',plan);return plan;
}

module.exports={createConversationPlan,runPlan,setPlanRoot,requestedProfiles,matchesWorkspaceRequest};
