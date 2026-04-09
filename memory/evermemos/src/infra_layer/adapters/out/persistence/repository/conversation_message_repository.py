"""
Conversation Message Repository

Permanent MongoDB archive for canonical conversation messages.
"""

from datetime import datetime
from typing import List, Optional, Set

from core.di.decorators import repository
from core.observation.logger import get_logger
from core.oxm.mongo.base_repository import BaseRepository

from api_specs.unified_types import SenderType, UnifiedMessage
from common_utils.datetime_utils import from_iso_format, get_now_with_timezone
from infra_layer.adapters.out.persistence.document.conversation_message import (
    ConversationMessageDocument,
)

logger = get_logger(__name__)


@repository("conversation_message_repository", primary=True)
class ConversationMessageRepository(BaseRepository[ConversationMessageDocument]):
    """MongoDB repository for canonical conversation messages."""

    def __init__(self):
        super().__init__(ConversationMessageDocument)

    async def save_messages(
        self,
        owner_user_id: str,
        messages: List[UnifiedMessage],
    ) -> int:
        """Insert unseen messages into the permanent archive."""
        if not messages:
            return 0

        try:
            message_ids = [message.message_id for message in messages if message.message_id]
            existing_ids: Set[str] = set()
            if message_ids:
                existing_docs = await self.model.find({"message_id": {"$in": message_ids}}).to_list()
                existing_ids = {doc.message_id for doc in existing_docs}

            docs_to_insert: List[ConversationMessageDocument] = []
            for message in messages:
                if not message.message_id or message.message_id in existing_ids:
                    continue
                docs_to_insert.append(self._message_to_document(owner_user_id, message))

            if not docs_to_insert:
                return 0

            await self.model.insert_many(docs_to_insert)
            logger.info(
                "Saved %d conversation messages into Mongo archive for owner=%s",
                len(docs_to_insert),
                owner_user_id,
            )
            return len(docs_to_insert)
        except Exception as e:
            logger.error("Failed to save conversation messages: %s", e)
            return 0

    async def get_recent_messages(
        self,
        conversation_id: str,
        limit: int = 20,
    ) -> List[UnifiedMessage]:
        """Read recent messages from the permanent archive."""
        try:
            docs = await self.model.find(
                {"conversation_id": conversation_id}
            ).sort("-message_timestamp").limit(limit).to_list()
            docs.reverse()
            return [self._document_to_message(doc) for doc in docs]
        except Exception as e:
            logger.error(
                "Failed to get conversation messages from Mongo archive: conversation_id=%s, error=%s",
                conversation_id,
                e,
            )
            return []

    async def delete_by_conversation_id(self, conversation_id: str) -> int:
        """Delete archived canonical conversation messages by conversation_id."""
        try:
            result = await self.model.find({"conversation_id": conversation_id}).delete()
            count = result.deleted_count if result else 0
            logger.info(
                "Deleted %d conversation messages from Mongo archive: conversation_id=%s",
                count,
                conversation_id,
            )
            return count
        except Exception as e:
            logger.error(
                "Failed to delete conversation messages from Mongo archive: conversation_id=%s, error=%s",
                conversation_id,
                e,
            )
            return 0

    async def delete_by_message_ids(self, message_ids: List[str]) -> int:
        """Delete specific messages from the archive by their message_ids."""
        if not message_ids:
            return 0
        try:
            result = await self.model.find({"message_id": {"$in": message_ids}}).delete()
            count = result.deleted_count if result else 0
            logger.info("Deleted %d conversation messages by message_ids", count)
            return count
        except Exception as e:
            logger.error("Failed to delete conversation messages by message_ids: %s", e)
            return 0

    def _message_to_document(
        self,
        owner_user_id: str,
        message: UnifiedMessage,
    ) -> ConversationMessageDocument:
        timestamp = self._normalize_timestamp(message.timestamp)
        return ConversationMessageDocument(
            message_id=message.message_id,
            conversation_id=message.conversation_id,
            owner_user_id=owner_user_id,
            sender_id=message.sender_id,
            sender_name=message.sender_name,
            sender_type=getattr(message.sender_type, "value", message.sender_type),
            content=message.content,
            timestamp=message.timestamp or timestamp.isoformat(),
            content_type=message.content_type,
            reply_to=message.reply_to,
            metadata=dict(message.metadata or {}),
            message_timestamp=timestamp,
        )

    def _document_to_message(self, doc: ConversationMessageDocument) -> UnifiedMessage:
        return UnifiedMessage(
            message_id=doc.message_id,
            conversation_id=doc.conversation_id,
            sender_id=doc.sender_id,
            sender_name=doc.sender_name,
            sender_type=SenderType(doc.sender_type),
            content=doc.content,
            timestamp=doc.timestamp,
            content_type=doc.content_type,
            reply_to=doc.reply_to,
            metadata=doc.metadata or {},
        )

    def _normalize_timestamp(self, timestamp: Optional[str]) -> datetime:
        if timestamp:
            try:
                return from_iso_format(timestamp)
            except Exception:
                return get_now_with_timezone()
        return get_now_with_timezone()
