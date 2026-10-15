---
id: coding-studio
title: Coding Studio
section: Local Workspace
order: 41
summary: Build a new app from a description, or give an approved project a coding task; a qualified local model writes the code, tests run, and you approve before anything is applied.
keywords: coding studio app builder new app build an app tip calculator website api react template Maataa Projects start coding Guru-Code code plan model qualification approved project patch proposal review diff checks batch approval apply rollback Brahmi comments explanations agents
views: codingstudio
---
Coding Studio helps you build new apps and change existing ones with a local model. It is a task and review surface, not a full code editor.

## Start with one click

Double-click **Maataa** in the brahmini folder and choose **Start coding** (the same script is `launchers/Maataa - Start coding.command`). It does five things:

- starts Ollama and Maataa;
- installs the coding model `qwen2.5-coder:7b` when there is enough disk space (about 4.7 GB), or offers a model you already have;
- approves **~/Maataa Projects** as the folder new apps go into;
- offers to run the coding checks;
- opens Coding Studio.

## Build a new app

1. Under **Build a new app**, describe the app in any language. For example: *A tip calculator: enter the bill and the number of people, and show each share*, or *एक नोट्स वेबसाइट जिसमें खोज हो*.
2. Leave **Starting point** on automatic, or choose one:
   - **Static website**: HTML, CSS and JavaScript; runs without installing anything.
   - **Node API**: a JSON API.
   - **React**: needs `npm install` with network access on before it runs.
3. Press **Prepare the plan**. This writes nothing. It shows the folder that will be created, the template files and the exact request the model will receive.
4. Press **Create the project and start building**. Maataa then:
   - creates the folder from the template, with git;
   - allows only that project's `test`, `dev`, `build` and `git-status` commands;
   - runs the development loop in a copy: the model writes the code, `npm test` runs, and if tests fail their output goes back to the model for the next attempt (up to 5 attempts).
5. When the tests pass, review the changed files. To see the exact diff, open **See the exact diff in Local Workspace**. Then press **Approve this exact batch** and **Apply to the project**. You can roll the batch back from Local Workspace.
6. Press **Run the app** to start its dev server, then use the **Open** link. To keep going, press **Ask for the next change**: the same project and model are selected in the task form below.

You can also ask in Chat, for example *Build me a todo app with dark mode* or *मेरे लिए एक टिप कैलकुलेटर ऐप बनाओ*. Maataa prepares the same plan and opens Coding Studio; nothing is written until you start it and approve the result.

The model must have passed the coding checks for multi-file work. If it has not, the App Builder names it and offers **Run coding checks now**. The checks are 18 local runs that take about 10–30 minutes; follow them in Activity.


## Choose a project and model

Only folders already approved in **Local Workspace** appear in the project list. If the list is empty, open Local Workspace, choose a folder and approve it.

Choose an installed Ollama model and write a specific request that names the file and expected behavior. **Check readiness** is read-only: Maataa checks that this exact model version is qualified for the request, supports the workflow, and has enough usable context. A model that is not qualified stays blocked; open **Models** and run **Qualify for coding** on that exact model.

## Create and review a proposal

After readiness passes, press **Create proposal**. Maataa sends bounded project context and the selected model to its existing code planner. The planner must use the model you selected; it cannot silently substitute another model. A successful result is a saved change proposal or multi-file batch. No project file is changed at this stage.

Press **Review exact diff and checks in Local Workspace** to inspect the existing review flow. Maataa validates the proposed changes in an isolated copy. **Approve exact batch** appears only after validation passes; **Apply atomically** appears only after your approval. Applied batches can be rolled back while their files have not changed since application.

If the project or request changes after the readiness check, check readiness again. If planning reports stale source, an unavailable model, or invalid output, the proposal remains blocked and the project is not written.

## Run tests and refine a change

For an existing project, **Run tests and refine** uses its own approved
development loop. The project's `test` command must first be explicitly
allowlisted in Local Workspace for that exact folder. The loop runs the
baseline tests, then gives the selected local model up to three bounded
attempts in a private working copy. You can inspect the baseline and attempt
outputs, cancel a running loop, and reopen a saved loop after navigating away
or reloading Coding Studio.

If the tests pass, Maataa prepares a normal change batch from the private copy.
Open it in Local Workspace, validate the full batch, approve that exact batch,
and apply it as separate steps. A passing test loop does not itself approve or
write to the project. Failed, cancelled, interrupted, or conflicting loops do
not create an applied project change.

## Brahmi and Guru-Code status

The optional Brahmi setting asks for comments and explanatory text in Brahmi. Programming syntax, keywords and identifiers remain conventional. This output is experimental and may be incomplete; inspect the exact diff and run suitable project checks.

The Studio reports Guru-Code as experimental until a trained checkpoint and coding capability are established. The four owner decisions that unlock it are in `guru/decisions/README.md`. An exported Guru model is usable only after Maataa qualifies that exact Ollama model version. General Guru models do not gain coding status merely from their name.

## Multi-agent readiness

The team panel reads the current agent and task ledger. It reports execution and human-review gates from Maataa, but does not dispatch, resume, approve or write agent work. When either gate is unavailable, the Studio names the blocker rather than implying that a team is running.
