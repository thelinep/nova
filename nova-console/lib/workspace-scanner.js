'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const MAX_FILES = 5000;
const MAX_DEPTH = 14;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MATCHES = 200;
const MAX_FINDINGS_PER_PROFILE = 200;
const MAX_DUPLICATE_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', '.next', 'dist', 'build', 'coverage', '.cache']);
const LANGUAGE_BY_EXT = {
  '.js':'JavaScript','.cjs':'JavaScript','.mjs':'JavaScript','.jsx':'JavaScript',
  '.ts':'TypeScript','.tsx':'TypeScript','.py':'Python','.rs':'Rust','.go':'Go',
  '.java':'Java','.kt':'Kotlin','.swift':'Swift','.rb':'Ruby','.php':'PHP',
  '.c':'C','.h':'C/C++ Header','.cc':'C++','.cpp':'C++','.cs':'C#',
  '.html':'HTML','.css':'CSS','.scss':'SCSS','.sql':'SQL','.sh':'Shell',
  '.json':'JSON','.yaml':'YAML','.yml':'YAML','.toml':'TOML','.md':'Markdown',
};
const REPORT_PROFILES = [
  { id:'code-health', label:'Code health' },
  { id:'security-signals', label:'Security signals' },
  { id:'test-status', label:'Test status' },
  { id:'documentation-gaps', label:'Documentation gaps' },
  { id:'duplicate-files', label:'Duplicate files' },
  { id:'repository-changes', label:'Repository changes' },
];

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function makeId(prefix, value) {
  return prefix + '_' + crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function canonicalDirectory(input) {
  if (typeof input !== 'string' || !input.trim()) throw httpError('A local folder path is required.');
  const resolved = fs.realpathSync.native(path.resolve(input.trim()));
  if (!fs.statSync(resolved).isDirectory()) throw httpError('The selected path is not a directory.');
  if (resolved === path.parse(resolved).root) throw httpError('A filesystem root cannot be approved. Select a narrower folder.');
  return resolved;
}

function approveRoot(store, input) {
  let realPath;
  try { realPath = canonicalDirectory(input.path); }
  catch (error) {
    if (error.statusCode) throw error;
    throw httpError('Could not open that folder: ' + error.message);
  }
  const now = new Date().toISOString();
  const id = makeId('root', realPath);
  const existing = store.get('workspaceRoots', id);
  const root = { id, path: realPath, label: String(input.label || path.basename(realPath) || realPath).slice(0, 120), approvedAt: existing?.approvedAt || now, verifiedAt: now };
  store.put('workspaceRoots', root);
  return root;
}

function approvedRoot(store, rootId) {
  const root = store.get('workspaceRoots', rootId);
  if (!root) throw httpError('Select an approved local root first.', 403);
  let current;
  try { current = canonicalDirectory(root.path); }
  catch (error) { throw httpError('The approved folder is no longer available: ' + error.message, 410); }
  if (current !== root.path) throw httpError('The approved folder now resolves to a different location. Approve it again.', 403);
  return root;
}

function relativeCitation(rootPath, filePath, line) {
  const relative = path.relative(rootPath, filePath) || '.';
  return { path: filePath, relativePath: relative, line: line || 1, citation: filePath + ':' + (line || 1) };
}

function walkFiles(rootPath, limits = {}) {
  const maxFiles = Math.min(MAX_FILES, Math.max(1, Number(limits.maxFiles) || MAX_FILES));
  const maxDepth = Math.min(MAX_DEPTH, Math.max(1, Number(limits.maxDepth) || MAX_DEPTH));
  const files = [];
  const skipped = [];
  const stack = [{ dir: rootPath, depth: 0 }];
  let truncated = false;
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { skipped.push({ path: dir, reason: error.code || error.message }); continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { skipped.push({ path: full, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) { skipped.push({ path: full, reason: 'excluded-directory' }); continue; }
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        else skipped.push({ path: full, reason: 'depth-limit' });
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          files.push({ path: full, relativePath: path.relative(rootPath, full), size: stat.size, modifiedAt: stat.mtime.toISOString(), extension: path.extname(entry.name).toLowerCase() });
        } catch (error) { skipped.push({ path: full, reason: error.code || error.message }); }
      }
    }
    if (truncated) break;
  }
  return { files, skipped: skipped.slice(0, 200), truncated, limits: { maxFiles, maxDepth, maxFileBytes: MAX_FILE_BYTES } };
}

