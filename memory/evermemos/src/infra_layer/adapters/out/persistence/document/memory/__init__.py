"""Import memory document models so Beanie can discover them at startup."""

from infra_layer.adapters.out.persistence.document.memory.behavior_history import BehaviorHistory
from infra_layer.adapters.out.persistence.document.memory.cluster_state import ClusterState
from infra_layer.adapters.out.persistence.document.memory.conversation_meta import ConversationMeta
from infra_layer.adapters.out.persistence.document.memory.conversation_status import ConversationStatus
from infra_layer.adapters.out.persistence.document.memory.core_memory import CoreMemory
from infra_layer.adapters.out.persistence.document.memory.entity import Entity
from infra_layer.adapters.out.persistence.document.memory.episodic_memory import EpisodicMemory
from infra_layer.adapters.out.persistence.document.memory.event_log_record import EventLogRecord
from infra_layer.adapters.out.persistence.document.memory.foresight_record import ForesightRecord
from infra_layer.adapters.out.persistence.document.memory.group_profile import GroupProfile
from infra_layer.adapters.out.persistence.document.memory.group_user_profile_memory import GroupUserProfileMemory
from infra_layer.adapters.out.persistence.document.memory.memcell import MemCell
from infra_layer.adapters.out.persistence.document.memory.relationship import Relationship
from infra_layer.adapters.out.persistence.document.memory.reply_template import ReplyTemplate
from infra_layer.adapters.out.persistence.document.memory.user_profile import UserProfile
from infra_layer.adapters.out.persistence.document.memory.user_self_profile import UserSelfProfile

__all__ = [
    "BehaviorHistory",
    "ClusterState",
    "ConversationMeta",
    "ConversationStatus",
    "CoreMemory",
    "Entity",
    "EpisodicMemory",
    "EventLogRecord",
    "ForesightRecord",
    "GroupProfile",
    "GroupUserProfileMemory",
    "MemCell",
    "Relationship",
    "ReplyTemplate",
    "UserProfile",
    "UserSelfProfile",
]
