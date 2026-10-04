"""Append-only, payload-free JSONL audit primitives."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from typing import Any


def digest_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def append_audit_line(path: Path, *, event: str, payload_digest: str | None,
                      fields: dict[str, Any]) -> None:
    """Append a single canonical event. Callers must pass metadata, never payloads."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "payload_digest": payload_digest,
        **fields,
    }
    raw = (json.dumps(record, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        view = memoryview(raw)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
