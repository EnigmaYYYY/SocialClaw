from datetime import datetime
from typing import List, Optional, Dict, Any
from beanie import Indexed
from core.oxm.mongo.document_base import DocumentBase
from pydantic import Field, ConfigDict
from pymongo import IndexModel, ASCENDING, DESCENDING
from core.oxm.mongo.audit_base import AuditBase


class GroupUserProfileMemory(DocumentBase, AuditBase):
    """
    Core memory document model

    Unified storage for user's basic information, personal profile, and preference settings.
    A single document contains data of all three memory types.

    All profile fields now use the embedded evidences format:
    - Skills: [{"value": "Python", "level": "Advanced", "evidence_level": "L1", "evidences": [{"event_id": "2024-01-01|conv_123", "reasoning": "用户明确说..."}]}]
    - Legacy format: [{"skill": "Python", "level": "Advanced", "evidences": ["..."]}] (automatically converted)
    - Other attributes: [{"value": "xxx", "evidence_level": "L2", "evidences": [{"event_id": "...", "reasoning": "..."}]}]

    Evidence format supports both:
    - Old: evidences: ["2024-01-01|conv_123"] (string list)
    - New: evidences: [{"event_id": "2024-01-01|conv_123", "reasoning": "推断理由"}] (dict list with reasoning)
    """

    user_id: Indexed(str) = Field(..., description="User ID")
    group_id: Indexed(str) = Field(..., description="Group ID")

    # ==================== Version control fields ====================
    version: Optional[str] = Field(
        default=None, description="Version number, used for version management"
    )
    is_latest: Optional[bool] = Field(
        default=True, description="Whether it is the latest version, default is True"
    )

    user_name: Optional[str] = Field(default=None, description="User name")
    gender: Optional[str] = Field(default=None, description="Gender")
    occupation: Optional[str] = Field(default=None, description="Occupation")
    relationship: Optional[str] = Field(
        default=None, description="Relationship to owner (if applicable)"
    )

    # ==================== Profile fields ====================
    output_reasoning: Optional[str] = Field(
        default=None, description="Reasoning explanation for this output"
    )
    motivation_system: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Motivation system, containing value/level/evidences"
    )
    fear_system: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Fear system, containing value/level/evidences"
    )
    value_system: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Value system, containing value/level/evidences"
    )
    humor_use: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Humor usage style, containing value/level/evidences"
    )
    life_habit_preference: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Life habit preference, including evidences"
    )
    communication_style: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Communication style, including evidences"
    )
    catchphrase: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Catchphrase entries, including evidences"
    )
    user_to_friend_catchphrase: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="User-to-friend catchphrase entries, including evidences",
    )
    user_to_friend_chat_style_preference: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="User-to-friend chat style preference entries, including evidences",
    )

    # Other profile fields - Format: [{"value": "xxx", "evidences": ["id1"]}]
    personality: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="User personality, including evidences"
    )
    interests: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Hobbies and interests, including evidences"
    )
    way_of_decision_making: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Decision-making style, including evidences"
    )

    group_importance_evidence: Optional[Dict[str, Any]] = Field(
        default=None, description="Evidence of group importance"
    )

    model_config = ConfigDict(
        collection="group_core_profile_memory",
        validate_assignment=True,
        json_encoders={datetime: lambda dt: dt.isoformat()},
        json_schema_extra={
            "example": {
                "user_id": "user_12345",
                "group_id": "group_12345",
                "personality": "Introverted but good at communication, enjoys deep thinking",
                "interests": [{"value": "Reading", "evidences": ["2024-01-01|conv_123"]}],
                "extend": {"priority": "high"},
            }
        },
    )

    class Settings:
        """Beanie settings"""

        name = "group_core_profile_memory"
        indexes = [
            # Composite unique index on user_id, group_id, and version
            IndexModel(
                [
                    ("user_id", ASCENDING),
                    ("group_id", ASCENDING),
                    ("version", ASCENDING),
                ],
                unique=True,
                name="idx_user_id_group_id_version_unique",
            ),
            # Index for querying the latest version by user_id
            IndexModel(
                [
                    ("user_id", ASCENDING),
                    ("group_id", ASCENDING),
                    ("is_latest", ASCENDING),
                ],
                name="idx_user_id_group_id_is_latest",
            ),
            # Index for querying the latest version by group_id (supports get_by_group_id method)
            IndexModel(
                [("group_id", ASCENDING), ("is_latest", ASCENDING)],
                name="idx_group_id_is_latest",
            ),
            # Indexes for audit fields
            IndexModel([("created_at", DESCENDING)], name="idx_created_at"),
            IndexModel([("updated_at", DESCENDING)], name="idx_updated_at"),
        ]
        validate_on_save = True
        use_state_management = True
