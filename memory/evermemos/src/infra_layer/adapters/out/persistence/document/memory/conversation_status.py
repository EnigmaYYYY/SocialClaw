from datetime import datetime
from typing import Optional
from core.oxm.mongo.document_base import DocumentBase
from pydantic import Field, ConfigDict
from pymongo import IndexModel, ASCENDING, DESCENDING
from core.oxm.mongo.audit_base import AuditBase


class ConversationStatus(DocumentBase, AuditBase):
    """
    Conversation status document model

    Stores conversation status information, including group ID, message read time, etc.
    """

    # Basic information
    conversation_id: str = Field(
        ..., description="Unified conversation ID, empty means private chat"
    )
    group_id: Optional[str] = Field(
        default=None, description="Legacy conversation key (backward compatibility)"
    )
    old_msg_start_time: Optional[datetime] = Field(
        default=None, description="Conversation window read start time"
    )
    new_msg_start_time: Optional[datetime] = Field(
        default=None, description="Accumulated new conversation read start time"
    )
    last_memcell_time: Optional[datetime] = Field(
        default=None, description="Accumulated memCell read start time"
    )
    pending_boundary: Optional[bool] = Field(
        default=False, description="Whether a boundary is pending confirmation"
    )
    pending_boundary_count: Optional[int] = Field(
        default=None,
        description="Message count in history when boundary was first detected",
    )
    pending_boundary_time: Optional[datetime] = Field(
        default=None, description="Boundary detection time pending confirmation"
    )
    pending_boundary_hash: Optional[str] = Field(
        default=None, description="Hash of pending boundary message slice"
    )
    last_confirmed_boundary_hash: Optional[str] = Field(
        default=None, description="Hash of last confirmed boundary slice"
    )

    model_config = ConfigDict(
        collection="conversation_status",
        validate_assignment=True,
        json_encoders={datetime: lambda dt: dt.isoformat()},
        json_schema_extra={
            "example": {
                "group_id": "group_001",
                "conversation_id": "group_001",
                "old_msg_start_time": datetime(2021, 1, 1, 0, 0, 0),
                "new_msg_start_time": datetime(2021, 1, 1, 0, 0, 0),
                "last_memcell_time": datetime(2021, 1, 1, 0, 0, 0),
                "pending_boundary": False,
                "pending_boundary_count": None,
                "pending_boundary_time": None,
                "pending_boundary_hash": None,
                "last_confirmed_boundary_hash": None,
            }
        },
    )

    class Settings:
        """Beanie settings"""

        name = "conversation_status"
        indexes = [
            # Note: conversation_id maps to the _id field, MongoDB automatically creates a primary key index on _id
            IndexModel(
                [("conversation_id", ASCENDING)], name="idx_conversation_id", unique=True
            ),
            IndexModel(
                [("group_id", ASCENDING)], name="idx_group_id_legacy", unique=False, sparse=True
            ),
            IndexModel([("created_at", DESCENDING)], name="idx_created_at"),
            IndexModel([("updated_at", DESCENDING)], name="idx_updated_at"),
        ]
        validate_on_save = True
        use_state_management = True
