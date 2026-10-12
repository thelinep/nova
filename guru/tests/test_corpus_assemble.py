from __future__ import annotations

from datetime import datetime, timezone
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pydantic import ValidationError

from guru.corpus.assemble import CorpusAssemblyBlocked, assemble as _assemble, preflight
from guru.coding import canonical_sha256
from guru.quality.checks import provenance_check
from guru.schemas.corpus import CorpusKind, CorpusManifest, CorpusStatus
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.teacher_lineage import AccessMethod, InputDisclosure, InputType, OutputRights, ReviewStatus, TeacherLineage
from guru.schemas.quality import AutoCheckName, QualityAdmissionPayload, QualityCheckSummary, QualityTier


def approved_teacher() -> TeacherLineage:
    return TeacherLineage(
        teacher_id="teacher-1", model_name="approved-model", license="Apache-2.0", access_method=AccessMethod.WEIGHTS,
        output_rights=OutputRights.MAY_TRAIN, review_status=ReviewStatus.APPROVED,
        reviewed_by="reviewer", reviewed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        model_digest="a" * 64,
        input_disclosure=InputDisclosure(allowed_input_types=[InputType.SOURCE_CODE], retention_bounded=True),
    )


def task_rows(count: int = 40) -> list[dict[str, str]]:
    return [{"id": f"task-{index:03d}"} for index in range(count)]


def _artifact_bytes(task_id: str) -> bytes:
    return f"synthetic source artifact for {task_id}".encode("utf-8")


def _source_digest(task_id: str) -> str:
    return hashlib.sha256(_artifact_bytes(task_id)).hexdigest()


def corpus_items(count: int = 40) -> list[CorpusItem]:
    return [CorpusItem(
        item_id=f"item-{index:03d}", task_id=f"task-{index:03d}",
        prompt=f"Implement function {index}", target=f"def f{index}(): return {index}",
        target_source="teacher", teacher_lineage_id="teacher-1", source_digest=_source_digest(f"task-{index:03d}"),
        metadata={"leakage_group": f"task-{index:03d}"},
    ) for index in range(count)]


def admission_row(item: CorpusItem, decision: str = "admit") -> dict:
    payload = QualityAdmissionPayload(
        item_id=item.item_id, item_digest=item.canonical_digest(), tier=QualityTier.C,
        decision=decision, reason_codes=["fixture"],
        checks=[QualityCheckSummary(name=name, status="PASS", evidence_digest=f"{i + 1:064x}",
                                    item_digest=item.canonical_digest(), tool_version="fixture/1",
                                    policy_version="fixture/1")
                for i, name in enumerate(AutoCheckName)],
    ).model_dump(mode="json")
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return {"event": "item_admission", **payload, "payload_digest": hashlib.sha256(raw).hexdigest()}


def admission_rows(count: int = 40) -> list[dict]:
    return [admission_row(item) for item in corpus_items(count)]


