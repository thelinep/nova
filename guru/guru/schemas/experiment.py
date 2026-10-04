"""Matched-arm cost and evaluation records."""
from __future__ import annotations

from enum import Enum

from pydantic import Field, model_validator

from .teacher_lineage import StrictModel


class CostUnit(str, Enum):
    USD = "usd"
    GPU_HOURS = "gpu_hours"
    CPU_HOURS = "cpu_hours"
    TOKENS = "tokens"
    PERSON_HOURS = "person_hours"


class Arm(str, Enum):
    BASELINE = "baseline"
    TREATMENT = "treatment"


class CostLine(StrictModel):
    amount: float | None = Field(default=None, ge=0)
    unit: CostUnit = CostUnit.USD
    evidence_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    not_applicable_reason: str | None = None


class CostCategory(StrictModel):
    name: str = Field(min_length=1)
    line: CostLine | None = None

    @model_validator(mode="after")
    def empty_needs_reason(self) -> CostCategory:
        if self.line is None or self.line.amount is None:
            if self.line is None or not self.line.not_applicable_reason:
                raise ValueError("empty CostCategory requires not_applicable_reason")
        return self


class EvalMetrics(StrictModel):
    case_count: int = Field(ge=0)
    passed: int = Field(ge=0)
    failed: int = Field(ge=0)
    metric_values: dict[str, float] = Field(default_factory=dict)

    @model_validator(mode="after")
    def coherent_counts(self) -> EvalMetrics:
        if self.passed + self.failed > self.case_count:
            raise ValueError("passed plus failed cannot exceed case_count")
        return self


class InferenceProfile(StrictModel):
    model_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    context_tokens: int = Field(ge=1)
    latency_ms_p50: float | None = Field(default=None, ge=0)
    latency_ms_p95: float | None = Field(default=None, ge=0)
    memory_bytes_peak: int | None = Field(default=None, ge=0)


REQUIRED_COST_CATEGORIES: tuple[str, ...] = (
    "teacher_inference", "data_generation_overhead", "input_disclosure_review", "data_review",
    "quality_gate_runs", "student_training", "evaluation", "inference_at_deployment",
    "engineering", "storage_and_transfer",
)


class ArmResult(StrictModel):
    arm: Arm
    costs: dict[str, CostLine]
    metrics: EvalMetrics
    inference_profile: InferenceProfile | None = None
    checkpoint_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def all_costs_present(self) -> ArmResult:
        missing = sorted(set(REQUIRED_COST_CATEGORIES) - set(self.costs))
        extra = sorted(set(self.costs) - set(REQUIRED_COST_CATEGORIES))
        if missing or extra:
            raise ValueError(f"ArmResult.costs must contain all 10 required category names; missing={missing}, extra={extra}")
        for name, line in self.costs.items():
            if line.amount is None and not line.not_applicable_reason:
                raise ValueError(f"empty CostCategory {name!r} requires not_applicable_reason")
        return self


class Experiment(StrictModel):
    experiment_id: str = Field(min_length=1)
    baseline_arm: str = "baseline"
    arms: dict[str, ArmResult]
    preregistration_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    evaluation_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    policy_version: str = Field(min_length=1)

    @model_validator(mode="after")
    def baseline_exists(self) -> Experiment:
        if self.baseline_arm not in self.arms:
            raise ValueError("Experiment.arms must contain the baseline_arm")
        return self
