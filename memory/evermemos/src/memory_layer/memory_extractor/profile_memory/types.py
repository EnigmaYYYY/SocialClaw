"""Dataclasses and type definitions for profile memory extraction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from api_specs.memory_types import BaseMemory, MemoryType, MemCell
from memory_layer.memory_extractor.base_memory_extractor import MemoryExtractRequest


@dataclass
class ImportanceEvidence:
    """Aggregated evidence indicating user importance within a group."""

    user_id: str
    group_id: str
    speak_count: int = 0
    refer_count: int = 0
    conversation_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "user_id": self.user_id,
            "group_id": self.group_id,
            "speak_count": self.speak_count,
            "refer_count": self.refer_count,
            "conversation_count": self.conversation_count,
        }


@dataclass
class GroupImportanceEvidence:
    """Group-level importance assessment for a user."""

    group_id: str
    evidence_list: List[ImportanceEvidence]
    is_important: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "group_id": self.group_id,
            "evidence_list": [
                evidence.to_dict()
                if hasattr(evidence, "to_dict")
                else evidence
                for evidence in (self.evidence_list or [])
            ],
            "is_important": self.is_important,
        }


@dataclass
class ProfileMemory(BaseMemory):
    """Profile memory result class."""

    user_name: Optional[str] = None
    output_reasoning: Optional[str] = None

    # value/evidence list fields
    way_of_decision_making: Optional[List[Dict[str, Any]]] = None
    traits: Optional[List[Dict[str, Any]]] = None
    personality: Optional[List[Dict[str, Any]]] = None
    interests: Optional[List[Dict[str, Any]]] = None
    life_habit_preference: Optional[List[Dict[str, Any]]] = None
    communication_style: Optional[List[Dict[str, Any]]] = None
    catchphrase: Optional[List[Dict[str, Any]]] = None
    owner_catchphrase: Optional[List[Dict[str, Any]]] = None
    user_to_friend_catchphrase: Optional[List[Dict[str, Any]]] = None
    occupation: Optional[List[Dict[str, Any]]] = None
    relationship: Optional[List[Dict[str, Any]]] = None

    # single/scalar fields
    gender: Optional[str] = None
    age: Optional[Dict[str, Any]] = None
    education_level: Optional[Dict[str, Any]] = None
    intimacy_level: Optional[Dict[str, Any]] = None
    life_stage: Optional[str] = None
    intermediary_name: Optional[str] = None
    intermediary_context: Optional[str] = None

    dislikes: Optional[List[Dict[str, Any]]] = None
    core_values: Optional[List[Dict[str, Any]]] = None
    recent_events: Optional[List[Dict[str, Any]]] = None

    motivation_system: Optional[List[Dict[str, Any]]] = None
    fear_system: Optional[List[Dict[str, Any]]] = None
    value_system: Optional[List[Dict[str, Any]]] = None
    humor_use: Optional[List[Dict[str, Any]]] = None
    user_to_friend_chat_style_preference: Optional[List[Dict[str, Any]]] = None
    chat_interaction_pattern: Optional[List[Dict[str, Any]]] = None

    risk_level: Optional[str] = None
    warning_msg: Optional[str] = None

    group_importance_evidence: Optional[GroupImportanceEvidence] = None

    def __post_init__(self) -> None:
        """Ensure the memory type is set to PROFILE."""
        self.memory_type = MemoryType.PROFILE

    def to_dict(self) -> Dict[str, Any]:
        """Override to_dict() to include all fields of ProfileMemory."""
        base_dict = super().to_dict()
        base_dict.update(
            {
                "user_name": self.user_name,
                "output_reasoning": self.output_reasoning,
                "way_of_decision_making": self.way_of_decision_making,
                "traits": self.traits,
                "personality": self.personality,
                "interests": self.interests,
                "life_habit_preference": self.life_habit_preference,
                "communication_style": self.communication_style,
                "catchphrase": self.catchphrase,
                "owner_catchphrase": self.owner_catchphrase,
                "user_to_friend_catchphrase": self.user_to_friend_catchphrase,
                "occupation": self.occupation,
                "gender": self.gender,
                "age": self.age,
                "education_level": self.education_level,
                "intimacy_level": self.intimacy_level,
                "life_stage": self.life_stage,
                "relationship": self.relationship,
                "intermediary_name": self.intermediary_name,
                "intermediary_context": self.intermediary_context,
                "dislikes": self.dislikes,
                "core_values": self.core_values,
                "recent_events": self.recent_events,
                "motivation_system": self.motivation_system,
                "fear_system": self.fear_system,
                "value_system": self.value_system,
                "humor_use": self.humor_use,
                "user_to_friend_chat_style_preference": self.user_to_friend_chat_style_preference,
                "chat_interaction_pattern": self.chat_interaction_pattern,
                "risk_level": self.risk_level,
                "warning_msg": self.warning_msg,
                "group_importance_evidence": (
                    (
                        self.group_importance_evidence.to_dict()
                        if hasattr(self.group_importance_evidence, "to_dict")
                        else self.group_importance_evidence
                    )
                    if self.group_importance_evidence
                    else None
                ),
            }
        )

        return base_dict


@dataclass
class ProfileMemoryExtractRequest(MemoryExtractRequest):
    """
    Request payload used by ProfileMemoryExtractor.

    Profile extraction can use either:
    1. memcell_list (legacy): Extract raw messages from MemCells
    2. raw_messages (preferred): Directly use raw conversation data
    """

    memcell: Optional[MemCell] = None
    memcell_list: List[MemCell] = None
    user_id_list: Optional[List[str]] = None
    owner_user_id: Optional[str] = None
    raw_messages: Optional[List[Dict[str, Any]]] = None

    def __post_init__(self):
        if self.memcell_list is None:
            self.memcell_list = []