def _write_release_inputs(root: Path, items: list[CorpusItem], task_ids: list[str]):
    """Build isolated schema-valid task/source manifests for assembly tests."""
    root.mkdir(parents=True, exist_ok=True)
    all_train_ids = sorted(set(task_ids) | {item.task_id for item in items})
    eval_id = "fixture-heldout-eval"
    while eval_id in all_train_ids:
        eval_id += "-x"
    tasks = []
    source_specs = []
    license_text = b"Synthetic fixture license text only"
    license_path = root / "LICENSE.txt"
    license_path.write_bytes(license_text)

    def add_task(task_id: str, split: str):
        source_id = f"source-{task_id}"
        artifact_path = root / f"{source_id}.bin"
        artifact = _artifact_bytes(task_id)
        artifact_path.write_bytes(artifact)
        item_bytes = f"synthetic source item for {task_id}".encode("utf-8")
        item_path = root / f"item-{task_id}.json"
        item_path.write_bytes(item_bytes)
        task = {
            "schema_version": "guru-code-task-v1", "id": task_id, "split": split,
            "language": "python", "prompt": f"Synthetic task {task_id}",
            "provenance": {
                "kind": "synthetic_fixture", "description": "test-only task/source fixture",
                "source_refs": [{
                    "source_id": source_id, "item_id": f"item-{task_id}",
                    "item_path": item_path.name,
                    "item_sha256": hashlib.sha256(item_bytes).hexdigest(),
                    "transformation": "synthetic fixture construction",
                }],
            },
            "rubric": {"expected_files": ["main.py"], "required_symbols": {},
                       "required_test_snippets": []},
            "leakage_group": f"group-{task_id}",
        }
        if split == "train":
            task["target"] = {
                "summary": "Create a greeting", "files": [{"path": "main.py", "content": "print('hi')\n"}],
                "tests": ["python main.py"],
            }
        tasks.append(task)
        source_specs.append({
            "source_id": source_id, "uri": f"https://example.invalid/{source_id}",
            "revision": f"fixture-revision-{task_id}", "artifact_path": artifact_path.name,
            "artifact_sha256": hashlib.sha256(artifact).hexdigest(),
            "attribution": "Synthetic test fixture; not a rights claim",
            "license": {"id": "LicenseRef-Test-Only", "text_uri": "local:LICENSE.txt",
                        "text_path": license_path.name,
                        "text_sha256": hashlib.sha256(license_text).hexdigest()},
            "rights_review": {"status": "approved", "reviewer": "synthetic-test-reviewer",
                              "reviewed_at": "2026-10-12T00:00:00Z",
                              "allowed_uses": ["train_sft" if split == "train" else "evaluation"]},
            "task_hashes": {task_id: canonical_sha256(task)},
        })

    for task_id in all_train_ids:
        add_task(task_id, "train")
    add_task(eval_id, "eval")
    task_manifest_path = root / "tasks.jsonl"
    task_manifest_path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in tasks),
                                  encoding="utf-8")
    source_manifest_path = root / "source-manifest.json"
    source_manifest_path.write_text(json.dumps({
        "schema_version": "guru-code-source-manifest-v1", "sources": source_specs,
    }, sort_keys=True), encoding="utf-8")
    task_digest = hashlib.sha256(task_manifest_path.read_bytes()).hexdigest()
    source_digest = hashlib.sha256(source_manifest_path.read_bytes()).hexdigest()
    return task_manifest_path, task_digest, source_manifest_path, source_digest


