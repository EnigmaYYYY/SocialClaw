from typing import Optional, Dict, Any

from pymongo.asynchronous.client_session import AsyncClientSession

from core.di.decorators import repository
from core.observation.logger import get_logger
from core.oxm.mongo.base_repository import BaseRepository
from infra_layer.adapters.out.persistence.document.memory.conversation_status import (
    ConversationStatus,
)

logger = get_logger(__name__)


@repository("conversation_status_raw_repository", primary=True)
class ConversationStatusRawRepository(BaseRepository[ConversationStatus]):
    """
    Conversation status raw data repository.

    Canonical key is `conversation_id`; legacy `group_id` APIs are preserved as wrappers.
    """

    def __init__(self):
        super().__init__(ConversationStatus)

    def _conversation_filter(self, conversation_id: str) -> Dict[str, Any]:
        return {
            "$or": [
                {"conversation_id": conversation_id},
                {"group_id": conversation_id},
            ]
        }

    async def get_by_conversation_id(
        self, conversation_id: str, session: Optional[AsyncClientSession] = None
    ) -> Optional[ConversationStatus]:
        try:
            result = await self.model.find_one(
                self._conversation_filter(conversation_id), session=session
            )
            if result:
                logger.debug(
                    "Successfully retrieved conversation status by conversation_id: %s",
                    conversation_id,
                )
            else:
                logger.debug(
                    "Conversation status not found: conversation_id=%s", conversation_id
                )
            return result
        except Exception as e:
            logger.error(
                "Failed to retrieve conversation status by conversation_id: %s", e
            )
            return None

    async def get_by_group_id(
        self, group_id: str, session: Optional[AsyncClientSession] = None
    ) -> Optional[ConversationStatus]:
        """Backward-compatible wrapper."""
        return await self.get_by_conversation_id(group_id, session=session)

    async def delete_by_conversation_id(
        self, conversation_id: str, session: Optional[AsyncClientSession] = None
    ) -> bool:
        try:
            result = await self.model.find_one(
                self._conversation_filter(conversation_id), session=session
            )
            if not result:
                logger.warning(
                    "Conversation status to delete not found: conversation_id=%s",
                    conversation_id,
                )
                return False

            await result.delete(session=session)
            logger.info(
                "Successfully deleted conversation status by conversation_id: %s",
                conversation_id,
            )
            return True
        except Exception as e:
            logger.error(
                "Failed to delete conversation status by conversation_id: %s", e
            )
            return False

    async def delete_by_group_id(
        self, group_id: str, session: Optional[AsyncClientSession] = None
    ) -> bool:
        """Backward-compatible wrapper."""
        return await self.delete_by_conversation_id(group_id, session=session)

    async def upsert_by_conversation_id(
        self,
        conversation_id: str,
        update_data: Dict[str, Any],
        session: Optional[AsyncClientSession] = None,
    ) -> Optional[ConversationStatus]:
        try:
            existing_doc = await self.model.find_one(
                self._conversation_filter(conversation_id), session=session
            )

            if existing_doc:
                for key, value in update_data.items():
                    setattr(existing_doc, key, value)
                existing_doc.conversation_id = conversation_id
                if hasattr(existing_doc, "group_id"):
                    existing_doc.group_id = conversation_id
                await existing_doc.save(session=session)
                logger.debug(
                    "Successfully updated existing conversation status: conversation_id=%s",
                    conversation_id,
                )
                print(
                    f"[ConversationStatusRawRepository] Successfully updated existing conversation status: {existing_doc}"
                )
                return existing_doc

            try:
                new_doc = ConversationStatus(
                    conversation_id=conversation_id,
                    group_id=conversation_id,
                    **update_data,
                )
                await new_doc.create(session=session)
                logger.info(
                    "Successfully created new conversation status: conversation_id=%s",
                    conversation_id,
                )
                print(
                    f"[ConversationStatusRawRepository] Successfully created new conversation status: {new_doc}"
                )
                return new_doc

            except Exception as create_error:
                error_str = str(create_error)
                if "E11000" in error_str and "duplicate key" in error_str:
                    logger.warning(
                        "Concurrent creation conflict, re-lookup and update: conversation_id=%s",
                        conversation_id,
                    )

                    retry_doc = await self.model.find_one(
                        self._conversation_filter(conversation_id), session=session
                    )

                    if retry_doc:
                        for key, value in update_data.items():
                            setattr(retry_doc, key, value)
                        retry_doc.conversation_id = conversation_id
                        if hasattr(retry_doc, "group_id"):
                            retry_doc.group_id = conversation_id
                        await retry_doc.save(session=session)
                        logger.debug(
                            "Successfully updated after concurrency conflict: conversation_id=%s",
                            conversation_id,
                        )
                        print(
                            f"[ConversationStatusRawRepository] Successfully updated after concurrency conflict: {retry_doc}"
                        )
                        return retry_doc

                    logger.error(
                        "Still unable to find record after concurrency conflict: conversation_id=%s",
                        conversation_id,
                    )
                    return None

                raise create_error

        except Exception as e:
            logger.error("Failed to update or create conversation status: %s", e)
            return None

    async def upsert_by_group_id(
        self,
        group_id: str,
        update_data: Dict[str, Any],
        session: Optional[AsyncClientSession] = None,
    ) -> Optional[ConversationStatus]:
        """Backward-compatible wrapper."""
        return await self.upsert_by_conversation_id(
            group_id, update_data, session=session
        )

    async def count_by_conversation_id(
        self, conversation_id: str, session: Optional[AsyncClientSession] = None
    ) -> int:
        try:
            count = await self.model.find(
                self._conversation_filter(conversation_id), session=session
            ).count()
            logger.debug(
                "Successfully counted conversation statuses: conversation_id=%s, count=%d",
                conversation_id,
                count,
            )
            return count
        except Exception as e:
            logger.error("Failed to count conversation statuses: %s", e)
            return 0

    async def count_by_group_id(
        self, group_id: str, session: Optional[AsyncClientSession] = None
    ) -> int:
        """Backward-compatible wrapper."""
        return await self.count_by_conversation_id(group_id, session=session)
