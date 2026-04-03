"""
ClusterState native CRUD repository.

Canonical key is `conversation_id`; legacy `group_id` APIs are preserved as wrappers.
"""

from typing import Optional, Dict, Any

from core.di.decorators import repository
from core.observation.logger import get_logger
from core.oxm.mongo.base_repository import BaseRepository
from infra_layer.adapters.out.persistence.document.memory.cluster_state import (
    ClusterState,
)

logger = get_logger(__name__)


@repository("cluster_state_raw_repository", primary=True)
class ClusterStateRawRepository(BaseRepository[ClusterState]):
    def __init__(self):
        super().__init__(ClusterState)

    def _conversation_filter(self, conversation_id: str) -> Dict[str, Any]:
        return {
            "$or": [
                {"conversation_id": conversation_id},
                {"group_id": conversation_id},
            ]
        }

    async def save_cluster_state(
        self, conversation_id: str, state: Dict[str, Any]
    ) -> bool:
        result = await self.upsert_by_conversation_id(conversation_id, state)
        return result is not None

    async def load_cluster_state(
        self, conversation_id: str
    ) -> Optional[Dict[str, Any]]:
        cluster_state = await self.get_by_conversation_id(conversation_id)
        if cluster_state is None:
            return None
        return cluster_state.model_dump(exclude={"id", "revision_id"})

    async def clear(self, conversation_id: Optional[str] = None) -> bool:
        if conversation_id is None:
            await self.delete_all()
        else:
            await self.delete_by_conversation_id(conversation_id)
        return True

    async def get_by_conversation_id(self, conversation_id: str) -> Optional[ClusterState]:
        try:
            return await self.model.find_one(self._conversation_filter(conversation_id))
        except Exception as e:
            logger.error(
                "Failed to retrieve cluster state: conversation_id=%s, error=%s",
                conversation_id,
                e,
            )
            return None

    async def get_by_group_id(self, group_id: str) -> Optional[ClusterState]:
        """Backward-compatible wrapper."""
        return await self.get_by_conversation_id(group_id)

    async def upsert_by_conversation_id(
        self, conversation_id: str, state: Dict[str, Any]
    ) -> Optional[ClusterState]:
        try:
            existing = await self.model.find_one(self._conversation_filter(conversation_id))

            if existing:
                for key, value in state.items():
                    if hasattr(existing, key):
                        setattr(existing, key, value)
                existing.conversation_id = conversation_id
                if hasattr(existing, "group_id"):
                    existing.group_id = conversation_id
                await existing.save()
                logger.debug("Updated cluster state: conversation_id=%s", conversation_id)
                return existing

            payload = dict(state)
            payload["conversation_id"] = conversation_id
            payload["group_id"] = conversation_id
            cluster_state = ClusterState(**payload)
            await cluster_state.insert()
            logger.info("Created cluster state: conversation_id=%s", conversation_id)
            return cluster_state
        except Exception as e:
            logger.error(
                "Failed to save cluster state: conversation_id=%s, error=%s",
                conversation_id,
                e,
            )
            return None

    async def upsert_by_group_id(
        self, group_id: str, state: Dict[str, Any]
    ) -> Optional[ClusterState]:
        """Backward-compatible wrapper."""
        return await self.upsert_by_conversation_id(group_id, state)

    async def get_cluster_assignments(self, conversation_id: str) -> Dict[str, str]:
        try:
            cluster_state = await self.model.find_one(
                self._conversation_filter(conversation_id)
            )
            if cluster_state is None:
                return {}
            return cluster_state.eventid_to_cluster or {}
        except Exception as e:
            logger.error(
                "Failed to retrieve cluster assignments: conversation_id=%s, error=%s",
                conversation_id,
                e,
            )
            return {}

    async def delete_by_conversation_id(self, conversation_id: str) -> bool:
        try:
            cluster_state = await self.model.find_one(
                self._conversation_filter(conversation_id)
            )
            if cluster_state:
                await cluster_state.delete()
                logger.info("Deleted cluster state: conversation_id=%s", conversation_id)
            return True
        except Exception as e:
            logger.error(
                "Failed to delete cluster state: conversation_id=%s, error=%s",
                conversation_id,
                e,
            )
            return False

    async def delete_by_group_id(self, group_id: str) -> bool:
        """Backward-compatible wrapper."""
        return await self.delete_by_conversation_id(group_id)

    async def delete_all(self) -> int:
        try:
            result = await self.model.delete_all()
            count = result.deleted_count if result else 0
            logger.info("Deleted all cluster states: %s items", count)
            return count
        except Exception as e:
            logger.error("Failed to delete all cluster states: %s", e)
            return 0
