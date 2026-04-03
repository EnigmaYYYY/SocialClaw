from datetime import datetime
from typing import List, Optional, Dict, Any
from beanie import Indexed
from core.oxm.mongo.document_base import DocumentBase
from pydantic import Field, ConfigDict, BaseModel
from pymongo import IndexModel, ASCENDING, DESCENDING, TEXT
from core.oxm.mongo.audit_base import AuditBase
from common_utils.datetime_utils import to_iso_format


class TopicInfo(BaseModel):
    """
    Topic information aligned with design document.
    """

    name: str = Field(..., description="Topic name (phrased tag)")
    summary: str = Field(..., description="One-sentence summary")
    status: str = Field(..., description="exploring/disagreement/consensus/implemented")
    last_active_at: datetime = Field(..., description="Last active time (=updateTime)")
    id: Optional[str] = Field(
        default=None,
        description="Unique topic ID (system generated, LLM does not need to provide)",
    )
    update_type: Optional[str] = Field(
        default=None,
        description="'new' | 'update' (used only during incremental updates)",
    )
    old_topic_id: Optional[str] = Field(
        default=None,
        description="Points to the old topic when updating (used only during incremental updates)",
    )
    evidences: Optional[List[str]] = Field(
        default_factory=list, description="memcell_ids as evidence"
    )
    confidence: Optional[str] = Field(
        default=None, description="'strong' | 'weak' - confidence level"
    )

    model_config = ConfigDict(json_encoders={datetime: to_iso_format})


class RoleUser(BaseModel):
    """
    Role user model
    """

    user_id: str = Field(..., description="User ID")
    user_name: str = Field(..., description="User name")

    model_config = ConfigDict(json_encoders={datetime: to_iso_format})


class RoleAssignment(BaseModel):
    """
    Role assignment model (including evidence and confidence)
    """

    user_id: str = Field(..., description="User ID")
    user_name: str = Field(..., description="User name")
    confidence: Optional[str] = Field(
        default=None, description="Confidence level: 'strong' | 'weak'"
    )
    evidences: Optional[List[str]] = Field(
        default_factory=list, description="memcell_ids supporting this role assignment"
    )

    model_config = ConfigDict(json_encoders={datetime: to_iso_format})


class MemberStyle(BaseModel):
    """
    Per-member speech style profile in a group.
    """

    user_id: str = Field(..., description="User ID")
    user_name: str = Field(..., description="User name")
    catchphrase: Optional[List[Dict[str, Any]]] = Field(
        default_factory=list, description="Catchphrase entries with evidences"
    )
    communication_style: Optional[List[Dict[str, Any]]] = Field(
        default_factory=list, description="Communication style entries with evidences"
    )
    humor_use: Optional[List[Dict[str, Any]]] = Field(
        default_factory=list, description="Humor use entries with evidences"
    )
    source: Optional[str] = Field(
        default=None, description="Source profile: self_profile|user_profile"
    )

    model_config = ConfigDict(json_encoders={datetime: to_iso_format})


class GroupProfile(DocumentBase, AuditBase):
    """
    Group memory document model

    Stores group basic information, role definitions, user tags, recent topics, and other information.
    """

    group_id: Indexed(str) = Field(..., description="Group ID")

    # ==================== Version control fields ====================
    version: Optional[str] = Field(
        default=None, description="Version number, used for version management"
    )
    is_latest: Optional[bool] = Field(
        default=True, description="Whether it is the latest version, default is True"
    )

    # Group basic information
    group_name: Optional[str] = Field(
        default=None, description="Group name (not necessarily present)"
    )

    # Group topics and knowledge domains
    topics: Optional[List[TopicInfo]] = Field(
        default_factory=list,  # Modified to default_factory=list to avoid None value
        description="List of recent group topics, including fields such as name, summary, status, last_active_at, id, update_type, old_topic_id",
    )

    # Group role definitions
    roles: Optional[Dict[str, List[RoleAssignment]]] = Field(
        default_factory=dict,  # Modified to default_factory=dict to avoid None value
        description="Predefined group roles, each assignment contains user_id, user_name, confidence, evidences fields",
    )

    # Per-member speech style snapshot in this group
    member_styles: Optional[List[MemberStyle]] = Field(
        default_factory=list,
        description="Per-member speech style and catchphrase profiles within the group",
    )

    # Timestamp
    timestamp: int = Field(..., description="Occurrence timestamp")

    # Group long-term subject
    subject: Optional[str] = Field(default=None, description="Group long-term subject")

    # Group recent topics summary
    summary: Optional[str] = Field(
        default=None, description="Summary of recent group topics"
    )

    # Extension field
    extend: Optional[Dict[str, Any]] = Field(
        default=None, description="Reserved extension field"
    )

    model_config = ConfigDict(
        collection="group_profiles",
        validate_assignment=True,
        json_encoders={datetime: to_iso_format},
        json_schema_extra={
            "example": {
                "group_id": "group_12345",
                "group_name": "Friends Chat",
                "topics": [
                    {
                        "name": "Weekend Plans",
                        "summary": "Discussing where to meet and what to do this weekend",
                        "status": "consensus",
                        "last_active_at": "2025-09-22T10:00:00+00:00",
                        "id": "topic_001",
                        "update_type": "new",
                        "old_topic_id": None,
                        "confidence": "strong",
                        "evidences": ["memcell_001", "memcell_002"],
                    }
                ],
                "roles": {
                    "organizer": [
                        {
                            "user_id": "user_123",
                            "user_name": "Zhang San",
                            "confidence": "strong",
                            "evidences": ["memcell_001", "memcell_002"],
                        }
                    ]
                },
                "timestamp": 1726992000000,
                "subject": "Friends' daily life and plans",
                "summary": "Recent chats focus on daily updates, outings, and shared plans",
                "extend": {"note": "example"},
            }
        },
    )

    class Settings:
        """Beanie settings"""

        name = "group_profiles"
        indexes = [
            # Composite unique index on group_id and version
            IndexModel(
                [("group_id", ASCENDING), ("version", ASCENDING)],
                unique=True,
                name="idx_group_id_version_unique",
            ),
            # Index on is_latest field (for fast querying of the latest version)
            IndexModel(
                [("group_id", ASCENDING), ("is_latest", ASCENDING)],
                name="idx_group_id_is_latest",
            ),
            # Text index on group_name (supports fuzzy search)
            IndexModel([("group_name", TEXT)], name="idx_group_name_text"),
            # Audit field indexes
            IndexModel([("created_at", DESCENDING)], name="idx_created_at"),
            IndexModel([("updated_at", DESCENDING)], name="idx_updated_at"),
            # Composite index: group_id + updated_at
            IndexModel(
                [("group_id", ASCENDING), ("updated_at", DESCENDING)],
                name="idx_group_id_updated_at",
            ),
        ]
        validate_on_save = True
        use_state_management = True
