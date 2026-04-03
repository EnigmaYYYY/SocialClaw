"""
Conversation Message Document Model

Permanent conversation message archive stored in MongoDB.
"""

from datetime import datetime
from typing import Any, Dict, Optional

from beanie import Indexed
from pydantic import Field, ConfigDict
from pymongo import IndexModel, ASCENDING, DESCENDING

from core.oxm.mongo.audit_base import AuditBase
from core.oxm.mongo.document_base import DocumentBase


class ConversationMessageDocument(DocumentBase, AuditBase):
    """Canonical conversation message document."""

    message_id: Indexed(str) = Field(..., description="Message ID")
    conversation_id: Indexed(str) = Field(..., description="Conversation ID")
    owner_user_id: Indexed(str) = Field(..., description="Owner user ID")
    sender_id: Indexed(str) = Field(..., description="Sender ID")
    sender_name: str = Field(default="", description="Sender display name")
    sender_type: str = Field(default="unknown", description="Sender type")
    content: str = Field(default="", description="Message content")
    timestamp: str = Field(default="", description="Original ISO 8601 timestamp")
    content_type: str = Field(default="text", description="Content type")
    reply_to: Optional[str] = Field(default=None, description="Reply target message ID")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Extended metadata")
    message_timestamp: datetime = Field(..., description="Normalized datetime for sorting")

    model_config = ConfigDict(
        collection="conversation_messages",
        validate_assignment=True,
        json_encoders={datetime: lambda dt: dt.isoformat()},
    )

    class Settings:
        name = "conversation_messages"
        indexes = [
            IndexModel([("message_id", ASCENDING)], name="idx_message_id", unique=True),
            IndexModel(
                [("conversation_id", ASCENDING), ("message_timestamp", DESCENDING)],
                name="idx_conversation_timestamp",
            ),
            IndexModel(
                [("owner_user_id", ASCENDING), ("conversation_id", ASCENDING), ("message_timestamp", DESCENDING)],
                name="idx_owner_conversation_timestamp",
            ),
        ]
        validate_on_save = True
        use_state_management = True
