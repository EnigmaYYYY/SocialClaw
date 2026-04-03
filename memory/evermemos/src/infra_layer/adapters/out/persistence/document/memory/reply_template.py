"""
ReplyTemplate Beanie ODM model.

Stores reusable (incoming -> reply) templates extracted from memcells.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from beanie import Indexed
from core.oxm.mongo.audit_base import AuditBase
from core.oxm.mongo.document_base import DocumentBase
from pydantic import ConfigDict, Field
from pymongo import ASCENDING, DESCENDING, IndexModel


class ReplyTemplate(DocumentBase, AuditBase):
    """Reply template document."""

    owner_user_id: Indexed(str) = Field(..., description="Owner user id")
    peer_user_id: Indexed(str) = Field(..., description="Peer user id")
    group_id: Indexed(str) = Field(..., description="Conversation group id")
    scene: Indexed(str) = Field(..., description="Conversation scene")
    template_key: Indexed(str) = Field(
        ...,
        description="Normalized key for deduplication",
    )

    incoming_text: str = Field(..., description="Incoming peer text")
    reply_text: str = Field(..., description="Owner reply text")
    intent_type: str = Field(default="statement", description="Template intent type")
    emotion_in: str = Field(default="neutral", description="Incoming emotion label")

    from_user_id: Optional[str] = Field(default=None, description="Incoming sender id")
    to_user_id: Optional[str] = Field(default=None, description="Reply sender id")
    from_user_name: Optional[str] = Field(default=None, description="Incoming sender")
    to_user_name: Optional[str] = Field(default=None, description="Reply sender")

    source_message_ids: List[str] = Field(
        default_factory=list,
        description="Source message ids",
    )
    source_event_ids: List[str] = Field(
        default_factory=list,
        description="Source memcell event ids",
    )
    risk_flags: List[str] = Field(default_factory=list, description="Risk flags")
    style_tags: Optional[Dict[str, Any]] = Field(
        default=None, description="Style features"
    )

    count: int = Field(default=1, ge=1, description="Observed count")
    first_seen_at: datetime = Field(..., description="First seen time")
    last_seen_at: datetime = Field(..., description="Last seen time")
    extend: Optional[Dict[str, Any]] = Field(default=None, description="Extensions")

    model_config = ConfigDict(
        collection="reply_templates",
        validate_assignment=True,
        json_encoders={datetime: lambda dt: dt.isoformat()},
    )

    class Settings:
        name = "reply_templates"
        indexes = [
            IndexModel(
                [
                    ("owner_user_id", ASCENDING),
                    ("peer_user_id", ASCENDING),
                    ("scene", ASCENDING),
                    ("template_key", ASCENDING),
                ],
                name="uniq_owner_peer_scene_tpl",
                unique=True,
            ),
            IndexModel(
                [
                    ("group_id", ASCENDING),
                    ("owner_user_id", ASCENDING),
                    ("peer_user_id", ASCENDING),
                    ("last_seen_at", DESCENDING),
                ],
                name="idx_group_owner_peer_last_seen",
            ),
            IndexModel(
                [("intent_type", ASCENDING), ("emotion_in", ASCENDING)],
                name="idx_intent_emotion",
            ),
        ]
        validate_on_save = True
        use_state_management = True

