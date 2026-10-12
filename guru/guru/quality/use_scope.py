"""Owner-selected Guru-Code use scopes, independent of model licenses."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GuruUseScopePolicy:
    version: str = "guru-use-scope-i7-v1"
    evaluation: str = "local_qualified_only"
    provider_transmission: str = "deny_external"
    transformed_data_retention: str = "ephemeral_only"
    weight_distribution: str = "private_local_only"

    def permits_evaluation(self, source_rights: object, execution_scope: str) -> bool:
        return execution_scope == "local" and getattr(source_rights, "allow_evaluation", False) is True

    def permits_external_transmission(self, _source_rights: object | None = None) -> bool:
        return False

    def permits_transformed_data_retention(self, _source_rights: object | None = None) -> bool:
        # The selected policy allows ephemeral processing only. Corpus admission
        # and assembly persist transformed examples, so they are not permitted.
        return False

    def permits_persisted_corpus(self) -> bool:
        return False

    def permits_weight_distribution(self, _source_rights: object | None = None) -> bool:
        return False


GURU_USE_SCOPE_POLICY = GuruUseScopePolicy()
