from datetime import datetime
from token import OP
from typing import List, Optional, Dict, Any
from core.oxm.mongo.document_base import DocumentBase
from pydantic import Field, ConfigDict
from pymongo import IndexModel, ASCENDING, DESCENDING
from core.oxm.mongo.audit_base import AuditBase
from beanie import PydanticObjectId


class EpisodicMemory(DocumentBase, AuditBase):
    """
    Episodic memory document model

    Stores user's episodic memories, including event summaries, participants, topics, etc.
    Directly transferred from MemCell summaries.
    """

    user_id: Optional[str] = Field(
        default=None, description="The individual involved, None indicates group memory"
    )
    user_name: Optional[str] = Field(default=None, description="Name of the individual")
    conversation_id: Optional[str] = Field(
        default=None, description="Unified conversation ID (primary key)"
    )
    group_id: Optional[str] = Field(default=None, description="Group ID (legacy, kept for backward compatibility)")
    group_name: Optional[str] = Field(default=None, description="Group name")
    timestamp: datetime = Field(..., description="Occurrence time (timestamp)")
    participants: Optional[List[str]] = Field(
        default=None, description="Names of event participants"
    )
    summary: str = Field(..., min_length=1, description="Memory unit")
    subject: Optional[str] = Field(default=None, description="Memory unit subject")
    episode: str = Field(..., min_length=1, description="Episodic memory")
    type: Optional[str] = Field(
        default=None, description="Episode type, such as Conversation"
    )
    keywords: Optional[List[str]] = Field(default=None, description="Keywords")
    linked_entities: Optional[List[str]] = Field(
        default=None, description="Associated entity IDs"
    )

    memcell_event_id_list: Optional[List[str]] = Field(
        default=None, description="Memory unit event ID"
    )

    extend: Optional[Dict[str, Any]] = Field(
        default=None, description="Reserved extension field"
    )

    vector: Optional[List[float]] = Field(default=None, description="Text vector")
    vector_model: Optional[str] = Field(
        default=None, description="Vectorization model used"
    )

    model_config = ConfigDict(
        collection="episodic_memories",
        validate_assignment=True,
        json_encoders={datetime: lambda dt: dt.isoformat()},
        json_schema_extra={
            "example": {
                "user_id": "user_12345",
                "group_id": "group_friends_001",
                "timestamp": 1701388800,
                "participants": ["Zhang San", "Li Si"],
                "summary": "Discussed weekend plans and travel ideas",
                "subject": "Weekend planning",
                "episode": "Chatted about travel options, food choices, and meeting times for the weekend trip",
                "type": "Conversation",
                "keywords": ["travel", "food", "weekend"],
                "linked_entities": ["place_001", "event_123"],
                "extend": {"priority": "medium", "location": "City Center"},
            }
        },
    )

    @property
    def event_id(self) -> Optional[PydanticObjectId]:
        return self.id

    class Settings:
        """Beanie settings"""

        name = "episodic_memories"
        indexes = [
            # Composite index on user ID and timestamp
            IndexModel(
                [("user_id", ASCENDING), ("timestamp", DESCENDING)],
                name="idx_user_timestamp",
            ),
            # Composite index on conversation ID and timestamp (primary)
            IndexModel(
                [("conversation_id", ASCENDING), ("timestamp", DESCENDING)],
                name="idx_conversation_timestamp",
            ),
            # Composite index on group ID and timestamp (legacy)
            IndexModel(
                [("group_id", ASCENDING), ("timestamp", DESCENDING)],
                name="idx_group_timestamp",
                sparse=True,
            ),
            # Index on keywords
            IndexModel([("keywords", ASCENDING)], name="idx_keywords", sparse=True),
            # Index on linked entities
            IndexModel(
                [("linked_entities", ASCENDING)],
                name="idx_linked_entities",
                sparse=True,
            ),
            # Index on audit fields
            IndexModel([("created_at", DESCENDING)], name="idx_created_at"),
            IndexModel([("updated_at", DESCENDING)], name="idx_updated_at"),
        ]
        validate_on_save = True
        use_state_management = True
