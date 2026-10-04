"""Render a reproducible Markdown report from completed experiment JSON."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .decision import ExperimentInputError, _unique_object, evaluate_results


def _pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def _usd(value: float | None) -> str:
    return "N/A" if value is None else f"${value:,.2f}"


def render_report(results: dict, decision: dict | None = None) -> str:
    """Render summary and audit tables; calculate the decision if not supplied."""
    computed = evaluate_results(results)
    if decision is not None and decision != computed:
        raise ExperimentInputError("supplied decision JSON does not match the decision recomputed from results")
    decision = computed
    arms = decision["arms"]
    base = arms["sft_only"]
    treatment = arms["response_distill"]
    metrics = decision["metrics"]
    base_exec = sum(row["executable_correctness"] for row in base["seeds"]) / len(base["seeds"])
    treat_exec = sum(row["executable_correctness"] for row in treatment["seeds"]) / len(treatment["seeds"])
    base_sec = sum(row["security_pass_rate"] for row in base["seeds"]) / len(base["seeds"])
    treat_sec = sum(row["security_pass_rate"] for row in treatment["seeds"]) / len(treatment["seeds"])
    base_lint = sum(row["lint_clean_rate"] for row in base["seeds"]) / len(base["seeds"])
    treat_lint = sum(row["lint_clean_rate"] for row in treatment["seeds"]) / len(treatment["seeds"])
    base_reg = sum(row["regression_rate"] for row in base["seeds"]) / len(base["seeds"])
    treat_reg = sum(row["regression_rate"] for row in treatment["seeds"]) / len(treatment["seeds"])
    base_conv = sum(row["conversation_quality"] for row in base["seeds"]) / len(base["seeds"])
    treat_conv = sum(row["conversation_quality"] for row in treatment["seeds"]) / len(treatment["seeds"])
    eval_set = decision["frozen_eval_set"]
    prereg = results["pre_registration"]
    policies = results["policy_versions"]

    lines = [
        "# Response-distillation vs. SFT-only experiment report",
        "",
        f"**Experiment:** `{decision['experiment_id']}`  ",
        f"**Decision:** **{decision['decision'].upper()}**  ",
        f"**Pre-registration SHA-256:** `{decision['pre_registration_sha256']}`",
        "",
        "> This report records the submitted evidence. The renderer recomputes",
        "> metrics but cannot authenticate approvals, evidence references, or",
        "> owner signatures and does not qualify a model for Maataa.",
        "",
        "## Frozen hypothesis and evaluation",
        "",
        str(results.get("hypothesis", "(not supplied)")),
        "",
        f"- Evaluation: `{eval_set['id']}` / `{eval_set['sha256']}` ({eval_set['size']} cases)",
        f"- Quality policy: `{policies['quality']}`",
        f"- Disclosure policy: `{policies['disclosure']}`",
        f"- Decision rule: `{decision['decision_rule_version']}` (owner ratification: `{prereg['decision_rule_owner_ratification_ref']}`)",
        f"- Student base / tokenizer / teacher / evaluator digests: `{decision['model_lineage']['student_base_sha256']}` / `{decision['model_lineage']['tokenizer_sha256']}` / `{decision['model_lineage']['teacher_model_sha256']}` / `{decision['model_lineage']['evaluator_image_sha256']}`",
        f"- Owner: {prereg['owner_signoff']['owner']} (approval reference: `{prereg['owner_signoff']['approval_ref']}`)",
        "",
        "## Arm comparison",
        "",
        "| Arm | Actual total USD | Executable correctness | Security pass | Lint clean | Regression rate | Conversation quality | Human review |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
        f"| SFT-only | {_usd(base['actual_cost_usd'])} | {_pct(base_exec)} | {_pct(base_sec)} | {_pct(base_lint)} | {_pct(base_reg)} | {_pct(base_conv)} | {'pass' if base['human_adjudication']['passed'] else 'fail'} |",
        f"| Response-distill | {_usd(treatment['actual_cost_usd'])} | {_pct(treat_exec)} | {_pct(treat_sec)} | {_pct(treat_lint)} | {_pct(treat_reg)} | {_pct(treat_conv)} | {'pass' if treatment['human_adjudication']['passed'] else 'fail'} |",
        f"| Delta / ratio | {_usd(metrics['combined_actual_cost_usd'])} combined | {_pct(metrics['executable_correctness_delta'])} | {_pct(metrics['security_pass_rate_delta'])} | {_pct(treat_lint - base_lint)} | {_pct(treat_reg - base_reg)} | {_pct(metrics['conversation_quality_delta'])} | — |",
        "",
        "## Matched-seed results",
        "",
        "| Seed | SFT executable correctness | Distilled executable correctness | Delta | SFT security | Distilled security | Delta | SFT artifact SHA-256 | Distilled artifact SHA-256 | SFT evidence SHA-256 | Distilled evidence SHA-256 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |",
    ]
    base_by_seed = {str(row["seed"]): row for row in base["seeds"]}
    treat_by_seed = {str(row["seed"]): row for row in treatment["seeds"]}
    for delta in metrics["matched_seed_deltas"]:
        key = str(delta["seed"])
        before, after = base_by_seed[key], treat_by_seed[key]
        lines.append(
            f"| {delta['seed']} | {_pct(before['executable_correctness'])} | {_pct(after['executable_correctness'])} | {_pct(delta['executable_correctness_delta'])} | {_pct(before['security_pass_rate'])} | {_pct(after['security_pass_rate'])} | {_pct(delta['security_pass_rate_delta'])} | `{before['student_checkpoint_sha256']}` | `{after['student_checkpoint_sha256']}` | `{before['evaluation_evidence_sha256']}` | `{after['evaluation_evidence_sha256']}` |"
        )
    lines.extend([
        "",
        "## Actual cost ledger",
        "",
        "Actual amounts are used for the decision; preregistered estimates are retained only as planning records.",
        "",
        "| Category | SFT-only actual USD / reason | Response-distill actual USD / reason |",
        "| --- | --- | --- |",
    ])
    for category in base["cost_categories_usd"]:
        base_cost = base["cost_categories_usd"][category]
        treatment_cost = treatment["cost_categories_usd"][category]
        base_label = _usd(base_cost["actual_usd"])
        treatment_label = _usd(treatment_cost["actual_usd"])
        if base_cost["actual_usd"] is None:
            base_label += f" — {base_cost['not_applicable_reason']}"
        else:
            base_label += f" (evidence `{base_cost['evidence_sha256'][:12]}`)"
        if treatment_cost["actual_usd"] is None:
            treatment_label += f" — {treatment_cost['not_applicable_reason']}"
        else:
            treatment_label += f" (evidence `{treatment_cost['evidence_sha256'][:12]}`)"
        lines.append(
            f"| {category} | {base_label} | {treatment_label} |"
        )
    lines.extend([
        f"| Combined total | {_usd(metrics['combined_actual_cost_usd'])} | Cost ratio: {metrics['cost_ratio']:.3f}× |",
        f"| Incremental USD per absolute correctness point | {_usd(metrics['cost_per_absolute_correctness_point_usd'])} | Approved ceiling: {_usd(metrics['budget_ceiling_usd'])} |",
        "",
        "## Human adjudication",
        "",
    ])
    for name, arm in (("SFT-only", base), ("Response-distill", treatment)):
        review = arm["human_adjudication"]
        lines.append(
            f"- {name}: {'pass' if review['passed'] else 'fail'}; {review['sample_size']} items; {review['reviewer_count']} blinded reviewers."
        )
    lines.extend(["", "## Exclusions and unmeasured items", ""])
    exclusions = results["exclusions"]
    if exclusions:
        lines.extend(["| Item | Reason |", "| --- | --- |"])
        for row in exclusions:
            lines.append(f"| {row['item']} | {row['reason']} |")
    else:
        lines.append("None recorded; owner must confirm this is accurate.")
    lines.extend([
        "", "## Decision reasons", "",
        f"- Cost ratio: {metrics['cost_ratio']:.3f}×; allowable ratio under the rule is {metrics['allowed_cost_ratio']:.1f}×.",
        f"- Five-times-cost correctness threshold: 5.00%; observed gain: {_pct(metrics['executable_correctness_delta'])}.",
    ])
    lines.extend(f"- {reason}" for reason in decision["reasons"])
    lines.extend([
        "",
        "## Rejected and inconclusive outcomes",
        "",
        f"Computed outcome: **{decision['decision']}**. Preserve any rejected items, failed seeds, exclusions and policy deviations with their audit references. Do not omit negative or inconclusive results.",
        "",
        "## Limitations and owner sign-off",
        "",
        *[f"- {item}" for item in decision["limitations"]],
        "- Owner sign-off: pending separate report review.",
        "",
    ])
    return "\n".join(lines)


def _load(path: Path) -> dict:
    raw = path.read_bytes()
    if len(raw) > 10 * 1024 * 1024:
        raise ExperimentInputError(f"{path} exceeds 10 MiB")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(ExperimentInputError(f"invalid JSON number {value}")))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a completed Guru experiment report")
    parser.add_argument("results", type=Path)
    parser.add_argument("--decision", type=Path, help="optional previously generated decision JSON; must match recomputed result")
    parser.add_argument("--output", type=Path, help="write report Markdown; default is stdout")
    args = parser.parse_args(argv)
    try:
        results = _load(args.results)
        decision = _load(args.decision) if args.decision else None
        rendered = render_report(results, decision)
        if args.output:
            if args.output.exists():
                raise ExperimentInputError(f"refusing to overwrite existing report: {args.output}")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_name(args.output.name + ".tmp")
            if temporary.exists():
                raise ExperimentInputError(f"refusing to overwrite existing temporary file: {temporary}")
            temporary.write_text(rendered, encoding="utf-8")
            temporary.replace(args.output)
        else:
            sys.stdout.write(rendered)
        return 0
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ExperimentInputError) as exc:
        sys.stderr.write(f"experiment report refused: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
