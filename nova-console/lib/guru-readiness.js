'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const RECIPE_RELATIVE = 'experiments/recipes/qwen25_coder_15b_lora_sft.v1.json';
const MODEL_RELATIVE = 'data/coding/model.json';

function sourceEvidence(repoRoot, relativePath, detail) {
  return { path: path.relative(repoRoot, path.join(repoRoot, 'guru', relativePath)).replaceAll(path.sep, '/'), detail };
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function item(id, label, status, summary, evidence, blockers = []) {
  return { id, label, status, summary, evidence, blockers };
}

function trainerStackEntry({ root, guruRoot, recipe, python, run }) {
  const evidence = (relative, detail) => sourceEvidence(root, relative, detail);
  const lockRelative = recipe?.training_stack?.lockfile || 'requirements-test-full.lock';
  const evidencePaths = [
    evidence('guru/training_stack_inspector.py', 'Metadata-only local Python/package stack inspector; it does not load model artifacts or train.'),
    evidence(lockRelative, 'Pinned training package lock whose digest and package count are reported by the preflight.'),
    evidence(RECIPE_RELATIVE, 'Expected Python version and lock digest/count source.'),
  ];
  const unavailable = (status, summary, blocker) => item(
    'trainer_environment', 'Trainer environment', status, summary, evidencePaths, [blocker],
  );

  let result;
  try {
    result = run(python, ['-m', 'guru', 'trainer-stack-preflight'], {
      cwd: guruRoot,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONPATH: [guruRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return unavailable('unavailable', 'Guru trainer-stack preflight could not start because Python is unavailable.', `Python runtime '${python}' is not installed or not on PATH.`);
    if (error?.code === 'ETIMEDOUT') return unavailable('unavailable', 'Guru trainer-stack preflight exceeded its time limit.', 'Trainer-stack preflight timed out.');
    return unavailable('unavailable', 'Guru trainer-stack preflight could not run.', `Trainer-stack preflight could not run: ${error?.message || 'unknown error'}`);
  }
  if (result.error?.code === 'ENOENT') return unavailable('unavailable', 'Guru trainer-stack preflight could not start because Python is unavailable.', `Python runtime '${python}' is not installed or not on PATH.`);
  if (result.error?.code === 'ETIMEDOUT') return unavailable('unavailable', 'Guru trainer-stack preflight exceeded its time limit.', 'Trainer-stack preflight timed out.');
  if (result.error) return unavailable('unavailable', 'Guru trainer-stack preflight could not run.', `Trainer-stack preflight could not run: ${result.error.message}`);

  let report;
  try { report = JSON.parse(String(result.stdout || '')); }
  catch (_) {
    const stderr = String(result.stderr || '');
    const missingModule = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/.exec(stderr);
    if (missingModule) {
      return unavailable('unavailable', `Guru trainer-stack runtime is unavailable: required module '${missingModule[1]}' is missing.`, `Guru Python runtime is missing required module '${missingModule[1]}'.`);
    }
    if (/ImportError:/.test(stderr)) {
      return unavailable('unavailable', 'Guru trainer-stack runtime is unavailable because a required dependency could not be imported.', 'A required Guru trainer-stack dependency could not be imported.');
    }
    return unavailable('unavailable', 'Guru trainer-stack preflight did not return readable JSON evidence.', 'Trainer-stack preflight returned malformed JSON.');
  }
  const validReport = report && typeof report === 'object' && !Array.isArray(report)
    && ['blocked', 'metadata_match'].includes(report.training_stack_status)
    && Array.isArray(report.blockers) && report.blockers.every(value => typeof value === 'string')
    && Array.isArray(report.mismatches) && report.mismatches.every(value => typeof value === 'string')
    && (report.lock_sha256 === null || (typeof report.lock_sha256 === 'string' && /^[a-f0-9]{64}$/.test(report.lock_sha256)))
    && Number.isInteger(report.locked_package_count) && report.locked_package_count >= 0
    && report.selected_model_compatibility === 'unverified_without_exact_artifacts'
    && (report.training_stack_status !== 'metadata_match'
      || (report.blockers.length === 0 && report.mismatches.length === 0
        && report.lock_sha256 !== null && report.locked_package_count > 0))
    && (report.training_stack_status !== 'blocked' || report.blockers.length > 0);
  if (!validReport) return unavailable('unavailable', 'Guru trainer-stack preflight returned JSON that does not match its evidence contract.', 'Trainer-stack preflight returned malformed or incomplete JSON evidence.');
  if (result.status !== 0 && result.status !== 1) {
    return unavailable('unavailable', 'Guru trainer-stack preflight exited with an unexpected status.', `Trainer-stack preflight exited unexpectedly with status ${result.status}.`);
  }
  if ((result.status === 0) !== (report.training_stack_status === 'metadata_match')) {
    return unavailable('unavailable', 'Guru trainer-stack preflight exit status conflicts with its report.', `Trainer-stack preflight exit status ${result.status} conflicts with ${report.training_stack_status}.`);
  }
  if (report.model_weights_loaded !== false || report.tokenizer_loaded !== false || report.training_started !== false) {
    return unavailable('unavailable', 'Guru trainer-stack preflight did not preserve its non-launching safety contract.', 'Trainer-stack evidence claims model loading or training occurred.');
  }
  const status = report.training_stack_status === 'metadata_match' ? 'ready' : 'blocked';
  const detail = `Stack ${report.training_stack_status}; ${report.locked_package_count} locked packages; lock SHA-256 ${report.lock_sha256 || 'unavailable'}; selected-model compatibility remains unverified without exact artifacts.`;
  return item('trainer_environment', 'Trainer environment', status, detail, evidencePaths, report.blockers);
}

function createGuruReadiness({ repoRoot, python = 'python3', run = spawnSync } = {}) {
  const root = path.resolve(repoRoot || path.join(__dirname, '..', '..'));
  const guruRoot = path.join(root, 'guru');
  const recipePath = path.join(guruRoot, RECIPE_RELATIVE);
  const modelPath = path.join(guruRoot, MODEL_RELATIVE);
  const evidence = (relative, detail) => sourceEvidence(root, relative, detail);
  let recipe = null;
  let model = null;
  try { recipe = parseJsonFile(recipePath); } catch (_) { recipe = null; }
  try { model = parseJsonFile(modelPath); } catch (_) { model = null; }

  const preflight = run(python, ['-m', 'guru.corpus.cli', 'preflight', 'c_rd'], {
    cwd: guruRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONPATH: [guruRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  let preflightReport = null;
  let preflightError = '';
  if (preflight.error?.code === 'ENOENT') {
    preflightError = `Python runtime '${python}' is not installed or not on PATH.`;
  } else if (preflight.error) {
    preflightError = `Python preflight could not run: ${preflight.error.message}`;
  } else {
    try { preflightReport = JSON.parse(String(preflight.stdout || '')); }
    catch (_) {
      const stderr = String(preflight.stderr || '');
      const missingModule = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/.exec(stderr);
      preflightError = missingModule
        ? `Guru Python runtime is unavailable: required module '${missingModule[1]}' is missing.`
        : /ImportError:/.test(stderr) ? 'Guru Python runtime is unavailable: a required Guru dependency could not be imported.'
          : 'Guru corpus preflight did not return readable JSON evidence.';
    }
    if (preflightReport && preflight.status !== 0 && preflight.status !== 1) {
      preflightError = `Guru corpus preflight exited unexpectedly with status ${preflight.status}.`;
      preflightReport = null;
    }
  }

  const entries = [];
  if (preflightReport) {
    const blockers = Array.isArray(preflightReport.blockers) ? preflightReport.blockers : [];
    const status = preflightReport.ready === true ? 'ready' : 'blocked';
    entries.push(item('corpus_admission', 'Corpus and admission', status,
      preflightReport.ready === true ? 'Corpus preflight passed. This checks assembler inputs only; it is not a release approval.' : 'Corpus preflight is blocked by missing or invalid admission evidence.',
      [evidence('data/coding/tasks.jsonl', 'Task manifest read by c_rd preflight.'), evidence('data/coding/teacher-registry.jsonl', 'Teacher registry read by c_rd preflight.'), evidence('audit/quality.jsonl', 'Admission audit required by c_rd preflight.')], blockers));
  } else {
    entries.push(item('corpus_admission', 'Corpus and admission', 'unavailable', preflightError || 'Guru Python preflight evidence is unavailable.',
      [evidence('guru/corpus/cli.py', 'Preflight command source.'), evidence('data/coding/tasks.jsonl', 'Task manifest path.')], ['Could not determine current corpus admission state.']));
  }

  entries.push(trainerStackEntry({ root, guruRoot, recipe, python, run }));

  if (!recipe) {
    entries.push(item('student_model', 'Exact student model and tokenizer', 'unavailable', 'The checked-in D3 recipe could not be read.', [evidence(RECIPE_RELATIVE, 'Selected student and digest pins.')], ['Recipe unavailable or invalid JSON.']));
    entries.push(item('training_recipe', 'Training recipe', 'unavailable', 'The checked-in D3 recipe could not be read.', [evidence(RECIPE_RELATIVE, 'Draft recipe and training-stack pins.')], ['Recipe unavailable or invalid JSON.']));
    entries.push(item('evaluator', 'Evaluator qualification', 'unavailable', 'Recipe evidence is unavailable; evaluator qualification cannot be inferred.', [evidence(RECIPE_RELATIVE, 'Evaluator gate and evaluator config digest.')], ['Could not determine evaluator gate state.']));
    entries.push(item('compute', 'Training compute approval', 'unavailable', 'Recipe evidence is unavailable; compute approval cannot be inferred.', [evidence(RECIPE_RELATIVE, 'Compute gate.')], ['Could not determine compute approval state.']));
  } else {
    const base = recipe.base_model || {};
    const modelBlockers = [];
    if (!base.model_id || !base.revision) modelBlockers.push('Selected model identity or immutable revision is missing.');
    if (!base.weights_sha256) modelBlockers.push('Exact base-weight digest is missing.');
    if (!base.tokenizer_sha256) modelBlockers.push('Exact tokenizer digest is missing.');
    if (recipe.gates?.model_intake_approved !== true) modelBlockers.push('Model intake is not approved.');
    const modelStatus = !base.model_id || !base.revision ? 'blocked' : modelBlockers.length ? 'unverified' : 'ready';
    entries.push(item('student_model', 'Exact student model and tokenizer', modelStatus,
      modelBlockers.length ? `${base.model_id || 'Student candidate'} is selected, but exact artifact identity/intake is pending.` : 'Exact model and tokenizer pins and intake approval are present.',
      [evidence(RECIPE_RELATIVE, `Candidate: ${base.model_id || 'missing'} at revision ${base.revision || 'missing'}; weights/tokenizer digests and model-intake gate.`)], modelBlockers));

    const recipeBlockers = [];
    if (recipe.status !== 'launchable') recipeBlockers.push(`Recipe status is ${recipe.status || 'missing'}; it is not launchable.`);
    if (recipe.hyperparameters_status !== 'qualified') recipeBlockers.push(`Hyperparameters are ${recipe.hyperparameters_status || 'unqualified'}.`);
    if (!recipe.sft?.training_data_manifest_sha256) recipeBlockers.push('Approved training data manifest digest is missing.');
    if (!recipe.sft?.validation_suite_sha256) recipeBlockers.push('Validation suite digest is missing.');
    if (!recipe.training_stack?.lockfile || !recipe.training_stack?.lockfile_sha256) recipeBlockers.push('Pinned training lock is incomplete.');
    else {
      try {
        const lockPath = path.join(guruRoot, recipe.training_stack.lockfile);
        const lockDigest = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
        if (lockDigest !== recipe.training_stack.lockfile_sha256) recipeBlockers.push('Training lock digest does not match the checked-in lock file.');
      } catch (_) { recipeBlockers.push('Pinned training lock file is unavailable.'); }
    }
    entries.push(item('training_recipe', 'Training recipe', recipeBlockers.length ? 'blocked' : 'ready',
      recipeBlockers.length ? 'The checked-in D3 recipe is a proposal with unqualified settings and missing evidence pins.' : 'Recipe and training dependencies are pinned and qualified.',
      [evidence(RECIPE_RELATIVE, `Status ${recipe.status || 'missing'}; hyperparameters ${recipe.hyperparameters_status || 'missing'}; stack ${recipe.training_stack?.python || 'unavailable'}/${recipe.training_stack?.torch || 'unavailable'}/${recipe.training_stack?.transformers || 'unavailable'}/${recipe.training_stack?.peft || 'unavailable'}.`)], recipeBlockers));

    const enginePath = path.join(guruRoot, 'guru', 'qwen2_lora_engine.py');
    const inspectorPath = path.join(guruRoot, 'guru', 'model_artifact_inspector.py');
    const trainerPresent = fs.existsSync(enginePath) && fs.existsSync(inspectorPath);
    entries.push(item('trainer_compatibility', 'Selected-model trainer compatibility', trainerPresent ? 'unverified' : 'unavailable',
      trainerPresent
        ? 'A gated Qwen2 LoRA mechanics scaffold and metadata-only artifact inspector exist; there is no inspector-to-loader binding or exact selected-artifact compatibility run.'
        : 'Selected-model trainer or artifact inspection code is unavailable.',
      [evidence('guru/qwen2_lora_engine.py', 'Qwen2-family adapter and trainer mechanics; no local model loader.'), evidence('guru/model_artifact_inspector.py', 'Local-only metadata inventory checks; no model loading.')],
      trainerPresent
        ? ['Local-only model/tokenizer loader is not integrated with the inventory inspector.', 'The selected weights and tokenizer have not been loaded or compatibility-tested.']
        : ['Could not determine selected-model trainer compatibility.']));

    const evaluatorBlockers = [];
    if (recipe.gates?.evaluator_qualified !== true) evaluatorBlockers.push('Disposable evaluator is not qualified.');
    if (!recipe.sft?.evaluator_config_sha256) evaluatorBlockers.push('Qualified evaluator configuration digest is missing.');
    entries.push(item('evaluator', 'Isolated evaluator', evaluatorBlockers.length ? 'blocked' : 'ready',
      evaluatorBlockers.length ? 'Executable correctness is not qualified for training or coding claims.' : 'A pinned evaluator qualification is present.',
      [evidence(RECIPE_RELATIVE, 'Evaluator gate and evaluator config digest.'), evidence('CODING_RELEASE.md', 'Release limitations and evaluator qualification requirements.')], evaluatorBlockers));

    const computeBlockers = [];
    if (recipe.gates?.compute_approved !== true) computeBlockers.push('Training compute is not approved in the D3 recipe.');
    entries.push(item('compute', 'Training compute approval', computeBlockers.length ? 'blocked' : 'ready',
      computeBlockers.length ? 'No launch-approved training host/account is recorded in the recipe.' : 'Training compute approval is recorded.',
      [evidence(RECIPE_RELATIVE, 'Compute gate and pinned stack.'), evidence('GURU_CODE_ATOMIC_PLAN.md', 'Owner compute decision and resource qualification state.')], computeBlockers));
  }

  const checkpointBlockers = [];
  if (!model) checkpointBlockers.push('Guru model metadata is unavailable.');
  else {
    if (!model.trained_checkpoint) checkpointBlockers.push('No trained Guru-Code checkpoint is recorded.');
    if (model.coding_capability_established !== true) checkpointBlockers.push('Exact-model coding capability is not established.');
    if (!model.verified_context_tokens || model.verified_context_tokens < 4096) checkpointBlockers.push('Minimum 4096-token context is not verified.');
  }
  entries.push(item('checkpoint_qualification', 'Checkpoint qualification', checkpointBlockers.length ? 'blocked' : 'ready',
    checkpointBlockers.length ? 'Guru-Code has no qualified checkpoint available to Maataa.' : 'Exact checkpoint and coding qualification evidence are present.',
    [evidence('data/coding/model.json', 'Checkpoint, capability, and verified context record.'), evidence('CODING_RELEASE.md', 'Exact artifact qualification requirements.')], checkpointBlockers));

  const statuses = entries.map(entry => entry.status);
  const overall = statuses.includes('blocked') ? 'blocked' : statuses.includes('unavailable') ? 'unavailable' : statuses.includes('unverified') ? 'unverified' : 'ready';
  return {
    schema: 'maataa-guru-readiness-v1',
    generated_at: new Date().toISOString(),
    status: overall,
    action: { enabled: false, label: 'Guru-Code selection and dispatch', reason: 'This evidence matrix is read-only and does not authorize Guru-Code use.' },
    entries,
    limitations: ['Read-only local evidence only.', 'No model download, model loading, training, approval, or gate mutation occurs.', 'A green corpus preflight is not release readiness.'],
  };
}

module.exports = { createGuruReadiness };
