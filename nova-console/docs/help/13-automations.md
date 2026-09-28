---
id: automations
title: Automations and Evaluations
section: Chat and knowledge
order: 13
summary: Run prompts, skills or workflows on a schedule, and compare models on a fixed benchmark.
keywords: automations schedule cron daily weekly run now draft enable evaluations benchmark compare accuracy latency
views: automations,evaluations
---
## Automations

An automation runs a prompt, skill or workflow on a schedule (every N minutes, daily, weekly), when a document is added to a collection, or on demand.

1. Create an automation. It starts as **Draft**.
2. Set its prompt or target, trigger, model and knowledge collections.
3. Press **Run now** to test it, and read the output in its run history.
4. **Enable** it once the test does what you want.

@screen media/automations.jpg "Automations with their triggers and last runs."

An enabled automation that was due while NOVA was closed runs after NOVA starts. Return it to Draft before changing its model, prompt or collections. Failed and cancelled runs stay in its history.

## Evaluations

**Evaluations** compares models on NOVA's fixed benchmark datasets: accuracy, latency and throughput side by side. Sync the models first, and compare runs that used the same dataset and comparable settings. A score describes that benchmark, not a model's general accuracy or safety.

@screen media/evaluations.jpg "Evaluations: two models compared on the same dataset."
