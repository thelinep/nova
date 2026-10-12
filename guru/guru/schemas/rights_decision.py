"""Explicit, versioned per-source rights decisions with evidence provenance."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import Field, StrictBool, field_validator, model_validator

from .teacher_lineage import StrictModel


class RightsAuthorityBasis(str, Enum):
    LICENSE_TEXT = "license_text"
    PROVIDER_TERMS = "provider_terms"
    DIRECT_PERMISSION = "direct_permission"
    PUBLIC_DOMAIN_RECORD = "public_domain_record"
    OWNER_ATTESTATION = "owner_attestation"


class RightsEvidenceReference(StrictModel):
    evidence_id: str = Field(min_length=1)
    uri: str = Field(min_length=1, description="Evidence URI or repository-relative path.")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class SourceRights(StrictModel):
    allow_training: StrictBool
    allow_evaluation: StrictBool
    allow_transformed_data_retention: StrictBool
    allow_provider_transmission: StrictBool
    allow_weight_distribution: StrictBool


class RightsDecision(StrictModel):
    """Named review result for one immutable source artifact."""

    schema_version: Literal["guru-source-rights-v1"]
    source_id: str = Field(min_length=1)
    uri: str = Field(min_length=1)
    revision: str = Field(min_length=1)
    artifact_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    provenance_statement: str = Field(min_length=1)
    authority_basis: RightsAuthorityBasis
    authority_description: str = Field(min_length=1)
    rights: SourceRights
    reviewer: str = Field(min_length=1)
    decided_at: datetime
    evidence_refs: list[RightsEvidenceReference] = Field(min_length=1)

    @field_validator("decided_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("decided_at must include a timezone")
        return value

    @model_validator(mode="after")
    def require_unique_evidence_refs(self) -> RightsDecision:
        identifiers = [reference.evidence_id for reference in self.evidence_refs]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("evidence_refs must have unique evidence_id values")
        return self
