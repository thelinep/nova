# Contributing to Guru

## CPU apparatus tests

Use Python 3.12. The Guru-Code apparatus tests need only the packages
in `requirements-test.txt`; this avoids installing Guru's training stack,
including PyTorch and SentencePiece.

From the `guru/` project root, create and activate an isolated environment,
then install the hashed, transitively locked test dependencies:

```sh
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip sync requirements-test.lock
```

Run the CPU apparatus, evaluator-mock, trajectory and experiment-decision suite
from the same project root:

```sh
python -m pytest tests/test_disclosure_gate.py tests/test_quality_gate.py tests/test_corpus_assemble.py tests/test_teacher_intake.py tests/test_code_evaluator.py tests/test_trajectories.py tests/test_experiment_decision.py -q
```

`requirements-test.txt` pins the direct test dependencies. Regenerate the
hash-checked lockfile after an intentional dependency update with:

```sh
uv pip compile --generate-hashes -o requirements-test.lock requirements-test.txt
```
