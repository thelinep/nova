'use strict';
/* ===========================================================================
 * One chat reply, end to end
 *
 * Streams newline-delimited JSON events to the console while it works:
 *   {type:'job', jobId}                 the activity job for this reply
 *   {type:'steps', steps}               plain-language steps, updated live
 *   {type:'approval', approval}         NOVA wants to use the computer
 *   {type:'image', url, caption}        e.g. a screenshot it took
 *   {type:'context', used, sources}     which source passages it read
 *   {type:'memory', saved|forgot}       memory notes changed
 *   {type:'token', text}                the reply, as it is written
 *   {type:'done', content, stats}       finished
 *   {type:'followups', items}           suggested next questions
 *   {type:'error', error}
 *
 * The reply is grounded in: memory notes, sources added to the conversation,
 * retrieved knowledge passages, and — when Computer is on — tool results from
 * this Mac, each action approved by the person first.
 * ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');
const activity = require('./activity');
const chatSources = require('./chat-sources');
const computer = require('./computer');
const contracts = require('./contracts');
const memory = require('./user-memory');
const workspaceScanner = require('./workspace-scanner');
const ocr = require('./ocr');
const imageToCode = require('./image-to-code');

const SCAN_INTENT = /\b(scan|audit|review|report|analy[sz]e|analysis|health|inspect|check ?up|assess|overview)\b/i;

/** Runs NOVA's read-only structured scan over a folder added to the chat and returns it as text for the model. */
function scanFolder(store, folder, label) {
  const had = store.all('workspaceRoots').some(r => r.path === folder);
  const root = workspaceScanner.approveRoot(store, { path: folder, label });
  try {
    const report = workspaceScanner.createStructuredReport(store, { rootId: root.id });
    const findings = report.sections.reduce((n, x) => n + (x.findings || []).length, 0);
    const text = `Read-only scan of ${label} (${report.scope.filesConsidered} files${report.scope.truncated ? ', limit reached' : ''}). Heuristic signals, not verified facts:\n` + report.sections.map(sec => `## ${sec.title} — ${sec.status}\n${sec.summary}\n` + (sec.findings || []).slice(0, 6).map(f => `- [${f.severity}] ${f.title}: ${f.relativePath || ''}${f.line ? ':' + f.line : ''} ${String(f.detail || '').slice(0, 160)}`).join('\n')).join('\n\n');
    return { text, sections: report.sections.length, findings, files: report.scope.filesConsidered, reportId: report.id };
  } finally {
    if (!had) store.delete('workspaceRoots', root.id); // the scan does not add the folder to Local Workspace
  }
}

const MAX_ROUNDS = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function persona({ computerOn, roots, screen, today }) {
  const lines = [
    'You are NOVA, a friendly and capable assistant that runs privately on this person\'s own Mac.',
    'Talk like a thoughtful colleague: warm, direct and in plain words. Lead with the answer, keep paragraphs short, and skip filler such as "Certainly!" or "Great question".',
    'If a request is unclear or is missing something you need, ask one short clarifying question instead of guessing. If you are not sure, say so.',
    'Reply in the language the person writes in (for example Hindi when they write in Hindi). Use Markdown only when it helps: lists, tables, code.',
    'When sources or passages are provided, answer from them and name the file or page you used. If they do not contain the answer, say that.',
    `Today is ${today}.`,
  ];
  if (computerOn) {
    lines.push(
      'You can use this Mac through tools. Before a series of actions, say in one short sentence what you are about to do.',
      'Prefer run_command and the file tools; use screenshot, click, type_text and press_key only for apps with no other way.' + (screen ? '' : ' (Screen control is turned off.)'),
      'Every action is shown to the person for approval. If they decline, do not repeat it: ask what they would prefer.',
      'Never say you did something unless a tool result confirms it. Keep commands safe and reversible; do not delete things.',
      (roots.length ? 'Approved folders (commands and file tools work only inside these): ' + roots.join(', ') + '. ' : 'No folder is approved yet. ') + 'When you need a folder that is not approved (for example ~/Desktop), call use_folder with its path: the person approves it with one click. Never ask the person to type commands, menu paths or button names.',
    );
  }
  return lines.join('\n');
}

