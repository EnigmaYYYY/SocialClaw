"""Import persistence document models so Beanie can discover them at startup."""

from infra_layer.adapters.out.persistence.document.conversation_message import ConversationMessageDocument
from infra_layer.adapters.out.persistence.document.unified_profile import UnifiedProfileDocument
from infra_layer.adapters.out.persistence.document.user_friends import UserFriendsDocument

__all__ = ["ConversationMessageDocument", "UnifiedProfileDocument", "UserFriendsDocument"]
