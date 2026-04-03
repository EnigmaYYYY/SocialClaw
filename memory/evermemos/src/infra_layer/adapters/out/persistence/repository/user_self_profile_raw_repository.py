"""
UserSelfProfile native CRUD repository

User self-profile data access layer based on Beanie ODM.
Provides ProfileStorage compatible interface (duck typing).
"""

from typing import Optional, Dict, Any, List
from core.observation.logger import get_logger
from core.di.decorators import repository
from core.oxm.mongo.base_repository import BaseRepository

from infra_layer.adapters.out.persistence.document.memory.user_self_profile import (
    UserSelfProfile,
)

logger = get_logger(__name__)


@repository("user_self_profile_raw_repository", primary=True)
class UserSelfProfileRawRepository(BaseRepository[UserSelfProfile]):
    """
    UserSelfProfile native CRUD repository

    Provides ProfileStorage compatible interfaces:
    - save_profile(user_id, profile, metadata) -> bool
    - get_profile(user_id) -> Optional[Any]
    - get_all_profiles() -> Dict[str, Any]
    - get_profile_history(user_id, limit) -> List[Dict]
    - clear() -> bool
    """

    def __init__(self):
        super().__init__(UserSelfProfile)

    # ==================== ProfileStorage interface implementation ====================

    async def save_profile(
        self, user_id: str, profile: Any, metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        metadata = metadata or {}

        if hasattr(profile, 'to_dict'):
            profile_data = profile.to_dict()
        elif isinstance(profile, dict):
            profile_data = profile
        else:
            profile_data = {"data": str(profile)}

        result = await self.upsert(user_id, profile_data, metadata)
        return result is not None

    async def get_profile(self, user_id: str) -> Optional[Any]:
        user_profile = await self.get_by_user(user_id)
        if user_profile is None:
            return None
        return user_profile.profile_data

    async def get_all_profiles(self) -> Dict[str, Any]:
        user_profiles = await self.get_all()
        return {up.user_id: up.profile_data for up in user_profiles}

    async def get_profile_history(
        self, user_id: str, limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        user_profile = await self.get_by_user(user_id)
        if user_profile is None:
            return []

        history = [
            {
                "version": user_profile.version,
                "profile": user_profile.profile_data,
                "confidence": user_profile.confidence,
                "updated_at": user_profile.updated_at,
                "cluster_id": user_profile.last_updated_cluster,
                "memcell_count": user_profile.memcell_count,
            }
        ]
        return history[:limit] if limit else history

    async def clear(self) -> bool:
        await self.delete_all()
        return True

    # ==================== Native CRUD methods ====================

    async def get_by_user(self, user_id: str) -> Optional[UserSelfProfile]:
        try:
            return await self.model.find_one(
                UserSelfProfile.user_id == user_id
            )
        except Exception as e:
            logger.error(
                f"Failed to retrieve user self profile: user_id={user_id}, error={e}"
            )
            return None

    async def get_all(self) -> List[UserSelfProfile]:
        try:
            return await self.model.find().to_list()
        except Exception as e:
            logger.error(
                f"Failed to retrieve user self profiles: error={e}"
            )
            return []

    async def upsert(
        self,
        user_id: str,
        profile_data: Dict[str, Any],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[UserSelfProfile]:
        try:
            metadata = metadata or {}
            existing = await self.get_by_user(user_id)

            if existing:
                existing.profile_data = profile_data
                existing.version += 1
                existing.confidence = metadata.get("confidence", existing.confidence)

                if "cluster_id" in metadata:
                    cluster_id = metadata["cluster_id"]
                    if cluster_id not in existing.cluster_ids:
                        existing.cluster_ids.append(cluster_id)
                    existing.last_updated_cluster = cluster_id

                if "memcell_count" in metadata:
                    existing.memcell_count = metadata["memcell_count"]

                await existing.save()
                logger.debug(
                    f"Updated user self profile: user_id={user_id}, version={existing.version}"
                )
                return existing
            else:
                user_profile = UserSelfProfile(
                    user_id=user_id,
                    profile_data=profile_data,
                    scenario=metadata.get("scenario", "companion"),
                    confidence=metadata.get("confidence", 0.0),
                    version=1,
                    cluster_ids=(
                        [metadata["cluster_id"]] if "cluster_id" in metadata else []
                    ),
                    memcell_count=metadata.get("memcell_count", 0),
                    last_updated_cluster=metadata.get("cluster_id"),
                )
                await user_profile.insert()
                logger.info(
                    f"Created user self profile: user_id={user_id}"
                )
                return user_profile
        except Exception as e:
            logger.error(
                f"Failed to save user self profile: user_id={user_id}, error={e}"
            )
            return None

    async def delete_all(self) -> int:
        try:
            result = await self.model.delete_all()
            count = result.deleted_count if result else 0
            logger.info(f"Deleted all user self profiles: {count} items")
            return count
        except Exception as e:
            logger.error(f"Failed to delete all user self profiles: {e}")
            return 0


__all__ = ["UserSelfProfileRawRepository"]
