---
id: coding-studio
title: Coding Studio
section: Local Workspace
order: 41
summary: Give one approved project a coding task, check the selected local model, and review its proposed changes before Maataa applies them.
keywords: coding studio Guru-Code code plan model qualification approved project patch proposal review diff checks batch approval apply rollback Brahmi comments explanations agents
views: codingstudio
---
Coding Studio helps you ask a local model for a bounded change in one project you approved. It is a task and review surface, not a full code editor.

## Choose a project and model

Only folders already approved in **Local Workspace** appear in the project list. If the list is empty, open Local Workspace, choose a folder and approve it.

Choose an installed Ollama model and write a specific request that names the file and expected behavior. **Check readiness** is read-only: Maataa checks that this exact model version is qualified for the request, supports the workflow, and has enough usable context. A model that is not qualified stays blocked; open **Models** and run **Qualify for coding** on that exact model.

## Create and review a proposal

After readiness passes, press **Create proposal**. Maataa sends bounded project context and the selected model to its existing code planner. The planner must use the model you selected; it cannot silently substitute another model. A successful result is a saved change proposal or multi-file batch. No project file is changed at this stage.

Press **Review exact diff and checks in Local Workspace** to inspect the existing review flow. Maataa validates the proposed changes in an isolated copy. **Approve exact batch** appears only after validation passes; **Apply atomically** appears only after your approval. Applied batches can be rolled back while their files have not changed since application.

If the project or request changes after the readiness check, check readiness again. If planning reports stale source, an unavailable model, or invalid output, the proposal remains blocked and the project is not written.

## Brahmi and Guru-Code status

The optional Brahmi setting asks for comments and explanatory text in Brahmi. Programming syntax, keywords and identifiers remain conventional. This output is experimental and may be incomplete; inspect the exact diff and run suitable project checks.

The Studio reports Guru-Code as experimental until a trained checkpoint and coding capability are established. An exported Guru model is usable only after Maataa qualifies that exact Ollama model version. General Guru models do not gain coding status merely from their name.

## Multi-agent readiness

The team panel reads the current agent and task ledger. It reports execution and human-review gates from Maataa, but does not dispatch, resume, approve or write agent work. When either gate is unavailable, the Studio names the blocker rather than implying that a team is running.