function dependencyFiles(rootPath, files) {
  const names = new Set(['package.json','Cargo.toml','requirements.txt','pyproject.toml','Pipfile','go.mod','Gemfile','composer.json','pom.xml','build.gradle','Package.swift']);
  return files.filter(file => names.has(path.basename(file.path))).map(file => relativeCitation(rootPath, file.path, 1));
}

function languageSummary(files) {
  const counts = new Map();
  for (const file of files) {
    const language = LANGUAGE_BY_EXT[file.extension];
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()].map(([language, files]) => ({ language, files })).sort((a,b) => b.files - a.files || a.language.localeCompare(b.language));
}

function gitState(rootPath) {
  const run = args => execFileSync('git', args, { cwd: rootPath, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio:['ignore','pipe','ignore'] }).trim();
  try {
    const topLevel = fs.realpathSync.native(run(['rev-parse', '--show-toplevel']));
    if (topLevel !== rootPath) return { available: false, reason: 'Selected root is inside a Git repository; approve the repository root for Git status.' };
    const status = run(['status', '--short']).split('\n').filter(Boolean);
    return { available: true, branch: run(['branch', '--show-current']), head: run(['rev-parse', '--short', 'HEAD']), changed: status.length, files: status.slice(0, 200), truncated: status.length > 200 };
  } catch (error) { return { available: false, reason: 'No Git repository found at the approved root.' }; }
}

function readableText(file) {
  if (file.size > MAX_FILE_BYTES) return null;
  try {
    const data = fs.readFileSync(file.path);
    return data.includes(0) ? null : data.toString('utf8');
  } catch (_) { return null; }
}

function finding(rootPath, file, line, severity, title, detail) {
  return { severity, title, detail, ...relativeCitation(rootPath, file.path, line) };
}

function codeHealthProfile(rootPath, files) {
  const findings = [];
  let sourceFiles = 0, sourceLines = 0;
  const sourceExtensions = new Set(Object.keys(LANGUAGE_BY_EXT).filter(ext => !['.json','.yaml','.yml','.toml','.md'].includes(ext)));
  for (const file of files) {
    if (!sourceExtensions.has(file.extension)) continue;
    sourceFiles++;
    const text = readableText(file);
    if (text == null) {
      if (file.size > MAX_FILE_BYTES) findings.push(finding(rootPath,file,1,'warning','Large source file','File exceeds the 1 MiB text-inspection limit.'));
      continue;
    }
    const lines = text.split(/\r?\n/); sourceLines += lines.length;
    if (lines.length > 1200) findings.push(finding(rootPath,file,1,'warning','Large source file',lines.length+' lines may be difficult to maintain.'));
    for (let i=0;i<lines.length && findings.length<MAX_FINDINGS_PER_PROFILE;i++) {
      const tag = lines[i].match(/\b(TODO|FIXME|HACK|XXX)\b/i);
      if (tag) findings.push(finding(rootPath,file,i+1,'info',tag[1].toUpperCase()+' marker',lines[i].trim().slice(0,180)));
    }
  }
  return { id:'code-health', title:'Code health', status:findings.some(x=>x.severity==='warning')?'attention':'clear', summary:`${sourceFiles} source files and ${sourceLines} readable lines inspected; ${findings.length} maintainability signal(s).`, findings, limitations:['Heuristic scan only; it does not compile or execute the project.'] };
}

