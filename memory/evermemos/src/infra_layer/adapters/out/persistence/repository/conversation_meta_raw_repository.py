"""
ConversationMeta Raw Repository

Provides database operation interfaces for conversation metadata.
Canonical key is `conversation_id`; legacy `group_id` APIs are preserved as wrappers.
"""

import logging
from typing import Optional, List, Dict, Any

from pymongo.asynchronous.client_session import AsyncClientSession

from core.di.decorators import repository
from core.oxm.mongo.base_repository import BaseRepository
from infra_layer.adapters.out.persistence.document.memory.conversation_meta import (
    ConversationMeta,
)

logger = logging.getLogger(__name__)

# Allowed scene enum values
ALLOWED_SCENES = ["private", "group"]
# Legacy scene values mapping (backward compatibility)
LEGACY_SCENE_MAP = {
    "assistant": "private",
    "companion": "group",
    "group_chat": "group",
    "private_chat": "private",
}


@repository("conversation_meta_raw_repository", primary=True)
class ConversationMetaRawRepository(BaseRepository[ConversationMeta]):
    """Raw repository layer for conversation metadata."""

    def __init__(self):
        super().__init__(ConversationMeta)

    def _validate_scene(self, scene: str) -> bool:
        normalized = self._normalize_scene(scene)
        if normalized not in ALLOWED_SCENES:
            logger.warning(
                "Invalid scene value: %s, allowed values: %s", scene, ALLOWED_SCENES
            )
            return False
        return True

    def _normalize_scene(self, scene: str) -> str:
        if not scene:
            return scene
        scene_key = scene.strip().lower()
        return LEGACY_SCENE_MAP.get(scene_key, scene_key)

    def _conversation_filter(self, conversation_id: str) -> Dict[str, Any]:
        return {
            "$or": [
                {"conversation_id": conversation_id},
                {"group_id": conversation_id},
            ]
        }

    async def get_by_conversation_id(
        self, conversation_id: str, session: Optional[AsyncClientSession] = None
    ) -> Optional[ConversationMeta]:
        try:
            conversation_meta = await self.model.find_one(
                self._conversation_filter(conversation_id), session=session
            )
            if conversation_meta:
                logger.debug(
                    "Successfully retrieved conversation metadata by conversation_id: %s",
                    conversation_id,
                )
            return conversation_meta
        except Exception as e:
            logger.error(
                "Failed to retrieve conversation metadata by conversation_id: %s", e
            )
            return None

    async def get_by_group_id(
        self, group_id: str, session: Optional[AsyncClientSession] = None
    ) -> Optional[ConversationMeta]:
        """Backward-compatible wrapper."""
        return await self.get_by_conversation_id(group_id, session=session)

    async def list_by_scene(
        self,
        scene: str,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
        session: Optional[AsyncClientSession] = None,
    ) -> List[ConversationMeta]:
        try:
            normalized_scene = self._normalize_scene(scene)
            if not self._validate_scene(normalized_scene):
                logger.warning(
                    "Invalid scene value when querying conversation metadata list: %s, allowed values: %s",
                    scene,
                    ALLOWED_SCENES,
                )
                return []

            query = self.model.find({"scene": normalized_scene}, session=session)
            if skip:
                query = query.skip(skip)
            if limit:
                query = query.limit(limit)

            result = await query.to_list()
            logger.debug(
                "Successfully retrieved conversation metadata list by scene: scene=%s, count=%d",
                scene,
                len(result),
            )
            return result
        except Exception as e:
            logger.error("Failed to retrieve conversation metadata list by scene: %s", e)
            return []

    async def create_conversation_meta(
        self,
        conversation_meta: ConversationMeta,
        session: Optional[AsyncClientSession] = None,
    ) -> Optional[ConversationMeta]:
        try:
            normalized_scene = self._normalize_scene(conversation_meta.scene)
            if not self._validate_scene(normalized_scene):
                logger.error(
                    "Failed to create conversation metadata: invalid scene value: %s, allowed values: %s",
                    conversation_meta.scene,
                    ALLOWED_SCENES,
                )
                return None

            conversation_meta.scene = normalized_scene
            if not conversation_meta.conversation_id:
                conversation_meta.conversation_id = conversation_meta.group_id
            if not conversation_meta.group_id:
                conversation_meta.group_id = conversation_meta.conversation_id

            await conversation_meta.insert(session=session)
            logger.info(
                "Successfully created conversation metadata: conversation_id=%s, scene=%s",
                conversation_meta.conversation_id,
                conversation_meta.scene,
            )
            return conversation_meta
        except Exception as e:
            logger.error("Failed to create conversation metadata: %s", e, exc_info=True)
            return None

    async def update_by_conversation_id(
        self,
        conversation_id: str,
        update_data: Dict[str, Any],
        session: Optional[AsyncClientSession] = None,
    ) -> Optional[ConversationMeta]:
        try:
            if "scene" in update_data:
                normalized_scene = self._normalize_scene(update_data["scene"])
                if not self._validate_scene(normalized_scene):
                    logger.error(
                        "Failed to update conversation metadata: invalid scene value: %s, allowed values: %s",
                        update_data["scene"],
                        ALLOWED_SCENES,
                    )
                    return None
                update_data = dict(update_data)
                update_data["scene"] = normalized_scene

            conversation_meta = await self.get_by_conversation_id(
                conversation_id, session=session
            )
            if not conversation_meta:
                return None

            payload = dict(update_data)
            payload["conversation_id"] = conversation_id
            payload.setdefault("group_id", conversation_id)
            for key, value in payload.items():
                if hasattr(conversation_meta, key):
                    setattr(conversation_meta, key, value)

            await conversation_meta.save(session=session)
            logger.debug(
                "Successfully updated conversation metadata by conversation_id: %s",
                conversation_id,
            )
            return conversation_meta
        except Exception as e:
            logger.error(
                "Failed to update conversation metadata by conversation_id: %s",
                e,
                exc_info=True,
            )
            return None

    async def update_by_group_id(
        self,
        group_id: str,
        update_data: Dict[str, Any],
        session: Optional[AsyncClientSession] = None,
    ) -> Optional[ConversationMeta]:
        """Backward-compatible wrapper."""
        return await self.update_by_conversation_id(
            group_id, update_data, session=session
        )

    async def upsert_by_conversation_id(
        self,
        conversation_id: str,
        conversation_data: Dict[str, Any],
        session: Optional[AsyncClientSession] = None,
    ) -> Optional[ConversationMeta]:
        try:
            payload = dict(conversation_data)
            if "scene" in payload:
                normalized_scene = self._normalize_scene(payload["scene"])
                if not self._validate_scene(normalized_scene):
                    logger.error(
                        "Failed to upsert conversation metadata: invalid scene value: %s, allowed values: %s",
                        payload["scene"],
                        ALLOWED_SCENES,
                    )
                    return None
                payload["scene"] = normalized_scene

            existing_doc = await self.model.find_one(
                self._conversation_filter(conversation_id), session=session
            )

            payload["conversation_id"] = conversation_id
            payload.setdefault("group_id", conversation_id)

            if existing_doc:
                for key, value in payload.items():
                    if hasattr(existing_doc, key):
                        setattr(existing_doc, key, value)
                await existing_doc.save(session=session)
                logger.debug(
                    "Successfully updated existing conversation metadata: conversation_id=%s",
                    conversation_id,
                )
                return existing_doc

            new_doc = ConversationMeta(**payload)
            await new_doc.insert(session=session)
            logger.info(
                "Successfully created new conversation metadata: conversation_id=%s",
                conversation_id,
            )
            return new_doc
        except Exception as e:
            logger.error("Failed to upsert conversation metadata: %s", e, exc_info=True)
            return None

    async def upsert_by_group_id(
        self,
        group_id: str,
        conversation_data: Dict[str, Any],
        session: Optional[AsyncClientSession] = None,
    ) -> Optional[ConversationMeta]:
        """Backward-compatible wrapper."""
        return await self.upsert_by_conversation_id(
            group_id, conversation_data, session=session
        )

    async def delete_by_conversation_id(
        self, conversation_id: str, session: Optional[AsyncClientSession] = None
    ) -> bool:
        try:
            doc = await self.model.find_one(
                self._conversation_filter(conversation_id), session=session
            )
            if not doc:
                return False
            await doc.delete(session=session)
            logger.info(
                "Successfully deleted conversation metadata: conversation_id=%s",
                conversation_id,
            )
            return True
        except Exception as e:
            logger.error("Failed to delete conversation metadata: %s", e)
            return False

    async def delete_by_group_id(
        self, group_id: str, session: Optional[AsyncClientSession] = None
    ) -> bool:
        """Backward-compatible wrapper."""
        return await self.delete_by_conversation_id(group_id, session=session)
