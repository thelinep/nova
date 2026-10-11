from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pydantic import ValidationError

from guru.corpus.assemble import CorpusAssemblyBlocked, assemble, preflight
from guru.schemas.corpus import CorpusKind, CorpusManifest, CorpusStatus
from guru.schemas.corpus_item import CorpusItem
from guru.schemas.teacher_lineage import AccessMethod, InputDisclosure, InputType, OutputRights, ReviewStatus, TeacherLineage


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


def corpus_items(count: int = 40) -> list[CorpusItem]:
    return [CorpusItem(
        item_id=f"item-{index:03d}", task_id=f"task-{index:03d}",
        prompt=f"Implement function {index}", target=f"def f{index}(): return {index}",
        target_source="teacher", teacher_lineage_id="teacher-1", source_digest=f"{index:064x}",
    ) for index in range(count)]


def admission_rows(count: int = 40) -> list[dict[str, str]]:
    items = corpus_items(count)
    return [{"event": "item_admission", "item_id": item.item_id, "decision": "admit",
             "item_digest": item.canonical_digest(), "payload_digest": f"{index:064x}"}
            for index, item in enumerate(items)]


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

    def test_assemble_raises_typed_blocker_before_writing(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaises(CorpusAssemblyBlocked) as captured:
                assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[], admission_audit=[],
                         items=corpus_items(), corpus_id="draft", version="v1", split_seed="seed",
                         output_root=Path(directory) / "corpora")
            self.assertIn("missing approved teacher", captured.exception.blockers)
            self.assertFalse((Path(directory) / "corpora").exists())

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
            self.assertIn("floor(0.8N)", result.split_rule)
            self.assertIn("provenance only", result.split_rule)

    def test_all_items_for_a_task_stay_in_the_same_split(self) -> None:
        rows = [*corpus_items(40), CorpusItem(
            item_id="item-duplicate-example", task_id="task-000", prompt="another view",
            target="def other(): return 0", target_source="teacher", teacher_lineage_id="teacher-1",
            source_digest="f" * 64,
        )]
        extra = rows[-1]
        with TemporaryDirectory() as directory:
            assemble(kind="c_rd", task_manifest=task_rows(), teacher_registry=[approved_teacher()],
                     admission_audit=[*admission_rows(), {"event": "item_admission", "item_id": extra.item_id,
                                                          "decision": "admit", "item_digest": extra.canonical_digest()}],
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
                split_seed="seed", split_rule="deterministic", item_count=0,
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
                split_seed="seed", split_rule="deterministic", item_count=0,
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
        audit = admission_rows(1) + [{"event": "item_admission", "item_id": "item-001", "decision": "reject",
                                      "item_digest": items[1].canonical_digest()}]
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
                    with self.assertRaisesRegex(ValueError, "item_digest|content digest"):
                        assemble(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                                 admission_audit=audit, items=[item], corpus_id="exp", version="v1",
                                 split_seed="seed", output_root=Path(directory) / str(len(audit[0])))

    def test_assembly_rejects_duplicate_or_conflicting_decisions(self) -> None:
        item = corpus_items(1)[0]
        admitted = {"event": "item_admission", "item_id": item.item_id, "decision": "admit",
                    "item_digest": item.canonical_digest()}
        with TemporaryDirectory() as directory:
            for index, second in enumerate((dict(admitted), {**admitted, "decision": "reject"})):
                with self.subTest(second=second):
                    with self.assertRaisesRegex(ValueError, "duplicate quality decisions"):
                        assemble(kind="c_rd", task_manifest=task_rows(1), teacher_registry=[approved_teacher()],
                                 admission_audit=[admitted, second], items=[item], corpus_id="exp", version="v1",
                                 split_seed="seed", output_root=Path(directory) / str(index))


if __name__ == "__main__":
    unittest.main()
