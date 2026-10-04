# Contributing to Guru

## CPU apparatus tests

Use Python 3.11 or 3.12. The Guru-Code apparatus tests need only the packages
in `requirements-test.txt`; this avoids installing Guru's training stack,
including PyTorch and SentencePiece.

From the `guru/` project root, create and activate an isolated environment,
then install the test dependencies:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-test.txt
```

Run the CPU apparatus suite from the same project root:

```sh
python -m pytest tests/test_disclosure_gate.py tests/test_quality_gate.py tests/test_corpus_assemble.py tests/test_teacher_intake.py -q
```

`requirements-test.txt` pins the direct test dependencies. There is not yet a
lockfile for their transitive dependencies, so a fully locked dependency graph
remains future work.
