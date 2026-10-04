"""Secret and optional PII redaction with explicit action records."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from guru.audit_log import digest_json
from guru.schemas.disclosure import RedactionAction

SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("pem_private_key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"), "[REDACTED_PRIVATE_KEY]"),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_AWS_KEY]"),
    ("bearer_token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.IGNORECASE), "[REDACTED_BEARER_TOKEN]"),
    ("openai_api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_API_KEY]"),
)
PII_PATTERNS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("email", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), "[REDACTED_EMAIL]"),
    ("phone", re.compile(r"(?<!\w)(?:\+?\d[\d .()/-]{8,}\d)(?!\w)"), "[REDACTED_PHONE]"),
)


@dataclass(frozen=True)
class Sanitized:
    payload: Any
    redactions: list[RedactionAction]
    payload_digest: str
    sanitized_digest: str


def sanitize(payload: Any, *, redact_pii: bool) -> Sanitized:
    """Return a structurally preserved JSON payload with secrets stripped."""
    before_digest = digest_json(payload)
    actions: list[RedactionAction] = []

    def clean_string(value: str, location: str) -> str:
        patterns = (*SECRET_PATTERNS, *(PII_PATTERNS if redact_pii else ()))
        cleaned = value
        for kind, pattern, replacement in patterns:
            def replace(match: re.Match[str]) -> str:
                actions.append(RedactionAction(kind=kind, location=f"{location}@{match.start()}:{match.end()}", replacement=replacement))
                return replacement
            cleaned = pattern.sub(replace, cleaned)
        return cleaned

    def walk(value: Any, location: str) -> Any:
        if isinstance(value, str):
            return clean_string(value, location)
        if isinstance(value, list):
            return [walk(item, f"{location}[{index}]") for index, item in enumerate(value)]
        if isinstance(value, dict):
            return {key: walk(item, f"{location}.{key}") for key, item in value.items()}
        if value is None or isinstance(value, (bool, int, float)):
            return value
        raise TypeError(f"payload contains unsupported JSON value type: {type(value).__name__}")

    safe = walk(payload, "$")
    return Sanitized(safe, actions, before_digest, digest_json(safe))
