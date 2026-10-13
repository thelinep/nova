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
