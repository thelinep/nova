# JBLITZAR GitHub-Python candidate: preliminary review

Review date: 2026-10-13
Candidate ID: `corpus-cand-jblitzar-001`
Disposition: **INTEGRITY SNAPSHOT FROZEN — RIGHTS NOT APPROVED — NOT ADMITTED**

This review records source discovery and blocks unsupported permission claims.
It is not a legal opinion, a source-level `RightsDecision`, or authorization to
fetch, transform, evaluate, train on, retain, transmit, or distribute data.

## Findings from the draft and publisher pages

The pasted draft mixes two identities:

1. The publisher's [`jblitzar/github-python` card](https://huggingface.co/datasets/jblitzar/github-python)
   describes a “Licensed Subset” distributed as
   `mega_licensed_corpus_redacted.txt`, accompanied by `python_files.txt` and a
   vocabulary file. The card reports 53,017 files and says file contents retain
   their original repository licenses. The live Hub page itself is tagged
   GPL-3.0 and its viewer currently shows about 60.3 million rows; that is not
   the same count or format as the card's 53,017-file subset.
2. The draft's `hf_dataset` field names
   [`jblitzar/github-python-corpus`](https://huggingface.co/datasets/jblitzar/github-python-corpus).
   Its current Hub metadata labels that dataset GPL-3.0 and exposes a converted
   Parquet dataset whose viewer currently shows about 20 million rows. It is
   not established that this is the same artifact as the 53,017-file
   concatenated Licensed Subset.

The publisher card distinguishes its own licensing from the code: it says the
dataset card and aggregation scripts are GPLv3, while each code snippet remains
under its original repository license. The card reports an allow-list and
collection/redaction methods, but those are publisher claims; they are not
independent verification of the present candidate's files or licenses.

The online pages are mutable. The comparison below therefore uses exact Hub
revisions and recorded file hashes rather than `main`. The raw source and URL
list were downloaded for comparison into a temporary directory and removed
after the comparison; no candidate code is being retained in the project.

## Pinned comparison result

| Artifact | Pinned revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `github-python/mega_licensed_corpus_redacted.txt` | `a99387cb1d86b6c73a71f359f9d85a4e966e32ba` | 767,255,913 | `25872f695fefeb4106ddd7006c798767be925a67abadf5d22da240541cad6717` |
| `github-python/python_files.txt` | `a99387cb1d86b6c73a71f359f9d85a4e966e32ba` | 4,307,290 | `575bdf59fa452706cf4ad981bd2e501d82494bfc9c0c70491aa5b8cb9f791deb` |
| `github-python-corpus/data/train-00000-of-00002.parquet` | `a405767d68588f2bda01dff14339e09ecbdc68f6` | 178,961,370 | `f24274e1bc31eb5d4158b5937b2c92a6f2dd3897107b6351227399d84d6f7626` |
| `github-python-corpus/data/train-00001-of-00002.parquet` | `a405767d68588f2bda01dff14339e09ecbdc68f6` | 178,308,377 | `45f1eaca33414cb6d9e726ff17e7f39549d57cc28a7168a0c7affbafa91f1f6b` |

The two Parquet shards contain a single `text` column and 19,999,849 total
rows. Concatenating those UTF-8 strings in row order reconstructs exactly
767,255,913 bytes and SHA-256
`25872f695fefeb4106ddd7006c798767be925a67abadf5d22da240541cad6717`, an exact
byte-for-byte match for the pinned raw text file. The Parquet corpus is thus an
alternate line-row representation of this same text snapshot, not an
independent content corpus. Do not count or train on both as separate sources.

One important integrity discrepancy remains: the raw file contains 86,616
lines exactly equal to `# <FILESEP>`, but the companion URL list has 53,017
lines. That is a difference of 33,599 markers. The card describes one marker
per file; the observed count means a blind split-and-join by index is not
validated. Markers may occur in source contents, the count may have changed,
or the artifact may not correspond to the listed URLs; this comparison alone
cannot distinguish those cases. Per-file source and license mapping remains
blocked.

## Pinned source metadata and license retrieval follow-up

The companion `jblitzar/github-python-metadata` Parquet was fetched at immutable
Hub revision `f29eaec68cd69797a9c13d6a734057a1a2a5159c`. Its sole data shard is
2,781,996 bytes with SHA-256
`1b473937ed796c937c4e567178ccc9d96877ee75c36cf55429e558766b4956d7`. It has
53,017 rows and the columns `repo_owner`, `repo_name`, `file_path`, `file_url`,
and `repo_url`; it has no license or source-commit column. The 53,017 `file_url`
values match `python_files.txt` exactly, including row order. Those rows refer
to 16,447 distinct repositories, so the URL-to-repository mapping is now
verified even though the separator-based extraction is not.

A bounded exploratory query of GitHub's current repository license endpoint
for the 20 repositories with the most listed files found: 5 SPDX identifiers
were returned, 3 results were `NOASSERTION`, and 12 returned HTTP 404. This is
only a current-state signal; it does not establish the license at corpus
collection time or at an immutable source commit. The metadata URLs point to
moving branch names and do not record source commits. Do not use these results
as training or evaluation permission, and do not infer that 404 means the
source is unlicensed. A complete rights review still needs immutable source
revisions and license/notice evidence for each retained file, or a publisher
attestation that binds the exact file list to those records.

## Why the pasted permission matrix is not applied

The draft pre-fills training, validation, test, and derivative permissions as
`true` by SPDX family. That turns a license-family label into a blanket use
decision before identifying the exact artifact, each file's originating
repository and revision, license evidence, notices, and reviewer authority.
The existing `guru-source-rights-v2` contract requires explicit, evidence-backed
decisions for training, evaluation, ephemeral transformation, transformed-data
retention, provider transmission, and weight distribution. It deliberately
does not infer those decisions from SPDX identifiers.

Guru's owner-selected I7 policy separately requires local qualified evaluation,
denies external provider transmission and weight distribution, and limits
transformed data to ephemeral use. The evaluator is not yet qualified and no
ephemeral real-data training runtime exists. A source permission would not
remove those project-level blockers.

## Current candidate gate

| Gate | Status | Required evidence |
| --- | --- | --- |
| Exact artifact identity | **Resolved for comparison** | Use the pinned raw text file as the canonical byte snapshot; the pinned Parquet shards reconstruct it exactly and are a duplicate representation. |
| Immutable upstream pin | **Resolved for compared files** | Exact Hub revisions, file paths, sizes and SHA-256 values are recorded above and in `jblitzar-snapshot-freeze.json`. |
| Snapshot integrity | **Partial** | Raw/parquet bytes and URL-list bytes are hashed; the URL-list count and sentinel count disagree, so file-level integrity is not established. |
| Per-file provenance | **Open** | Preserve source URL, repository-relative path, immutable source commit where obtainable, raw-source hash, extracted-content hash, transformed-content hash, and transformation version. |
| Per-file license evidence | **Open** | Resolve each source repository and the license/notice evidence at the pinned revision; reject unknown, conflicting, or excluded licenses. |
| Rights decision | **Absent** | A named authorized reviewer must decide each permitted use and cite hashed evidence in a `guru-source-rights-v2` record. Do not create an approved record with placeholder or inferred values. |
| Security and data quality | **Open** | Independently re-scan for secrets, verify file-list and separator alignment, deduplicate/group by repository and file lineage, and define quality/split checks. |
| I7 runtime gates | **Blocked** | Qualified local evaluator and an approved ephemeral-only path are still required; persistent corpus assembly remains disabled. |

## Required freeze procedure

1. Select and name one source artifact and Hub repository.
2. Resolve and record its immutable revision before fetching its data files.
3. Fetch only the chosen artifact and its source metadata; do not ingest the
   unrelated elaborated/copy dataset.
4. Hash the original archive/files, URL list, license/notice evidence, and
   resulting frozen manifest. Keep raw and transformed hashes distinct because
   the card describes formatting and redaction steps.
5. Verify file-list count, separator count, record ordering, URL-to-file
   correspondence, and the publisher's stated count. A separator-based split
   is not accepted until collisions and ordering are checked against the exact
   artifact format.
6. Populate a manifest with unresolved rows explicitly rejected/quarantined;
   do not mark the entire corpus permitted just because its listed license is
   on an allow-list.
7. Obtain a named, evidence-backed `guru-source-rights-v2` decision for the
   exact frozen snapshot. Record training/evaluation/transformation scopes
   independently; preserve the project's I7 denials.
8. Keep the candidate quarantined until source rights, security/quality review,
   and evaluator/runtime gates each pass. Do not create an admission audit as a
   substitute for those gates.

## Review outcome

The Licensed Subset is a plausible **candidate for further investigation**,
and its alternate Parquet representation has now been proven byte-equivalent
to the raw text snapshot. The file-to-URL mapping and per-file license evidence
remain unresolved. `rights_approved` must remain false, no permission matrix
may be treated as approved, and the candidate must not enter training or
evaluation. Temporary source copies were removed after comparison; only
hashes, counts, and findings are retained in this review record.
