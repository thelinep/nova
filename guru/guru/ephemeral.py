"""Temporary storage guards for synthetic Guru training smokes."""
from __future__ import annotations

import tempfile
from pathlib import Path


def training_scratch_root() -> Path:
    """Return OS scratch storage, refusing a root inside the Guru checkout.

    Synthetic smoke artifacts are temporary. Rejecting an in-checkout
    ``TMPDIR`` prevents accidental repository retention of those artifacts.
    """
    root = Path(tempfile.gettempdir()).resolve()
    repo_root = Path(__file__).resolve().parents[1]
    try:
        root.relative_to(repo_root)
    except ValueError:
        return root
    raise RuntimeError("synthetic training scratch directory must be outside the Guru checkout")