def assemble(*, task_manifest, items, admission_audit, output_root, **kwargs):
    """Test-only wrapper that supplies real-shaped, temp-only provenance inputs."""
    item_rows = list(items)
    item_rows = [row if isinstance(row, CorpusItem) else CorpusItem.model_validate(row)
                 for row in item_rows]
    task_ids = [row["id"] for row in task_manifest] if isinstance(task_manifest, list) else []
    fixture_root = Path(output_root).parent / f".release-inputs-{kwargs['corpus_id']}-{kwargs['version']}"
    task_path, task_pin, source_path, source_pin = _write_release_inputs(
        fixture_root, item_rows, task_ids)
    audit_rows = [deepcopy(row) for row in admission_audit] if not isinstance(admission_audit, (str, Path)) else [
        json.loads(line) for line in Path(admission_audit).read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    # Replace only the fixture's explicit placeholder PROVENANCE summary. Tests
    # that mutate evidence keep their mutation and are rejected by assembly.
    for row in audit_rows:
        if not isinstance(row, dict) or row.get("event") != "item_admission":
            continue
        item = next((candidate for candidate in item_rows if candidate.item_id == row.get("item_id")), None)
        if item is None or not isinstance(row.get("checks"), list):
            continue
        try:
            result = provenance_check(
                item, manifest_path=source_path, expected_manifest_digest=source_pin,
                task_manifest_path=task_path, expected_task_manifest_digest=task_pin,
            )
        except ValueError:
            continue
        for check in row["checks"]:
            if (isinstance(check, dict) and check.get("name") == "provenance"
                    and check.get("tool_version") == "fixture/1"
                    and check.get("policy_version") == "fixture/1"):
                check.update(status="PASS" if result.passed else "FAIL",
                             evidence_digest=result.evidence_digest,
                             item_digest=result.item_digest,
                             tool_version=result.tool_version,
                             policy_version=result.policy_version)
                payload = {key: value for key, value in row.items()
                           if key not in {"event", "timestamp", "payload_digest"}}
                raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"), allow_nan=False).encode("utf-8")
                row["payload_digest"] = hashlib.sha256(raw).hexdigest()
    return _assemble(
        task_manifest=task_path, items=item_rows, admission_audit=audit_rows,
        task_manifest_digest=task_pin, source_manifest=source_path,
        source_manifest_digest=source_pin, output_root=output_root, **kwargs,
    )


class CorpusAssemblyTests(unittest.TestCase):
    def test_preflight_names_missing_approved_teacher_and_admission_audit(self) -> None:
        with TemporaryDirectory() as directory:
            missing_registry = Path(directory) / "missing-teachers.jsonl"
            missing_audit = Path(directory) / "missing-admission.jsonl"
            report = preflight(kind=CorpusKind.C_RD, task_manifest=task_rows(),
                               teacher_registry=missing_registry, admission_audit=missing_audit)
        self.assertFalse(report["ready"])
        self.assertIn("missing approved teacher", report["blockers"])
        self.assertIn("missing admission audit", report["blockers"])

    def test_registry_without_approved_teacher_blocks_preflight(self) -> None:
        pending = approved_teacher().model_dump(mode="json")
        pending.update(review_status="pending", reviewed_by=None, reviewed_at=None)
        report = preflight(kind="c_rd", task_manifest=task_rows(), teacher_registry=[TeacherLineage.model_validate(pending)],
                           admission_audit=admission_rows())
        self.assertFalse(report["ready"])
        self.assertIn("missing approved teacher", report["blockers"])

    def test_duplicate_item_decisions_block_preflight(self) -> None:
        row = admission_rows(1)[0]
        report = preflight(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                           admission_audit=[row, dict(row)])
        self.assertFalse(report["ready"])
        self.assertIn("duplicate quality decisions for item 'item-000'", report["blockers"])

    def test_legacy_or_tampered_admission_payload_blocks_preflight(self) -> None:
        item = corpus_items(1)[0]
        legacy = {"event": "item_admission", "item_id": item.item_id,
                  "decision": "admit", "item_digest": item.canonical_digest()}
        report = preflight(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                           admission_audit=[legacy])
        self.assertFalse(report["ready"])
        self.assertTrue(any("invalid or incomplete admission evidence" in value for value in report["blockers"]))

        tampered = admission_row(item)
        tampered["checks"][0]["evidence_digest"] = "f" * 64
        duplicate_check = admission_row(item)
        duplicate_check["checks"][1]["name"] = duplicate_check["checks"][0]["name"]
        for attack in (tampered, duplicate_check):
            report = preflight(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                               admission_audit=[attack])
            self.assertFalse(report["ready"])
            self.assertTrue(any("invalid or incomplete admission evidence" in value for value in report["blockers"]))

    def test_assemble_raises_typed_blocker_before_writing(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaises(CorpusAssemblyBlocked) as captured:
                assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[], admission_audit=[],
                         items=corpus_items(), corpus_id="draft", version="v1", split_seed="seed",
                         output_root=Path(directory) / "corpora")
            self.assertIn("missing approved teacher", captured.exception.blockers)
            self.assertFalse((Path(directory) / "corpora").exists())

    def test_c_rd_and_c_trace_require_teacher_lineage_for_admitted_items(self) -> None:
        items = {
            "c_rd": CorpusItem(item_id="item-rd", task_id="task-000", prompt="prompt", target="answer",
                               target_source="human", source_digest=_source_digest("task-000")),
            "c_trace": CorpusItem(item_id="item-trace", task_id="task-000", prompt="prompt", target="answer",
                                  target_source="trajectory", trajectory_id="trajectory-1",
                                  source_digest=_source_digest("task-000")),
        }
        with TemporaryDirectory() as directory:
            for kind, item in items.items():
                with self.subTest(kind=kind):
                    with self.assertRaisesRegex(ValueError, "missing teacher_lineage_id"):
                        assemble(kind=kind, task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                                 admission_audit=[admission_row(item)], items=[item], corpus_id="exp", version="v1",
                                 split_seed="seed", output_root=Path(directory) / kind)

    def test_admitted_item_rejects_missing_or_inadmissible_teacher_reference(self) -> None:
        missing_reference = corpus_items(1)[0].model_copy(update={"teacher_lineage_id": "teacher-missing"})
        pending_data = approved_teacher().model_dump(mode="json")
        pending_data.update(teacher_id="teacher-pending", review_status="pending", reviewed_by=None, reviewed_at=None)
        pending_teacher = TeacherLineage.model_validate(pending_data)
        unapproved_reference = corpus_items(1)[0].model_copy(update={"teacher_lineage_id": "teacher-pending"})
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "references missing teacher"):
                assemble(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                         admission_audit=[admission_row(missing_reference)], items=[missing_reference],
                         corpus_id="exp", version="missing", split_seed="seed", output_root=directory)
            with self.assertRaisesRegex(ValueError, "references inadmissible teacher"):
                assemble(kind="c_rd", task_manifest=task_rows(1),
                         teacher_registry=[approved_teacher(), pending_teacher],
                         admission_audit=[admission_row(unapproved_reference)], items=[unapproved_reference],
                         corpus_id="exp", version="unapproved", split_seed="seed", output_root=directory)
            with self.assertRaisesRegex(ValueError, "ambiguous duplicate teacher"):
                item = corpus_items(1)[0]
                assemble(kind="c_rd", task_manifest=task_rows(1),
                         teacher_registry=[approved_teacher(), approved_teacher()],
                         admission_audit=[admission_row(item)], items=[item], corpus_id="exp", version="duplicate",
                         split_seed="seed", output_root=directory)

    def test_sft_allows_human_item_without_optional_teacher_lineage(self) -> None:
        item = CorpusItem(item_id="item-human", task_id="task-000", prompt="prompt", target="answer",
                          target_source="human", source_digest=_source_digest("task-000"),
                          metadata={"leakage_group": "task-000"})
        with TemporaryDirectory() as directory:
            manifest = assemble(kind="c_sft", task_manifest=task_rows(1), teacher_registry=[],
                                admission_audit=[admission_row(item)], items=[item], corpus_id="exp", version="v1",
                                split_seed="seed", output_root=directory)
        self.assertEqual(manifest.item_count, 1)
        self.assertEqual(manifest.teacher_ids, [])

    def test_split_is_deterministic_across_two_runs_with_same_seed(self) -> None:
        items = corpus_items()
        tasks = task_rows()
        admissions = admission_rows()
        with TemporaryDirectory() as directory:
            first = assemble(kind="c_rd", task_manifest=tasks, teacher_registry=[approved_teacher()],
                             admission_audit=admissions, items=items, corpus_id="exp", version="v1",
                             split_seed="fixed-seed", output_root=Path(directory) / "one")
            second = assemble(kind="c_rd", task_manifest=tasks, teacher_registry=[approved_teacher()],
                              admission_audit=admissions, items=items, corpus_id="exp", version="v1",
                              split_seed="fixed-seed", output_root=Path(directory) / "two")
            self.assertEqual(first.item_file_digests, second.item_file_digests)
            self.assertEqual(first.items_digest, second.items_digest)
            for name in first.item_file_digests:
                left = Path(directory) / "one" / "exp" / "v1" / name
                right = Path(directory) / "two" / "exp" / "v1" / name
                self.assertEqual(left.read_bytes(), right.read_bytes())

    def test_split_matches_preregistration_counts_and_task_hash_order(self) -> None:
        # 40 unique tasks yield 32 train, 4 validation, and 4 held-out tasks.
        with TemporaryDirectory() as directory:
            result = assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                              admission_audit=admission_rows(), items=corpus_items(), corpus_id="exp", version="v1",
                              split_seed="ignored-for-frozen-rule", output_root=directory)
            other_seed = assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                                  admission_audit=admission_rows(), items=corpus_items(), corpus_id="exp", version="v2",
                                  split_seed="another-recorded-seed", output_root=directory)
            self.assertEqual(result.item_file_digests, other_seed.item_file_digests)
            root = Path(directory) / "exp" / "v1"
            expected = sorted((f"task-{index:03d}" for index in range(40)),
                              key=lambda task_id: (hashlib.sha256(task_id.encode("utf-8")).digest(), task_id))
            actual = {}
            for split, count in (("train", 32), ("val", 4), ("test", 4)):
                rows = [json.loads(line) for line in (root / f"items.{split}.jsonl").read_text().splitlines()]
                task_ids = {row["task_id"] for row in rows}
                self.assertEqual(len(task_ids), count)
                self.assertTrue(task_ids.issubset(set(expected[:32] if split == "train" else expected[32:36] if split == "val" else expected[36:])))
                actual[split] = task_ids
            self.assertFalse(actual["train"] & actual["val"])
            self.assertFalse(actual["train"] & actual["test"])
            self.assertFalse(actual["val"] & actual["test"])
            self.assertIn("floor(0.8G)", result.split_rule)
            self.assertIn("provenance only", result.split_rule)
            self.assertEqual(result.split_algorithm, "leakage-group-sha256-v1")
            self.assertEqual(result.split_group_count, 40)
            self.assertEqual(result.split_group_counts, {"train": 32, "val": 4, "test": 4})
            self.assertRegex(result.split_assignment_digest, r"^[0-9a-f]{64}$")

    def test_related_tasks_sharing_a_leakage_group_stay_together(self) -> None:
        items = corpus_items(40)
        # Two distinct tasks share repository/family ancestry, represented by
        # the curator's transitive leakage-group identifier.
        items[0] = items[0].model_copy(update={"metadata": {"leakage_group": "shared-family"}})
        items[1] = items[1].model_copy(update={"metadata": {"leakage_group": "shared-family"}})
        rows = [admission_row(item) for item in items]
        with TemporaryDirectory() as directory:
            manifest = assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                                admission_audit=rows, items=items, corpus_id="exp", version="v1",
                                split_seed="seed", output_root=directory)
            root = Path(directory) / "exp" / "v1"
            containing = [split for split in ("train", "val", "test")
                          if all(f'"task_id":"task-{index:03d}"' in
                                 (root / f"items.{split}.jsonl").read_text()
                                 for index in (0, 1))]
            self.assertEqual(len(containing), 1)
            self.assertEqual(manifest.split_group_count, 39)

    def test_admitted_item_without_leakage_group_blocks_assembly(self) -> None:
        item = corpus_items(1)[0].model_copy(update={"metadata": {}})
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "missing leakage_group"):
                assemble(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                         admission_audit=[admission_row(item)], items=[item], corpus_id="exp", version="v1",
                         split_seed="seed", output_root=directory)
            self.assertFalse((Path(directory) / "exp").exists())

    def test_item_split_declaration_conflicting_with_group_assignment_blocks(self) -> None:
        items = corpus_items(40)
        groups = sorted((item.metadata["leakage_group"] for item in items),
                        key=lambda group_id: (hashlib.sha256(group_id.encode("utf-8")).digest(), group_id))
        declared = "test" if groups.index("task-000") < 32 else "train"
        items[0] = items[0].model_copy(update={"metadata": {"leakage_group": "task-000", "split": declared}})
        rows = [admission_row(item) for item in items]
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "declares a split that conflicts"):
                assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                         admission_audit=rows, items=items, corpus_id="exp", version="v1",
                         split_seed="seed", output_root=directory)

    def test_validation_split_alias_is_accepted_for_assigned_validation_group(self) -> None:
        items = corpus_items(40)
        groups = sorted((item.metadata["leakage_group"] for item in items),
                        key=lambda group_id: (hashlib.sha256(group_id.encode("utf-8")).digest(), group_id))
        item_index = int(groups[32].rsplit("-", 1)[1])
        items[item_index] = items[item_index].model_copy(update={
            "metadata": {"leakage_group": groups[32], "split": "validation"},
        })
        rows = [admission_row(item) for item in items]
        with TemporaryDirectory() as directory:
            manifest = assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                                admission_audit=rows, items=items, corpus_id="exp", version="v1",
                                split_seed="seed", output_root=directory)
            self.assertEqual(manifest.split_counts["val"], 4)

    def test_all_items_for_a_task_stay_in_the_same_split(self) -> None:
        rows = [*corpus_items(40), CorpusItem(
            item_id="item-duplicate-example", task_id="task-000", prompt="another view",
            target="def other(): return 0", target_source="teacher", teacher_lineage_id="teacher-1",
            source_digest=_source_digest("task-000"), metadata={"leakage_group": "task-000"},
        )]
        extra = rows[-1]
        with TemporaryDirectory() as directory:
            assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                     admission_audit=[*admission_rows(), admission_row(extra)],
                     items=rows, corpus_id="exp", version="v1", split_seed="seed", output_root=directory)
            root = Path(directory) / "exp" / "v1"
            placements = [split for split in ("train", "val", "test")
                          if all(item_id in (root / f"items.{split}.jsonl").read_text()
                                 for item_id in ("item-000", "item-duplicate-example"))]
            self.assertEqual(len(placements), 1)

    def test_frozen_corpus_requires_owner_approval(self) -> None:
        with self.assertRaises(ValidationError):
            CorpusManifest(
                corpus_id="c1", version="v1", kind=CorpusKind.C_SFT, status=CorpusStatus.FROZEN,
                split_seed="seed", split_rule="deterministic", split_algorithm="test-v1",
                split_group_count=0, split_group_counts={"train": 0, "val": 0, "test": 0},
                split_assignment_digest="0" * 64, item_count=0,
                split_counts={"train": 0, "val": 0, "test": 0},
                item_file_digests={name: "0" * 64 for name in ("items.train.jsonl", "items.val.jsonl", "items.test.jsonl")},
                items_digest="0" * 64,
            )

    def test_corpus_item_requires_target_source_reference(self) -> None:
        common = {"item_id": "item", "task_id": "task", "prompt": "write code", "target": "pass",
                  "source_digest": "a" * 64}
        with self.assertRaises(ValidationError):
            CorpusItem(**common, target_source="teacher")
        with self.assertRaises(ValidationError):
            CorpusItem(**common, target_source="trajectory")
        self.assertEqual(CorpusItem(**common, target_source="human").item_id, "item")

    def test_excluded_tasks_require_reasons(self) -> None:
        with self.assertRaises(ValidationError):
            CorpusManifest(
                corpus_id="c1", version="v1", kind=CorpusKind.C_SFT, status=CorpusStatus.DRAFT,
                split_seed="seed", split_rule="deterministic", split_algorithm="test-v1",
                split_group_count=0, split_group_counts={"train": 0, "val": 0, "test": 0},
                split_assignment_digest="0" * 64, item_count=0,
                split_counts={"train": 0, "val": 0, "test": 0},
                item_file_digests={name: "0" * 64 for name in ("items.train.jsonl", "items.val.jsonl", "items.test.jsonl")},
                items_digest="0" * 64, excluded_task_ids=["task-x"],
            )

    def test_frozen_assembly_requires_complete_owner_approval(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "requires owner"):
                assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                         admission_audit=admission_rows(), items=corpus_items(), corpus_id="exp", version="v1",
                         split_seed="seed", owner_approval={"owner": ""}, output_root=Path(directory))
            result = assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                              admission_audit=admission_rows(), items=corpus_items(), corpus_id="exp", version="v1",
                              split_seed="seed", owner_approval={"owner": "owner", "approval_ref": "ref",
                                                                 "approved_at": "2026-10-04"},
                              output_root=Path(directory) / "approved")
            self.assertEqual(result.status, CorpusStatus.FROZEN)

    def test_rejected_items_are_not_written_to_training_splits(self) -> None:
        items = corpus_items(2)
        audit = admission_rows(1) + [admission_row(items[1], "reject")]
        with TemporaryDirectory() as directory:
            result = assemble(kind="c_rd", task_manifest=task_rows(2), teacher_registry=[approved_teacher()],
                              admission_audit=audit, items=items, corpus_id="exp", version="v1",
                              split_seed="seed", output_root=directory)
            self.assertEqual(result.item_count, 1)
            self.assertIn("task-001", result.excluded_task_ids)
            self.assertTrue(all("item-001" not in (Path(directory) / "exp" / "v1" / filename).read_text()
                                for filename in result.item_file_digests))

    def test_item_digest_is_canonical_and_covers_all_item_fields(self) -> None:
        item = corpus_items(1)[0]
        same = CorpusItem.model_validate(dict(reversed(list(item.model_dump(mode="json").items()))))
        self.assertEqual(item.canonical_digest(), same.canonical_digest())
        changes = {
            "item_id": "changed-item", "task_id": "changed-task", "prompt": "changed prompt",
            "target": "changed target", "target_source": "human", "teacher_lineage_id": "teacher-2",
            "trajectory_id": "trajectory-2", "source_digest": "e" * 64,
            "language": "rust", "metadata": {"note": "changed"},
        }
        for field, value in changes.items():
            with self.subTest(field=field):
                self.assertNotEqual(item.canonical_digest(), item.model_copy(update={field: value}).canonical_digest())

    def test_assembly_rejects_missing_or_mismatched_item_digest(self) -> None:
        item = corpus_items(1)[0]
        with TemporaryDirectory() as directory:
            for audit in (
                [{"event": "item_admission", "item_id": item.item_id, "decision": "admit"}],
                [{"event": "item_admission", "item_id": item.item_id, "decision": "admit",
                  "item_digest": "0" * 64}],
            ):
                with self.subTest(audit=audit):
                    with self.assertRaises(CorpusAssemblyBlocked) as captured:
                        assemble(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                                 admission_audit=audit, items=[item], corpus_id="exp", version="v1",
                                 split_seed="seed", output_root=Path(directory) / str(len(audit[0])))
                    self.assertTrue(any("admission evidence" in blocker for blocker in captured.exception.blockers))

    def test_assembly_rejects_duplicate_or_conflicting_decisions(self) -> None:
        item = corpus_items(1)[0]
        admitted = admission_row(item)
        with TemporaryDirectory() as directory:
            rejected = admission_row(item, "reject")
            for index, second in enumerate((dict(admitted), rejected)):
                with self.subTest(second=second):
                    with self.assertRaises(CorpusAssemblyBlocked) as captured:
                        assemble(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                                 admission_audit=[admitted, second], items=[item], corpus_id="exp", version="v1",
                                 split_seed="seed", output_root=Path(directory) / str(index))
                    self.assertIn("duplicate quality decisions", captured.exception.blockers[0])


if __name__ == "__main__":
    unittest.main()