function securityProfile(rootPath, files) {
  const findings=[];
  const sensitiveName=/(^|\/)(\.env($|\.)|id_rsa|id_ed25519|.*\.(pem|p12|pfx|key))$/i;
  const assignment=/(api[_-]?key|secret|password|passwd|access[_-]?token|private[_-]?key)\s*[:=]\s*['"][^'"]{6,}/i;
  for(const file of files){
    if(sensitiveName.test(file.relativePath)) findings.push(finding(rootPath,file,1,'warning','Sensitive filename','Potential credential-bearing file; contents were not included in the report.'));
    const text=readableText(file); if(text==null)continue;
    const lines=text.split(/\r?\n/);
    for(let i=0;i<lines.length && findings.length<MAX_FINDINGS_PER_PROFILE;i++) if(assignment.test(lines[i])) findings.push(finding(rootPath,file,i+1,'warning','Potential credential assignment','A secret-like assignment was detected. Its value is redacted.'));
  }
  return {id:'security-signals',title:'Security signals',status:findings.length?'attention':'clear',summary:`${files.length} files checked; ${findings.length} potential security signal(s).`,findings,limitations:['Pattern-based signals require human review and may include false positives.','Suspected secret values are never stored in reports.']};
}

function testStatusProfile(rootPath, files) {
  const testPattern=/(^|\/)(__tests__|tests?|spec)(\/|\.|$)|\.(test|spec)\.[^.]+$/i;
  const tests=files.filter(file=>testPattern.test(file.relativePath));
  const configs=files.filter(file=>/(playwright|vitest|jest|pytest|cypress|cargo\.toml|package\.json)/i.test(path.basename(file.path)));
  const findings=[...tests.slice(0,100).map(file=>finding(rootPath,file,1,'info','Test file','Detected by file or directory naming.')),...configs.slice(0,50).map(file=>finding(rootPath,file,1,'info','Test configuration','Potential test runner or manifest.'))];
  return {id:'test-status',title:'Test status',status:tests.length?'configured':'attention',summary:tests.length?`${tests.length} test file(s) and ${configs.length} related configuration file(s) detected.`:'No test files were detected in the scanned scope.',findings,limitations:['This profile reports test presence and configuration; it does not execute tests or claim they pass.']};
}

function documentationProfile(rootPath, files) {
  const rootNames=new Set(files.filter(file=>!file.relativePath.includes(path.sep)).map(file=>path.basename(file.path).toLowerCase()));
  const expected=[['README','readme.md'],['License','license'],['Contributing guide','contributing.md'],['Security policy','security.md']];
  const findings=[];
  for(const [label,name] of expected) if(![...rootNames].some(x=>x===name||x.startsWith(name+'.'))) findings.push({severity:label==='README'?'warning':'info',title:'Missing '+label,detail:'No '+label.toLowerCase()+' was found at the approved root.',path:rootPath,relativePath:'.',line:1,citation:rootPath+':1'});
  const docs=files.filter(file=>file.extension==='.md');
  return {id:'documentation-gaps',title:'Documentation gaps',status:findings.some(x=>x.severity==='warning')?'attention':'clear',summary:`${docs.length} Markdown document(s); ${findings.length} common root-document gap(s).`,findings,limitations:['Checks common repository documents only; it does not judge documentation accuracy.']};
}

function duplicatesProfile(rootPath, files) {
  const bySize=new Map();
  for(const file of files) if(file.size>0&&file.size<=MAX_DUPLICATE_BYTES){const list=bySize.get(file.size)||[];list.push(file);bySize.set(file.size,list);}
  const groups=[];
  for(const candidates of bySize.values()){
    if(candidates.length<2)continue;
    const byHash=new Map();
    for(const file of candidates){let hash;try{hash=crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');}catch(_){continue;}const list=byHash.get(hash)||[];list.push(file);byHash.set(hash,list);}
    for(const [hash,group] of byHash)if(group.length>1&&groups.length<100)groups.push({hash:hash.slice(0,16),size:group[0].size,files:group.map(file=>relativeCitation(rootPath,file.path,1))});
  }
  const findings=groups.flatMap((group,index)=>group.files.map(file=>({severity:'info',title:'Duplicate group '+(index+1),detail:`Identical ${group.size}-byte file; SHA-256 ${group.hash}…`,...file}))).slice(0,MAX_FINDINGS_PER_PROFILE);
  return {id:'duplicate-files',title:'Duplicate files',status:groups.length?'attention':'clear',summary:`${groups.length} duplicate content group(s) found across files up to 10 MiB.`,findings,groups,limitations:['Empty files and files larger than 10 MiB are not compared.']};
}

function repositoryChangesProfile(rootPath) {
  const git=gitState(rootPath),findings=[];
  if(git.available) for(const row of git.files||[]){const relative=row.slice(3).replace(/^.* -> /,'');findings.push({severity:'info',title:'Repository change',detail:row.slice(0,2).trim()||'modified',...relativeCitation(rootPath,path.join(rootPath,relative),1)});}
  return {id:'repository-changes',title:'Repository changes',status:git.available?(git.changed?'attention':'clear'):'unavailable',summary:git.available?`${git.branch||'detached'} @ ${git.head}; ${git.changed} changed file(s).`:git.reason,findings,git,limitations:['Git status is read-only and capped at 200 changed paths.']};
}

function createStructuredReport(store,input){
  const root=approvedRoot(store,input.rootId),startedAt=new Date().toISOString(),walked=walkFiles(root.path,input);
  const allowed=new Set(REPORT_PROFILES.map(x=>x.id));
  const profiles=(Array.isArray(input.profiles)&&input.profiles.length?input.profiles:REPORT_PROFILES.map(x=>x.id)).filter((x,i,a)=>allowed.has(x)&&a.indexOf(x)===i);
  if(!profiles.length)throw httpError('Select at least one recognized report profile.');
  const builders={'code-health':()=>codeHealthProfile(root.path,walked.files),'security-signals':()=>securityProfile(root.path,walked.files),'test-status':()=>testStatusProfile(root.path,walked.files),'documentation-gaps':()=>documentationProfile(root.path,walked.files),'duplicate-files':()=>duplicatesProfile(root.path,walked.files),'repository-changes':()=>repositoryChangesProfile(root.path)};
  const sections=profiles.map(id=>builders[id]());
  const report={id:makeId('structured',root.id+profiles.join(',')+startedAt),type:'workspace-structured',rootId:root.id,rootPath:root.path,startedAt,completedAt:new Date().toISOString(),status:'completed',readOnly:true,scope:{rootPath:root.path,profiles,filesConsidered:walked.files.length,truncated:walked.truncated,excludedDirectories:[...SKIP_DIRS],limits:{...walked.limits,maxFindingsPerProfile:MAX_FINDINGS_PER_PROFILE,maxDuplicateBytes:MAX_DUPLICATE_BYTES}},sections,limitations:['Findings are bounded, read-only signals and require review before action.','Symbolic links are not followed.']};
  store.put('workspaceReports',report);return report;
}

function scanWorkspace(store, input) {
  const root = approvedRoot(store, input.rootId);
  const startedAt = new Date().toISOString();
  const walked = walkFiles(root.path, input);
  const report = {
    id: makeId('scan', root.id + startedAt), type: 'workspace-scan', rootId: root.id, rootPath: root.path,
    startedAt, completedAt: new Date().toISOString(), status: 'completed', readOnly: true,
    summary: { files: walked.files.length, totalBytes: walked.files.reduce((n,f)=>n+f.size,0), languages: languageSummary(walked.files), dependencyFiles: dependencyFiles(root.path, walked.files), git: gitState(root.path) },
    files: walked.files, skipped: walked.skipped, truncated: walked.truncated, limits: walked.limits,
    limitations: ['Symbolic links are not followed.', 'Vendor, build, cache, and VCS directories are excluded.', walked.truncated ? 'File results reached the configured cap.' : null].filter(Boolean),
  };
  store.put('workspaceReports', report);
  return report;
}

function searchWorkspace(store, input) {
  const root = approvedRoot(store, input.rootId);
  const query = String(input.query || '').trim();
  if (!query) throw httpError('A search query is required.');
  if (query.length > 300) throw httpError('Search query is too long.');
  const walked = walkFiles(root.path, input);
  const q = query.toLocaleLowerCase();
  const matches = [];
  for (const file of walked.files) {
    if (matches.length >= MAX_MATCHES) break;
    if (file.relativePath.toLocaleLowerCase().includes(q)) matches.push({ kind:'name', ...relativeCitation(root.path, file.path, 1), preview:file.relativePath });
    if (file.size > MAX_FILE_BYTES || matches.length >= MAX_MATCHES) continue;
    let text;
    try { text = fs.readFileSync(file.path); } catch (_) { continue; }
    if (text.includes(0)) continue;
    const lines = text.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < MAX_MATCHES; index++) {
      if (lines[index].toLocaleLowerCase().includes(q)) matches.push({ kind:'content', ...relativeCitation(root.path, file.path, index + 1), preview:lines[index].trim().slice(0, 240) });
    }
  }
  const now = new Date().toISOString();
  const report = { id:makeId('search', root.id + query + now), type:'workspace-search', rootId:root.id, rootPath:root.path, query, startedAt:now, completedAt:new Date().toISOString(), status:'completed', readOnly:true, matches, searchedFiles:walked.files.length, truncated:matches.length >= MAX_MATCHES || walked.truncated, limits:{...walked.limits,maxMatches:MAX_MATCHES}, limitations:['Binary files and files larger than 1 MiB are not searched for content.','Symbolic links are not followed.'] };
  store.put('workspaceReports', report);
  return report;
}

module.exports = { approveRoot, approvedRoot, scanWorkspace, searchWorkspace, createStructuredReport, walkFiles, languageSummary, gitState, REPORT_PROFILES, constants:{MAX_FILES,MAX_DEPTH,MAX_FILE_BYTES,MAX_MATCHES,MAX_FINDINGS_PER_PROFILE,MAX_DUPLICATE_BYTES} };
