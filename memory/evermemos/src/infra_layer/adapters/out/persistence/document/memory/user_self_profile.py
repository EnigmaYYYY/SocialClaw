from datetime import datetime
from typing import List, Optional, Dict, Any
from beanie import Indexed
from core.oxm.mongo.document_base import DocumentBase
from pydantic import Field
from core.oxm.mongo.audit_base import AuditBase


class UserSelfProfile(DocumentBase, AuditBase):
    """
    User self-profile document model

    Stores the owner's profile extracted from conversations.
    """

    # Primary key
    user_id: Indexed(str) = Field(..., description="User ID")

    # Profile content (stored in JSON format)
    profile_data: Dict[str, Any] = Field(
        default_factory=dict,
        description="User self-profile data (including preferences, personality, habits, etc.)",
    )

    # Metadata
    scenario: str = Field(
        default="private", description="Scenario type: private or group"
    )
    confidence: float = Field(default=0.0, description="Profile confidence score (0-1)")
    version: int = Field(default=1, description="Profile version number")

    # Clustering association
    cluster_ids: List[str] = Field(
        default_factory=list, description="List of associated cluster IDs"
    )
    memcell_count: int = Field(
        default=0, description="Number of MemCells involved in extraction"
    )

    # History
    last_updated_cluster: Optional[str] = Field(
        default=None, description="Cluster ID used in the last update"
    )

    class Settings:
        name = "user_self_profile"
        indexes = [[("user_id", 1)]]
