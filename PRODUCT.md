# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Assumption for this implementation: one local developer/operator working in project folders they explicitly approve. The current Maataa Workstation is a local single-user application; shared or multi-user projects are outside this Studio's first-release scope.

## Product Purpose

Maataa Workstation is a local AI workspace. Coding Studio helps its operator understand and change an approved software project with a locally available model, inspect proposed edits, run explicitly allowed checks, and review Git delivery.

## Positioning

Coding is model-assisted but operator-governed: Maataa controls project access, validates model proposals, and requires the operator to approve project writes and Git delivery.

## Operating Context

The operator works with local project folders and locally available Ollama models. Guru is a separate model-development package in this repository and can export models to Ollama. The Studio must not depend on Brahmini Knowledge Collector being installed.

## Capabilities and Constraints

- Maataa already supports approved workspace roots, bounded code proposals, reviewable change batches, isolated validation, atomic application and rollback, command allowlists, development loops, and reviewed Git actions.
- Guru currently provides general language models, tokenizer/training/export tooling, and Guru-Lipi script conversion. No Guru-Code checkpoint or coding capability is established by this product note.
- The first Studio release is a one-project coding task/review/check flow, not a full source-code editor.
- Guru-Code must be a distinct, code-focused model target. It becomes eligible for coding plans only after Maataa's exact-version coding qualification passes.
- Models propose changes; Maataa owns project reads/writes, command execution, and Git operations. The operator approves each write batch and each delivery action.
- Programming syntax remains conventional. Brahmi comments and explanations are the initial script-support target. Brahmi identifiers are out of scope until language and tool compatibility is demonstrated.
- Coding data requires source, license, and transformation provenance. User project content is not training data unless the operator explicitly opts it in.
- Guru's documented model context sizes currently fall below or at Maataa's minimum; training scale, model quality, and compute remain open gates.

## Brand Commitments

Use the product name Maataa Workstation in user-facing surfaces. Guru-Code is a distinct model target within Guru. NOVA may remain in internal package names and compatibility identifiers.

## Evidence on Hand

- Maataa Local Workspace code-planning, batch review, command, and Git flows: `nova-console/lib/code-planner.js`, `nova-console/lib/workspace-changes.js`, `nova-console/lib/workspace-runner.js`, and `nova-console/lib/workspace-git.js`.
- Guru model/training/export documentation: `guru/README.md`.
- Existing product help: `nova-console/docs/help/40-workspace.md`, `nova-console/docs/help/11-models.md`, and `nova-console/docs/help/38-developer-preview.md`.
- No trained Guru-Code model or measured code-generation benchmark is currently established.

## Product Principles

- Keep project access explicit and revocable.
- Make model proposals inspectable before any project write.
- Preserve a single governed path for applying, testing, and delivering changes.
- Distinguish model capability evidence from training infrastructure or successful exports.
- Keep the first release focused on one local project and one reviewable task flow.

## Accessibility & Inclusion

The Studio should support keyboard operation, visible focus, readable contrast, responsive layouts, and clear non-technical status and recovery copy.
