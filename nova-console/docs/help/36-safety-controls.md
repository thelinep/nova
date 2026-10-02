---
id: safety-controls
title: Policies, budgets and rollback
section: Oversight
order: 36
summary: The rules that decide what NOVA's background work may do — policies, budgets, automatic rollback, quarantine and the kill switch — and the audit trail behind them.
keywords: execution contract contracts device identity evidence chain signature verified approval plan hash policy policies grant deny default deny budgets tokens jobs wallclock prs limit rollback green quarantine kill switch halt audit lineage autonomy safety guard rails
views:
---
NOVA's background work (jobs, agents, connectors and autonomy runs) goes through the same set of guard rails. You see their state in [Workbench](help:workbench).

## Policies

A policy says who may do what. Every action by an agent, a connector or an autonomy run is checked first.

- **Default is no.** Nothing is allowed unless a policy grants it.
- **A refusal beats a grant.** If one policy allows something and another refuses it, it is refused.
- Policies can expire, and can be **revoked** at any time.
- A policy can say **approval required**. The action then waits in Workbench → **Waiting** until a person approves or denies it.
- Every decision (allowed or refused, and why) is recorded, so you can check later what happened.

Workbench → **Allowed** shows how many policies are active, revoked and expired. Workbench → **Waiting** lists refusals from the last hour.

## Budgets

A budget limits how much something may use per **hour** or per **day**:

| Limit | Counts |
| --- | --- |
| tokens | model tokens generated |
| jobs | background jobs started |
| wall-clock time | how long work runs |
| pull requests | PRs opened through connectors |
| cost | money spent on remote services, if any are used |

When a limit is reached the work stops and waits for the next window. Agents have their own budgets, and a sub-agent's use also counts against its parent. Workbench → **Allowed** shows use against each limit.

## Automatic rollback and quarantine

For areas that change over time (code in the workspace, small trained models, browser tools, releases) NOVA remembers the last version known to be good (the **green** version). When an automatic run fails its checks:

1. NOVA saves what the failed run produced as a **quarantine**, with the reason and the differences.
2. It goes back to the green version.
3. It records the rollback.

You decide later, in Workbench → **Waiting**, whether to **apply** the quarantined change after all or **discard** it. Rollbacks are listed under **Failed**.

This is separate from the rollback you use by hand in Local Workspace (**Roll back batch**), which puts back the files of a change batch you applied yourself.

## The kill switch

**halt** in Workbench stops all of the above at the next safe point, closes the agent browser and stops computer actions from chat. **resume** needs your resume passphrase. See [Workbench](help:workbench#the-kill-switch).

## Execution contracts and evidence

Every action NOVA takes on this computer runs as an **execution contract**: running a command, reading or changing files, taking screenshots, clicking or typing, and applying approved code changes. Each contract records:

- who asked for the action, and from which device;
- the plan and the capability it needs;
- the risk;
- the approval, the result and the checks.

- **This device.** Each NOVA install has its own key, created on first start. The device ID is the key's fingerprint. A device declares what it can do, its capabilities, but a capability is never permission by itself.
- **Approvals fit one plan.** An approval names the exact plan it approves, can be used once, and expires after 10 minutes. If the plan changes, the approval no longer fits and nothing runs. Read-only actions you allowed in Settings are recorded as approved by policy.
- **Evidence.** When a contract ends, NOVA chains it to the one before and signs it with this device's key. **Local Workspace > Execution contracts** shows this device, its capabilities, recent contracts and whether the chain is verified. **Help & Support > Support report** checks the chain too.

A changed, removed or reordered record shows as **Chain broken**. The check catches changes made to NOVA's data. It does not protect against someone who already controls your user account, because the key lives on this computer.

This is the first step of NOVA Everywhere: later, a paired phone will approve the same contracts with its own key.

## The audit trail

Workbench decisions, policy checks, connector actions, agent browser actions and kill switch events are written to the audit log in NOVA's data folder, with the operator's name and the reason.

## Where these apply today

These rules are built and fully tested. In the console today they show up in Workbench, in model qualification and in the kill switch. Connectors, the multi-agent system and autonomy runs are not started from the console yet, so on most computers the policy and budget lists are still empty. See [Built, not yet in the console](help:developer-preview).
