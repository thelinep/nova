"""Digest-only in-memory binding of reviewed trajectories to Guru tasks.

This module does not capture, persist, export, train on, or distribute trajectory
data. It joins existing trajectory/task/source/rights records and reports
whether the evidence is structurally eligible for gold review. Current I7
policy still blocks persistent transformed data and training use.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
import hashlib
import json
import re
from typing import Literal

from pydantic import Field, model_validator

from guru.coding import SOURCE_MANIFEST_SCHEMA, canonical_sha256, validate_task
from guru.quality.use_scope import GURU_USE_SCOPE_POLICY
from guru.schemas.rights_decision import RightsDecision, SourceRights
from guru.schemas.teacher_lineage import (AccessMethod, InputType, OutputRights,
                                          StrictModel, TeacherLineage)
from guru.teacher.intake import validate_teacher
from guru.schemas.trajectory import FinalOutcome, Trajectory
from guru.trajectories import (TrajectoryDataError, validate_trajectories,
                               validate_trajectory)

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
GOLD_BINDING_POLICY = "guru-trajectory-gold-binding-v1"


class TrajectoryBindingError(ValueError):
    """Trajectory/task/rights evidence cannot be bound safely."""


class BoundRightsReference(StrictModel):
    """Digest-only rights snapshot for one source item."""

    source_id: str = Field(min_length=1)
    item_id: str = Field(min_length=1)
    item_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    rights_decision_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    rights: SourceRights


class TrajectoryReviewBinding(StrictModel):
    """Caller-supplied review record pinned to one exact raw trace digest.

    This envelope proves internal binding only. Authenticity of the envelope,
    reviewer identity, and digest pins remains an external trust decision.
    """

    schema_version: Literal["guru-trajectory-review-binding-v1"] = (
        "guru-trajectory-review-binding-v1"
    )
    trajectory_id: str = Field(min_length=1)
    trajectory_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    review: Trajectory


class _TrajectoryTaskBindingFields(StrictModel):
    schema_version: Literal["guru-trajectory-task-binding-v1"] = (
        "guru-trajectory-task-binding-v1"
    )
    trajectory_id: str = Field(min_length=1)
    trajectory_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    task_id: str = Field(min_length=1)
    task_schema_version: str = Field(min_length=1)
    task_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    family_id: str = Field(min_length=1)
    split: Literal["train"]
    leakage_group: str = Field(min_length=1)
    review_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    reviewed_trajectory_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    reviewer_id: str = Field(min_length=1)
    adjudicated_at: datetime
    final_outcome: Literal["approved"]
    training_eligibility_policy: Literal["guru-trajectory-gold-binding-v1"]
    rights_refs: list[BoundRightsReference] = Field(min_length=1)
    teacher_refs: list[dict[str, str | None]] = Field(min_length=1)
    use_scope_policy: Literal["guru-use-scope-i7-v2"] = "guru-use-scope-i7-v2"
    review_record_bound: Literal[True] = True
    human_adjudicated_candidate: Literal[False] = False
    gold_candidate_eligible: Literal[False] = False
    training_use_allowed: Literal[False] = False
    blockers: list[str] = Field(min_length=2)


class TrajectoryTaskBinding(_TrajectoryTaskBindingFields):
    """Versioned, payload-free result of binding a reviewed trace to a task."""

    binding_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def require_current_policy_blocker(self) -> TrajectoryTaskBinding:
        if GURU_USE_SCOPE_POLICY.permits_persisted_corpus():
            raise ValueError("trajectory binding may not enable persisted corpus use")
        if "I7 denies persisted transformed-data retention and corpus assembly" not in self.blockers:
            raise ValueError("binding must preserve the current I7 persistence blocker")
        if "qualified evaluator and bound case evidence are unavailable" not in self.blockers:
            raise ValueError("binding must preserve the evaluator qualification blocker")
        if self.gold_candidate_eligible:
            raise ValueError("human review alone cannot qualify a gold candidate")
        if self.adjudicated_at.tzinfo is None or self.adjudicated_at.utcoffset() is None:
            raise ValueError("adjudicated_at must be timezone-aware")
        expected = _canonical_digest(self.model_dump(mode="json", exclude={"binding_sha256"}))
        if expected != self.binding_sha256:
            raise ValueError("binding_sha256 does not match binding metadata")
        return self


def _canonical_digest(value: object) -> str:
    try:
        data = json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise TrajectoryBindingError("binding inputs are not canonical JSON") from exc
    return hashlib.sha256(data).hexdigest()


def _as_rights(value: RightsDecision | Mapping[str, object]) -> RightsDecision:
    try:
        return value if isinstance(value, RightsDecision) else RightsDecision.model_validate(dict(value))
    except Exception as exc:
        raise TrajectoryBindingError("source rights decision is missing or invalid") from exc


def _source_ref_key(value: object, label: str) -> tuple[str, str, str]:
    if not isinstance(value, Mapping):
        raise TrajectoryBindingError(f"{label} is missing or is not an object")
    source_id, item_id, item_sha = (value.get("source_id"), value.get("item_id"),
                                   value.get("item_sha256"))
    if not isinstance(source_id, str) or not source_id.strip():
        raise TrajectoryBindingError(f"{label}.source_id is missing")
    if not isinstance(item_id, str) or not item_id.strip():
        raise TrajectoryBindingError(f"{label}.item_id is missing")
    if not isinstance(item_sha, str) or not _SHA256.fullmatch(item_sha):
        raise TrajectoryBindingError(f"{label}.item_sha256 is missing or invalid")
    return source_id, item_id, item_sha


def _collect_source_bearing_ref_keys(trajectory: Mapping[str, object]) -> set[tuple[str, str, str]]:
    """Collect every supported input/source/task reference; evaluator refs are separate.

    These refs must all resolve to a task source item with a matching rights
    decision. Non-source references have no typed classification in the v1
    trajectory contract, so this binding conservatively rejects them.
    """
    keys: set[tuple[str, str, str]] = set()

    def add(ref: object, label: str) -> None:
        keys.add(_source_ref_key(ref, label))

    for field in ("prompt_refs", "context_refs", "source_refs"):
        refs = trajectory.get(field)
        if not isinstance(refs, list):
            raise TrajectoryBindingError(f"trajectory {field} are missing")
        for index, ref in enumerate(refs):
            add(ref, f"trajectory {field}[{index}]")

    turns = trajectory.get("turns")
    if not isinstance(turns, list):
        raise TrajectoryBindingError("trajectory turns are missing")
    for index, turn in enumerate(turns):
        if not isinstance(turn, Mapping):
            raise TrajectoryBindingError(f"trajectory turns[{index}] is invalid")
        add(turn.get("prompt_ref"), f"trajectory turns[{index}].prompt_ref")
        add(turn.get("task_ref"), f"trajectory turns[{index}].task_ref")
        contexts = turn.get("context_refs")
        if not isinstance(contexts, list):
            raise TrajectoryBindingError(f"trajectory turns[{index}].context_refs are missing")
        for ref_index, ref in enumerate(contexts):
            add(ref, f"trajectory turns[{index}].context_refs[{ref_index}]")
        action = turn.get("action")
        if not isinstance(action, Mapping):
            raise TrajectoryBindingError(f"trajectory turns[{index}].action is missing")
        if "input_ref" in action:
            add(action.get("input_ref"), f"trajectory turns[{index}].action.input_ref")
        patches = turn.get("patch_refs")
        if not isinstance(patches, list):
            raise TrajectoryBindingError(f"trajectory turns[{index}].patch_refs are missing")
        if patches:
            raise TrajectoryBindingError(
                f"trajectory turns[{index}].patch_refs lack a typed source-rights classification"
            )
        # evaluator_evidence.refs are deliberately excluded: v1 has no qualified
        # evaluator/case provenance contract, so they remain untrusted evidence.
    return keys


def bind_trajectory_to_task(
    *,
    trajectory: Mapping[str, object],
    trajectory_set: Sequence[Mapping[str, object]],
    expected_trajectory_sha256: str,
    task: Mapping[str, object],
    source_manifest: Mapping[str, object],
    expected_source_manifest_sha256: str,
    rights_decisions: Sequence[RightsDecision | Mapping[str, object]],
    teacher_lineages: Sequence[TeacherLineage | Mapping[str, object]],
    review_binding: TrajectoryReviewBinding | Mapping[str, object],
) -> TrajectoryTaskBinding:
    """Bind a reviewed raw trace to one exact train task and its source rights.

    All inputs are in-memory records. Expected hashes and the review envelope
    are caller-pinned values; this function confirms internal byte/digest
    consistency but does not authenticate their origin. A successful binding
    is only a human-adjudicated candidate: evaluator qualification and I7 still
    block gold eligibility, retained training data, and corpus use.
    """
    try:
        validate_trajectories([dict(row) for row in trajectory_set])
        validate_trajectory(dict(trajectory))
        validate_task(dict(task))
    except (TrajectoryDataError, ValueError, TypeError) as exc:
        raise TrajectoryBindingError(f"trajectory/task schema validation failed: {exc}") from exc

    if not isinstance(expected_trajectory_sha256, str) or not _SHA256.fullmatch(expected_trajectory_sha256):
        raise TrajectoryBindingError("expected trajectory SHA-256 pin is missing or invalid")
    trajectory_sha = canonical_sha256(dict(trajectory))
    if trajectory_sha != expected_trajectory_sha256:
        raise TrajectoryBindingError("trajectory digest drift")
    try:
        review_envelope = (review_binding if isinstance(review_binding, TrajectoryReviewBinding)
                           else TrajectoryReviewBinding.model_validate(dict(review_binding)))
    except Exception as exc:
        raise TrajectoryBindingError("human review binding envelope is missing or invalid") from exc
    if review_envelope.trajectory_id != trajectory.get("trajectory_id"):
        raise TrajectoryBindingError("human review binding trajectory ID mismatch")
    if review_envelope.trajectory_sha256 != trajectory_sha:
        raise TrajectoryBindingError("human review does not bind exact trajectory digest")
    matching = [row for row in trajectory_set
                if isinstance(row, Mapping) and row.get("trajectory_id") == trajectory.get("trajectory_id")]
    if len(matching) != 1 or canonical_sha256(dict(matching[0])) != trajectory_sha:
        raise TrajectoryBindingError("trajectory set must contain this exact trajectory exactly once")

    if not isinstance(expected_source_manifest_sha256, str) or not _SHA256.fullmatch(expected_source_manifest_sha256):
        raise TrajectoryBindingError("expected source-manifest SHA-256 pin is missing or invalid")
    source_manifest_sha = _canonical_digest(dict(source_manifest))
    if source_manifest_sha != expected_source_manifest_sha256:
        raise TrajectoryBindingError("source manifest digest drift")
    if source_manifest.get("schema_version") != SOURCE_MANIFEST_SCHEMA:
        raise TrajectoryBindingError("source manifest schema version is missing or unsupported")

    task_id = task.get("id")
    task_schema = task.get("schema_version")
    split = task.get("split")
    task_sha = canonical_sha256(dict(task))
    if not isinstance(task_id, str) or not task_id.strip():
        raise TrajectoryBindingError("task id is missing")
    if not isinstance(task_schema, str) or not task_schema.strip():
        raise TrajectoryBindingError("task schema version is missing")
    task_ref = trajectory.get("task_ref")
    if not isinstance(task_ref, Mapping):
        raise TrajectoryBindingError("trajectory task_ref is missing")
    if task_ref.get("task_id") != task_id:
        raise TrajectoryBindingError("trajectory task ID does not match task")
    if task_ref.get("task_schema_version") != task_schema:
        raise TrajectoryBindingError("trajectory task schema version does not match task")
    if task_ref.get("task_sha256") != task_sha:
        raise TrajectoryBindingError("task digest drift")
    if split != "train" or trajectory.get("split") != split or task_ref.get("split") != split:
        raise TrajectoryBindingError("gold trajectory binding requires matching train split")

    provenance = task.get("provenance")
    if not isinstance(provenance, Mapping):
        raise TrajectoryBindingError("task provenance is missing")
    family_id = task.get("family_id")
    leakage_group = task.get("leakage_group")
    if not isinstance(family_id, str) or not family_id.strip():
        raise TrajectoryBindingError("task family_id is missing")
    if not isinstance(leakage_group, str) or not leakage_group.strip():
        raise TrajectoryBindingError("task leakage_group is missing")
    if task_ref.get("family_id") != family_id:
        raise TrajectoryBindingError("task family lineage mismatch")
    if trajectory.get("leakage_group") != leakage_group:
        raise TrajectoryBindingError("trajectory/task leakage group mismatch")
    if any(row.get("task_ref", {}).get("task_id") == task_id and row.get("split") != split
           for row in trajectory_set if isinstance(row, Mapping)):
        raise TrajectoryBindingError("task ID appears across data splits")

    manifest_sources = source_manifest.get("sources")
    if not isinstance(manifest_sources, list) or not manifest_sources:
        raise TrajectoryBindingError("source manifest sources are missing")
    sources_by_id: dict[str, Mapping[str, object]] = {}
    for source in manifest_sources:
        if not isinstance(source, Mapping):
            raise TrajectoryBindingError("source manifest contains an invalid source record")
        source_id = source.get("source_id")
        if not isinstance(source_id, str) or not source_id.strip() or source_id in sources_by_id:
            raise TrajectoryBindingError("source manifest has a missing or duplicate source_id")
        sources_by_id[source_id] = source
    task_hashes = [source.get("task_hashes", {}).get(task_id)
                   for source in sources_by_id.values()
                   if isinstance(source.get("task_hashes"), Mapping) and task_id in source.get("task_hashes", {})]
    if task_hashes != [task_sha]:
        raise TrajectoryBindingError("task must resolve exactly once by digest in source manifest")

    task_source_refs = provenance.get("source_refs")
    trajectory_source_refs = trajectory.get("source_refs")
    trajectory_rights_refs = trajectory.get("rights_refs")
    if not isinstance(task_source_refs, list) or not task_source_refs:
        raise TrajectoryBindingError("task provenance source_refs are missing")
    if not isinstance(trajectory_source_refs, list) or not trajectory_source_refs:
        raise TrajectoryBindingError("trajectory source_refs are missing")
    if not isinstance(trajectory_rights_refs, list) or not trajectory_rights_refs:
        raise TrajectoryBindingError("trajectory rights_refs are missing")
    task_keys = [_source_ref_key(ref, f"task source_refs[{index}]")
                 for index, ref in enumerate(task_source_refs)]
    trace_keys = [_source_ref_key(ref, f"trajectory source_refs[{index}]")
                  for index, ref in enumerate(trajectory_source_refs)]
    if len(set(task_keys)) != len(task_keys) or set(task_keys) != set(trace_keys) or len(task_keys) != len(trace_keys):
        raise TrajectoryBindingError("task and trajectory source lineage differs or is duplicated")
    all_trace_source_keys = _collect_source_bearing_ref_keys(trajectory)
    if not all_trace_source_keys.issubset(set(task_keys)):
        raise TrajectoryBindingError(
            "source-bearing trajectory reference lacks a matching task source artifact and rights decision"
        )

    rights_by_id: dict[str, RightsDecision] = {}
    for raw_decision in rights_decisions:
        decision = _as_rights(raw_decision)
        if decision.source_id in rights_by_id:
            raise TrajectoryBindingError("duplicate source rights decisions")
        rights_by_id[decision.source_id] = decision
    rights_bindings: list[BoundRightsReference] = []
    rights_keys: set[tuple[str, str, str]] = set()
    for index, raw_ref in enumerate(trajectory_rights_refs):
        key = _source_ref_key(raw_ref, f"trajectory rights_refs[{index}]")
        if key in rights_keys:
            raise TrajectoryBindingError("duplicate trajectory rights reference")
        rights_keys.add(key)
        if key not in set(task_keys):
            raise TrajectoryBindingError("trajectory rights reference does not resolve to task source lineage")
        source_id, _item_id, _item_sha = key
        source = sources_by_id.get(source_id)
        decision = rights_by_id.get(source_id)
        if source is None or decision is None:
            raise TrajectoryBindingError(f"missing source or rights decision for {source_id!r}")
        decision_digest = _canonical_digest(decision.model_dump(mode="json"))
        if raw_ref.get("rights_decision_sha256") != decision_digest:
            raise TrajectoryBindingError("rights decision digest drift or missing rights reference")
        if (decision.revision != source.get("revision") or
                decision.artifact_sha256 != source.get("artifact_sha256")):
            raise TrajectoryBindingError("rights decision does not bind the source manifest artifact")
        rights = decision.rights
        if not rights.allow_training:
            raise TrajectoryBindingError("source rights do not allow training")
        if not rights.allow_ephemeral_transformation or not GURU_USE_SCOPE_POLICY.permits_ephemeral_transformation(rights):
            raise TrajectoryBindingError("source rights do not allow ephemeral transformation")
        if not rights.allow_evaluation:
            raise TrajectoryBindingError("source rights do not allow evaluation")
        if rights.allow_provider_transmission:
            raise TrajectoryBindingError("source rights conflict with I7 external-transmission denial")
        if rights.allow_transformed_data_retention:
            raise TrajectoryBindingError("source rights conflict with I7 ephemeral-only retention")
        if rights.allow_weight_distribution:
            raise TrajectoryBindingError("source rights conflict with I7 private-local weights")
        rights_bindings.append(BoundRightsReference(
            source_id=source_id, item_id=key[1], item_sha256=key[2],
            rights_decision_sha256=decision_digest, rights=rights,
        ))
    if rights_keys != set(task_keys):
        raise TrajectoryBindingError("one or more task source references lack a rights decision")
    if not all_trace_source_keys.issubset(rights_keys):
        raise TrajectoryBindingError(
            "one or more source-bearing trajectory references lack a rights decision"
        )

    approved_teachers: dict[str, TeacherLineage] = {}
    for raw_teacher in teacher_lineages:
        try:
            teacher = (raw_teacher if isinstance(raw_teacher, TeacherLineage)
                       else TeacherLineage.model_validate(dict(raw_teacher)))
        except Exception as exc:
            raise TrajectoryBindingError("teacher lineage record is missing or invalid") from exc
        if teacher.teacher_id in approved_teachers:
            raise TrajectoryBindingError("duplicate teacher lineage records")
        intake = validate_teacher(teacher)
        if not intake["admissible"]:
            raise TrajectoryBindingError(
                f"teacher {teacher.teacher_id!r} is not admitted for training: " + "; ".join(intake["blockers"])
            )
        if teacher.access_method is AccessMethod.API:
            raise TrajectoryBindingError("teacher access conflicts with I7 external-transmission denial")
        if teacher.output_rights not in {OutputRights.MAY_TRAIN, OutputRights.MAY_REDISTRIBUTE}:
            raise TrajectoryBindingError("teacher output rights do not allow training")
        if InputType.TRACES not in teacher.input_disclosure.allowed_input_types:
            raise TrajectoryBindingError("teacher input disclosure does not allow trajectory traces")
        approved_teachers[teacher.teacher_id] = teacher

    teacher_refs: dict[tuple[str, str, str | None], dict[str, str | None]] = {}
    for index, turn in enumerate(trajectory.get("turns", [])):
        if not isinstance(turn, Mapping) or not isinstance(turn.get("model"), Mapping):
            raise TrajectoryBindingError(f"trajectory turns[{index}] model lineage is missing")
        model = turn["model"]
        teacher_id, model_sha = model.get("model_id"), model.get("model_sha256")
        adapter_sha = model.get("adapter_sha256")
        if not isinstance(teacher_id, str) or not isinstance(model_sha, str):
            raise TrajectoryBindingError(f"trajectory turns[{index}] teacher identity is missing")
        teacher = approved_teachers.get(teacher_id)
        if teacher is None:
            raise TrajectoryBindingError(f"missing approved teacher lineage for {teacher_id!r}")
        if model_sha not in teacher.model_digest:
            raise TrajectoryBindingError(f"teacher model digest mismatch for {teacher_id!r}")
        if adapter_sha is not None and adapter_sha not in teacher.adapter_digests:
            raise TrajectoryBindingError(f"teacher adapter digest mismatch for {teacher_id!r}")
        teacher_ref_key = (teacher_id, model_sha, adapter_sha)
        teacher_refs[teacher_ref_key] = {
            "teacher_id": teacher_id,
            "model_sha256": model_sha,
            "adapter_sha256": adapter_sha,
            "teacher_lineage_sha256": _canonical_digest(teacher.model_dump(mode="json")),
        }

    parsed_review = review_envelope.review
    if parsed_review.trajectory_id != trajectory.get("trajectory_id"):
        raise TrajectoryBindingError("human review trajectory ID mismatch")
    if parsed_review.leakage_group != leakage_group:
        raise TrajectoryBindingError("human review leakage group mismatch")
    if parsed_review.final_outcome is not FinalOutcome.APPROVED:
        raise TrajectoryBindingError("trajectory final outcome is not approved")
    adjudication = parsed_review.human_adjudication
    if (not adjudication.required or adjudication.decision is not FinalOutcome.APPROVED or
            not adjudication.reviewer_id or adjudication.decided_at is None):
        raise TrajectoryBindingError("human adjudication does not approve gold use")
    eligibility = parsed_review.training_eligibility
    if not eligibility.eligible:
        raise TrajectoryBindingError("trajectory training eligibility is not approved")
    if eligibility.policy_version != GOLD_BINDING_POLICY:
        raise TrajectoryBindingError("trajectory training eligibility policy is missing or unsupported")
    if not parsed_review.acceptance_checks or any(
        check.required and not check.evidence_digest for check in parsed_review.acceptance_checks
    ):
        raise TrajectoryBindingError("required acceptance-check evidence is incomplete")
    snapshot_digest = parsed_review.project_snapshot.snapshot_digest
    if snapshot_digest not in {ref[2] for ref in trace_keys} and snapshot_digest not in {
        ref.get("item_sha256") for ref in trajectory.get("context_refs", []) if isinstance(ref, Mapping)
    }:
        raise TrajectoryBindingError("project snapshot digest is missing from trajectory context lineage")
    review_digest = _canonical_digest(parsed_review.model_dump(mode="json"))
    blockers = ["qualified evaluator and bound case evidence are unavailable"]
    if not GURU_USE_SCOPE_POLICY.permits_persisted_corpus():
        blockers.append("I7 denies persisted transformed-data retention and corpus assembly")
    payload = {
        "schema_version": "guru-trajectory-task-binding-v1",
        "trajectory_id": parsed_review.trajectory_id,
        "trajectory_sha256": trajectory_sha,
        "task_id": task_id,
        "task_schema_version": task_schema,
        "task_sha256": task_sha,
        "source_manifest_sha256": source_manifest_sha,
        "family_id": family_id,
        "split": "train",
        "leakage_group": leakage_group,
        "review_sha256": review_digest,
        "reviewed_trajectory_sha256": trajectory_sha,
        "reviewer_id": adjudication.reviewer_id,
        "adjudicated_at": adjudication.decided_at.isoformat(),
        "final_outcome": "approved",
        "training_eligibility_policy": GOLD_BINDING_POLICY,
        "rights_refs": [entry.model_dump(mode="json") for entry in rights_bindings],
        "teacher_refs": [teacher_refs[key] for key in sorted(teacher_refs)],
        "use_scope_policy": GURU_USE_SCOPE_POLICY.version,
        "review_record_bound": True,
        "human_adjudicated_candidate": False,
        "gold_candidate_eligible": False,
        "training_use_allowed": False,
        "blockers": blockers,
    }
    # Pydantic normalizes aware timestamps to its JSON representation (for
    # example, UTC ``Z``); hash exactly the serialized public contract.
    try:
        normalized_payload = _TrajectoryTaskBindingFields.model_validate(payload).model_dump(mode="json")
        payload = dict(normalized_payload)
        payload["binding_sha256"] = _canonical_digest(payload)
        return TrajectoryTaskBinding.model_validate(payload)
    except Exception as exc:
        raise TrajectoryBindingError(f"cannot construct trajectory task binding: {exc}") from exc
