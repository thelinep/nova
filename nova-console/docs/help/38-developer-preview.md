---
id: developer-preview
title: Built, not yet in the console
section: Oversight
order: 38
summary: Parts of NOVA that are built and tested but not started from the console yet — connectors and the secrets vault, the multi-agent system, the correctness pipeline, autonomy runs and release evidence — and how developers can try them.
keywords: developer preview connectors github secrets vault encrypted multi-agent supervisor delegation correctness pipeline constellation router test synthesis semantic vote clover dafny proof autonomy neuron factory release evidence l2 certification demo scripts
views:
---
These parts of NOVA are complete and covered by tests. They report into [Workbench](help:workbench) and follow the [policies, budgets and kill switch](help:safety-controls). There is no button for them in the console yet. Until there is, developers can run them from NOVA's source folder with the demo scripts below.

## Connectors and the secrets vault

- **Connectors** let NOVA act on outside services. The first one is **GitHub**: check who you are signed in as, read a repository, list and create issues, read and open pull requests, read check results, and merge a pull request.
- Each connector has a profile with **scopes** (what it may do), and can be enabled, disabled or revoked.
- Every action goes through a policy. Actions that need a person wait in Workbench → **Waiting** for **approve** or **deny**.
- Tokens are kept in the **secrets vault**, encrypted with AES-256-GCM. The key is a file in NOVA's data folder that only your user account can read (`.secret-master-key`). Secrets can be rotated and revoked, and are never shown again after saving.

Try it: `node scripts/connector-demo.js`.

There is also a second, simpler GitHub path for Local Workspace. Prepare a pull request draft under **Git delivery** and review it there. NOVA can then open the pull request with the `gh` command-line tool and check its CI results, using a token saved through NOVA's local `/api/secrets` service. The console has no button for that last step yet. The two connector designs will be combined into one. It uses a pretend GitHub unless you set `GITHUB_TOKEN`, `GITHUB_OWNER` and `GITHUB_REPO`.

## The multi-agent system

This is a deeper system than the Agents screen ([Agents](help:agents)), built for agents that work on their own over time:

| Part | What it does |
| --- | --- |
| Agent registry | Named roles with instructions, a preferred model, allowed tools and a supervisor |
| Memory | Each agent remembers across runs: private, shared, or visible to its supervisor |
| Tasks | Shared task list; agents hand work to each other |
| Budgets | Limits for each agent; sub-agents count against their parent |
| Tool permissions | Each agent may use only the tools it is given |
| Supervisor | Agents escalate to a supervisor, which approves, denies or forwards the question further up |
| Job bridge | Agent tasks run as background jobs on your Ollama models |

Try it: `node scripts/multi-agent-demo.js`.

## The correctness pipeline

A way to get code that is checked, not just generated:

1. **Several models answer** the same problem.
2. **Tests are written** for it automatically, and answers that agree in behaviour are grouped (semantic voting).
3. The best answer is chosen.
4. Optionally, it is **proved** correct with the Dafny verifier (Clover checks that the code, its description and its proof agree).

Verified results appear in Workbench → **Pipeline**, and count towards step 5 of [the setup checklist](help:getting-started-checklist). Proofs need Dafny installed (`brew install dafny`); set `NOVA_DAFNY_BIN` if it is somewhere unusual.

Try it: `node scripts/constellation-demo.js` and `node scripts/clover-demo.js`.

## Autonomy runs

Bounded loops that improve something on their own and keep the result only if it passes:

- **Workspace patches:** apply a patch on a separate branch (`nova/auto`), run the tests, commit if they pass. It never pushes.
- **Small trained models:** train, evaluate, and keep the model only if it beats the acceptance threshold.

Before every step a loop checks the kill switch, its policy and its budget. A failure is quarantined and rolled back. Escalations wait for you in Workbench.

## Release gates

A release counts as ready only when each of these has current evidence on file: test results, the list of built files, code signing, Apple notarisation, a clean install, and the update manifest. Evidence is recorded with a fingerprint of the file. If a file changes or goes missing after it was recorded, the gate fails again.

Check with `npm run release:check` (it exits with an error until every gate passes), or in the app at `/api/release/check`.

## Release evidence

`node scripts/l2-check.js` checks that a release meets NOVA's certification requirements and writes a bundle of the evidence with a fingerprint (hash) of every test result and record, so later changes can be detected. The files in `baseline/` and `docs/release-evidence/` are earlier results.

## Before you run a demo

- Run demos from the `nova-console` folder **with the desktop app closed**. They use `nova-console/data`, the database of the browser development mode (`npm start`), not the app's database.
- Some demos replace their own earlier demo records each time they run.
