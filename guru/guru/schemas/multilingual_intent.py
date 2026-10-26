"""Small language-neutral intent contract for the Hindi/Sanskrit input study.

This schema validates hand-authored annotations only. It does not parse a
natural-language request or imply that a model can produce this structure.
"""
from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import Field, model_validator

from .teacher_lineage import StrictModel


class InputLanguage(str, Enum):
    HINDI = "hi"
    SANSKRIT = "sa"
    ENGLISH_CONTROL = "en"


class InputScript(str, Enum):
    DEVANAGARI = "Devanagari"
    LATIN = "Latin"


class IntentUtterance(StrictModel):
    language: InputLanguage
    script: InputScript
    text: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def script_matches_language(self) -> IntentUtterance:
        if self.language in {InputLanguage.HINDI, InputLanguage.SANSKRIT} and self.script is not InputScript.DEVANAGARI:
            raise ValueError("Hindi and Sanskrit v1 fixtures must use Devanagari")
        if self.language is InputLanguage.ENGLISH_CONTROL and self.script is not InputScript.LATIN:
            raise ValueError("the English control must use Latin script")
        return self


class SemanticIntent(StrictModel):
    """Canonical meaning record, separate from the language used to ask."""

    schema_version: Literal["guru-semantic-intent-v1"] = "guru-semantic-intent-v1"
    task_id: str = Field(min_length=1, max_length=128)
    target_language: Literal["python"] = "python"
    operation: str = Field(min_length=1, max_length=128)
    input_types: list[str] = Field(min_length=1, max_length=16)
    constraints: list[str] = Field(default_factory=list, max_length=32)
    acceptance_conditions: list[str] = Field(min_length=1, max_length=32)
    utterances: list[IntentUtterance] = Field(min_length=2, max_length=3)

    @model_validator(mode="after")
    def require_initial_language_pair(self) -> SemanticIntent:
        languages = {utterance.language for utterance in self.utterances}
        if not {InputLanguage.HINDI, InputLanguage.SANSKRIT}.issubset(languages):
            raise ValueError("v1 intent requires both Hindi and Sanskrit utterances")
        if len(languages) != len(self.utterances):
            raise ValueError("each language may appear once in a task intent")
        if len(self.input_types) != len(set(self.input_types)):
            raise ValueError("input_types must be unique")
        if len(self.constraints) != len(set(self.constraints)):
            raise ValueError("constraints must be unique")
        if len(self.acceptance_conditions) != len(set(self.acceptance_conditions)):
            raise ValueError("acceptance_conditions must be unique")
        return self