function trimHistory(messages, maxChars) {
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const len = String(m.content || '').length + 20;
    if (used + len > maxChars && out.length >= 2) break;
    out.unshift(m); used += len;
  }
  return out;
}

/**
 * deps: {store, dataDir, ollama, media}
 * body: {sessionId, model, messages, options, retrieved, computer, memory, followups}
 * emit(event) writes one NDJSON line; signal aborts when the client goes away.
 */
async function runTurn(deps, body, emit, clientSignal) {
  const { store, dataDir, ollama, media } = deps;
  const model = String(body.model || '');
  const sessionId = String(body.sessionId || '');
  const history = Array.isArray(body.messages) ? body.messages.filter(m => m && ['user', 'assistant'].includes(m.role)) : [];
  if (!model || !history.length) throw Object.assign(new Error('Expected {model, sessionId, messages[]}'), { statusCode: 400 });
  const last = history[history.length - 1];
  const record = store.get('models', model) || {};
  const caps = Array.isArray(record.capabilities) ? record.capabilities : [];
  const canTools = !caps.length || caps.includes('tools');
  const canSee = caps.includes('vision');
  const ctxTokens = record.ctxMax ? record.ctxMax * 1024 : 8192;
  const budget = Math.max(4000, Math.min(48000, Math.floor(ctxTokens * 4 * 0.35)));

  const title = String(last.content || 'Reply').replace(/\s+/g, ' ').slice(0, 70);
  const job = activity.start({ kind: 'chat', title: 'Replying to “' + title + (String(last.content).length > 70 ? '…”' : '”'), sessionId });
  const signal = AbortSignal.any([job.signal, clientSignal].filter(Boolean));
  const off = activity.subscribe(ev => { if (ev.job.id === job.id) emit({ type: 'steps', steps: ev.job.steps, status: ev.job.status }); });
  emit({ type: 'job', jobId: job.id });

  const started = Date.now();
  let content = '', firstTokenAt = null, evalCount = 0, evalDuration = 0;
  try {
    /* 1 · memory commands */
    const sys = [];
    if (body.memory !== false) {
      const cmd = memory.detect(last.content);
      if (cmd && cmd.remember) {
        const note = memory.add(store, cmd.remember, 'chat');
        job.note('Saved to memory', note.text);
        emit({ type: 'memory', saved: note });
        sys.push(`The person just asked you to remember: "${note.text}". It is saved in their Memory (Settings > Memory). Confirm in one short, natural sentence.`);
      } else if (cmd && cmd.forget) {
        const gone = memory.forget(store, cmd.forget);
        job.note(gone.length ? 'Removed from memory' : 'Nothing in memory matched', gone.map(n => n.text).join('; ') || cmd.forget);
        emit({ type: 'memory', forgot: gone });
        sys.push(gone.length ? `You deleted ${gone.length} memory note(s) matching "${cmd.forget}". Confirm briefly.` : `No memory note matched "${cmd.forget}". Say so briefly and mention Settings > Memory.`);
      }
      const notes = memory.promptText(store);
      if (notes) sys.push(notes);
    }

    /* 2 · sources added to the conversation */
    const srcs = chatSources.list(store, sessionId);
    const reading = srcs.filter(s => s.status === 'reading');
    if (reading.length) job.note('Still reading ' + reading.map(s => s.label).join(', '), 'I will answer from what is ready now');
    if (srcs.some(s => s.status === 'ready')) {
      const st = job.step(`Reading ${srcs.filter(s => s.status === 'ready').length === 1 ? srcs.find(s => s.status === 'ready').label : srcs.filter(s => s.status === 'ready').length + ' sources'}`);
      const ctx = chatSources.contextFor(store, dataDir, { sessionId, query: history.slice(-3).map(m => m.content).join('\n'), budget: Math.floor(budget * 0.6) });
      if (ctx.text) sys.push(ctx.text);
      const files = [...new Set(ctx.used.map(u => u.path))];
      st.done(files.length ? `${ctx.used.length} passage${ctx.used.length === 1 ? '' : 's'} from ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''}` : 'Overview only');
      emit({ type: 'context', used: ctx.used, sources: ctx.sources.map(s => ({ id: s.id, label: s.label, kind: s.kind })) });
    }

    /* 2b · "scan and report" on a folder or repo added to the chat */
    if (SCAN_INTENT.test(String(last.content || ''))) {
      const folders = srcs.filter(x => (x.kind === 'folder' || x.kind === 'git') && x.status !== 'failed').slice(0, 2);
      for (const f of folders) {
        const where = f.kind === 'git' ? (f.localPath || f.origin) : f.origin;
        const st = job.step('Scanning ' + f.label, 'code health, security signals, tests, docs, duplicates, git changes');
        try {
          const r = scanFolder(store, where, f.label);
          st.done(`${r.files} files · ${r.sections} checks · ${r.findings} findings`);
          sys.push(r.text + '\n\nWrite the report for the person from this scan: a short overview first, then what stands out in each area, then suggested next steps. Cite files as path:line. Say plainly that these are automatic signals to review, not confirmed problems.');
        } catch (e) { st.fail(e); }
      }
    }

    /* 3 · retrieved knowledge passages (chosen by the console) */
    const retrieved = Array.isArray(body.retrieved) ? body.retrieved.filter(r => r && r.text).slice(0, 8) : [];
    if (retrieved.length) {
      job.note('Searched your knowledge', retrieved.map(r => r.docName).filter(Boolean).slice(0, 4).join(', '));
      sys.push('Passages from the person\'s knowledge collections:\n' + retrieved.map(r => `--- ${r.docName || 'document'}\n${String(r.text).slice(0, 2500)}`).join('\n'));
    }

    /* 3b · images in the latest message: exact text first, then (if asked) build a page from it */
    const lastImages = media && Array.isArray(last.mediaIds) ? last.mediaIds.slice(0, 4) : [];
    const imageFiles = [];
    let ocrText = '';
    if (lastImages.length) {
      const codeHint = /\b(code|snippet|script|function|html|css|json|sql|terminal|command|error|stack|log)\b/i.test(String(last.content || ''));
      const parts = [];
      for (const id of lastImages) {
        let rec; try { rec = media.getMedia(store, id); } catch (_) { continue; }
        if (rec.kind !== 'image') continue;
        const file = media.filePath(dataDir, rec); imageFiles.push(file);
        const st = job.step('Reading the text in ' + (rec.originalName || 'the image'));
        try {
          const r = await ocr.recognize(file, { mode: codeHint ? 'code' : 'prose' });
          const lines = r.text.split('\n').filter(l => l.trim()).length;
          if (lines) { parts.push({ name: rec.originalName || 'image', text: r.text, code: codeHint || ocr.looksLikeCode(r.text) }); st.done(`${lines} line${lines === 1 ? '' : 's'} · ${r.engine === 'apple-vision' ? 'macOS text recognition' : r.engine}`); }
          else st.done('No text in this image');
        } catch (e) { st.fail(e); }
      }
      if (parts.length) {
        ocrText = parts.map(p => p.text).join('\n\n');
        sys.push('Text recognised in the attached image' + (parts.length > 1 ? 's' : '') + ' by text recognition on this Mac. These are the exact characters with the layout kept; use them for exact text and code, and the picture (if you can see it) for layout and meaning. When asked to extract code, reproduce it exactly from here, fixing only obvious recognition slips, in a code block.\n' + parts.map(p => `--- ${p.name}\n\`\`\`${p.code ? '' : 'text'}\n${p.text.slice(0, 12000)}\n\`\`\``).join('\n'));
      }
      if (caps.length && !canSee) {
        job.note(`${record.name || model} cannot see pictures`, ocrText ? 'It gets the recognised text instead. For layout and visual details pick a vision model (llama3.2-vision, qwen2.5-vl).' : 'Pick a vision model (llama3.2-vision, qwen2.5-vl) to work with pictures.');
        sys.push('The model you are running cannot see images; you only have the recognised text above. Say so if the person asks about visual details.');
      }
      if (imageFiles.length && imageToCode.wantsBuild(last.content)) {
        try {
          const build = await imageToCode.buildFromImage({ ollama, dataDir }, { model, imageFile: imageFiles[0], request: String(last.content).replace(/^\/build\s*/i, ''), canSee: canSee || !caps.length, ocrText, signal }, job);
          const pct = v => v == null ? null : Math.round(v * 100) + '%';
          const tries = build.attempts.length;
          const check = build.similarity != null
            ? `I checked it in a sandboxed browser (offline, fresh profile): it looks ${pct(build.similarity)} like your image${build.recall != null ? ` and has ${pct(build.recall)} of its text` : ''}. ${tries > 1 ? `I made ${tries} attempts and kept attempt ${build.best}.` : ''}`
            : 'I could not check it visually (no Chrome, Chromium, Edge or Brave found), so treat it as a first draft.';
          const intro = `Here is the page, built from your image. ${check}\n\nOpen it with **Open page** below, or copy the HTML:\n\n`;
          const body = intro + '```html\n' + build.html + '\n```';
          emit({ type: 'build', build: { ...build, html: undefined } });
          content = body;
          firstTokenAt = Date.now();
          emit({ type: 'token', text: body });
          const seconds = (Date.now() - started) / 1000;
          job.done({ buildId: build.id });
          emit({ type: 'steps', steps: job.job.steps, status: 'done' });
          emit({ type: 'done', content, stats: { ttft: firstTokenAt - started, tokens: Math.round(content.length / 4.2), tokPerSec: null, seconds: +seconds.toFixed(1), steps: job.job.steps.length } });
          return;
        } catch (e) {
          if (signal.aborted) throw e;
          job.note('Could not build the page', e.message);
          sys.push('You tried to build a page from the image but it failed: ' + e.message + '. Explain briefly and suggest what to try.');
        }
      }
    }

    /* 4 · the conversation */
    const roots = body.computer ? [...new Set([...computer.workspaceRoots(store), ...chatSources.folderRoots(store, sessionId).map(p => { try { return fs.realpathSync.native(p); } catch (_) { return null; } }).filter(Boolean)])] : [];
    const pol = computer.policy(store);
    const approveFolder = (args) => {
      const src = chatSources.add(store, dataDir, activity, { sessionId, kind: 'folder', path: computer.folderPath(args.path) });
      roots.push(src.origin);
      emit({ type: 'source', source: src });
      return { ok: true, summary: 'Approved ' + src.origin, output: `The person approved ${src.origin}. Commands and file tools now work there, and NOVA is reading its text files in the background.` };
    };
    const computerOn = Boolean(body.computer) && pol.enabled && canTools;
    if (body.computer && !pol.enabled) job.note('Computer access is off', 'Turn it on in Settings > Computer');
    else if (body.computer && !canTools) job.note(`${record.name || model} cannot use tools`, 'Answering without computer access. Pick a model with tool support (for example qwen2.5 or llama3.1) to let me use the Mac.');
    const system = [persona({ computerOn, roots, screen: pol.screen, today: new Date().toDateString() }), ...sys].join('\n\n');
    const convo = trimHistory(history, Math.max(6000, budget * 1.2)).map(m => {
      const out = { role: m.role, content: String(m.content || '') };
      if (Array.isArray(m.mediaIds) && m.mediaIds.length && media && (canSee || !caps.length)) out.images = media.imagesForChat(store, dataDir, m.mediaIds);
      return out;
    });
    let messages = [{ role: 'system', content: system }, ...convo];
    const options = body.options && typeof body.options === 'object' ? Object.fromEntries(Object.entries(body.options).filter(([, v]) => v != null)) : {};

    if (!computerOn) {
      /* 5a · plain streaming reply */
      const think = job.step('Thinking');
      const res = await ollama.chatStream(model, messages, options, signal);
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let evt; try { evt = JSON.parse(line); } catch (_) { continue; }
          if (evt.error) throw new Error(evt.error);
          const piece = (evt.message && evt.message.content) || '';
          if (piece) {
            if (firstTokenAt === null) { firstTokenAt = Date.now(); think.done(`${((firstTokenAt - started) / 1000).toFixed(1)} s`); job.step('Writing the reply'); }
            content += piece; emit({ type: 'token', text: piece });
          }
          if (evt.done) { evalCount = evt.eval_count || 0; evalDuration = evt.eval_duration || 0; }
        }
      }
    } else {
      /* 5b · reply that can use the computer */
      const tools = computer.toolSpecs({ screen: pol.screen });
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        const think = job.step(round === 0 ? 'Thinking' : 'Working out the next step');
        const res = await ollama.chatFull(model, messages, { tools, options, signal });
        evalCount += res.eval_count || 0; evalDuration += res.eval_duration || 0;
        const msg = res.message || { role: 'assistant', content: '' };
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!calls.length) {
          think.done();
          const final = String(msg.content || '').trim();
          content += final;
          job.step('Writing the reply');
          firstTokenAt = firstTokenAt || Date.now();
          // Reveal the finished text a few words at a time, so it reads like the plain replies.
          for (const piece of final.match(/\S+\s*/g) || []) { if (signal.aborted) break; emit({ type: 'token', text: piece }); await sleep(8); }
          break;
        }
        think.done(`${calls.length} action${calls.length === 1 ? '' : 's'} planned`);
        if (msg.content && String(msg.content).trim()) { const say = String(msg.content).trim() + '\n\n'; content += say; emit({ type: 'token', text: say }); }
        messages = [...messages, { role: 'assistant', content: msg.content || '', tool_calls: calls }];
        for (const call of calls) {
          const name = call.function && call.function.name;
          let args = call.function && call.function.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
          const d = computer.describe(name, args);
          const step = job.step(d.title, d.detail || '', { tool: name });
          let resultText, ctr = null;
          try {
            if (!computer.TOOLS.some(t => t.name === name)) throw new Error('Unknown tool ' + name);
            computer.checkHalt(store); // refuse before asking
            if (name === 'run_command') computer.checkCommand(args.command); // refuse before asking
            if (name === 'use_folder') {
              const want = computer.folderPath(args.path);
              if (!fs.existsSync(want) || !fs.statSync(want).isDirectory()) throw new Error('There is no folder at ' + want + '. Ask the person which folder they mean.');
              const real = fs.realpathSync.native(want);
              if (roots.includes(real)) { step.done('Already approved'); messages.push({ role: 'tool', content: real + ' is already approved. Go ahead.' }); continue; }
            }
            // Every computer action is an execution contract: plan → approval → execution → evidence.
            ctr = contracts.open(store, dataDir, { actor: { type: 'agent', id: model, label: 'NOVA (' + model + ')', onBehalfOf: 'local-operator' }, intent: d.title + (d.detail ? ': ' + d.detail : ''), context: { sessionId, round }, ...computer.contractFor(name, args), plan: { tool: name, args } });
            const ap = computer.approve(store, { sessionId, tool: name, args, signal, contract: ctr });
            if (ap.info) { contracts.link(store, ctr.id, { approvalId: ap.info.id }); step.update({ waiting: true, approvalId: ap.info.id, detail: d.detail }); emit({ type: 'approval', approval: ap.info }); }
            const decision = await ap.promise;
            step.update({ waiting: false, approvalId: null });
            const answered = contracts.get(store, ctr.id).approval; // a paired device may have answered already
            if (decision === 'deny') {
              if (!answered && !contracts.get(store, ctr.id).evidence) { if (signal.aborted) contracts.seal(store, dataDir, ctr.id, 'cancelled'); else contracts.approve(store, dataDir, ctr.id, 'deny', { via: 'nova-desktop' }); }
              ctr = null;
              step.update({ status: 'failed', detail: 'You declined' }); resultText = 'The person declined this action. Do not try it again; ask what they would prefer.';
            }
            else {
              if (ap.auto) { step.update({ note: ap.auto }); contracts.autoApprove(store, dataDir, ctr.id, ap.auto, /chat/i.test(ap.auto) ? 'chat-always-allow' : 'auto-read'); }
              else if (!answered) contracts.approve(store, dataDir, ctr.id, 'allow', { via: decision === 'always' ? 'nova-desktop (always in this chat)' : 'nova-desktop' });
              contracts.begin(store, ctr.id, { adapter: 'desktop.computer' });
              const r = name === 'use_folder' ? approveFolder(args) : await computer.execute(name, args, { store, dataDir, sessionId, roots, signal });
              contracts.observe(store, ctr.id, { ok: r.ok !== false, summary: r.summary, output: r.output });
              contracts.seal(store, dataDir, ctr.id); ctr = null;
              step.done(r.summary + (name === 'run_command' || name === 'read_file' || name === 'list_files' || name === 'clipboard_read' ? '\n' + r.output.slice(0, 1500) : ''));
              resultText = r.output;
              if (r.image) {
                emit({ type: 'image', url: r.image.url, caption: r.summary });
                if (canSee) messages.push({ role: 'tool', content: resultText }, { role: 'user', content: 'Here is the screenshot you took.', images: [fs.readFileSync(r.image.file).toString('base64')] });
                else resultText += ' (This model cannot see images, so describe to the person what you need them to check, or use commands instead.)';
                if (canSee) { continue; }
              }
            }
          } catch (e) {
            if (ctr) { try { const c = contracts.get(store, ctr.id); if (!c.evidence) { if (c.execution) contracts.observe(store, ctr.id, { ok: false, error: e.message }); contracts.seal(store, dataDir, ctr.id, c.execution ? 'failed' : 'cancelled'); } } catch (_) {} ctr = null; }
            if (signal.aborted) throw e;
            step.fail(e);
            resultText = 'That did not work: ' + e.message;
          }
          messages.push({ role: 'tool', content: String(resultText).slice(0, 20000) });
        }
        if (round === MAX_ROUNDS - 1) {
          const note = '\n\nI stopped after ' + MAX_ROUNDS + ' rounds of actions. Tell me if you want me to keep going.';
          content += note; emit({ type: 'token', text: note });
        }
      }
    }

    const seconds = (Date.now() - started) / 1000;
    const stats = { ttft: firstTokenAt ? firstTokenAt - started : null, tokens: evalCount || Math.round(content.length / 4.2), tokPerSec: evalCount && evalDuration ? +(evalCount / (evalDuration / 1e9)).toFixed(1) : null, seconds: +seconds.toFixed(1), steps: job.job.steps.length };
    job.done({ chars: content.length });
    emit({ type: 'steps', steps: job.job.steps, status: 'done' });
    emit({ type: 'done', content, stats });

    /* 6 · suggested follow-ups (after the reply is already on screen) */
    if (body.followups !== false && content.length > 60 && !signal.aborted) {
      try {
        const r = await ollama.chatFull(model, [
          { role: 'system', content: 'Suggest what the person might ask next. Reply with JSON only: {"followups": ["…", "…", "…"]}. Three short questions or requests (at most 9 words each), in the person\'s language, written as the person would type them.' },
          { role: 'user', content: `They asked: ${String(last.content).slice(0, 800)}\n\nYou answered: ${content.slice(0, 1500)}` },
        ], { format: 'json', options: { temperature: 0.4, num_predict: 120 }, signal: AbortSignal.any([clientSignal, AbortSignal.timeout(20000)].filter(Boolean)) });
        const parsed = JSON.parse(String(r.message && r.message.content || '{}'));
        const items = (Array.isArray(parsed.followups) ? parsed.followups : []).map(x => String(x).trim()).filter(x => x && x.length < 90).slice(0, 3);
        if (items.length) emit({ type: 'followups', items });
      } catch (_) { /* suggestions are optional */ }
    }
  } catch (e) {
    const cancelled = e.name === 'AbortError' || signal.aborted;
    job.fail(cancelled ? new Error('Cancelled') : e);
    emit({ type: 'steps', steps: job.job.steps, status: cancelled ? 'cancelled' : 'failed' });
    if (cancelled) emit({ type: 'done', content, cancelled: true, stats: { seconds: +((Date.now() - started) / 1000).toFixed(1) } });
    else emit({ type: 'error', error: e.message || String(e), content });
  } finally { off(); }
}

module.exports = { runTurn, persona, trimHistory };
