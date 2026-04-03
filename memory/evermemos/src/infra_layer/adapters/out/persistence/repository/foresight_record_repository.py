"""
ForesightRecord Repository

Provides generic CRUD operations and query capabilities for foresight records.
"""

from typing import Any, Dict, List, Optional, Type, TypeVar, Union
from pymongo.asynchronous.client_session import AsyncClientSession
from bson import ObjectId
from core.observation.logger import get_logger
from core.di.decorators import repository
from core.oxm.mongo.base_repository import BaseRepository
from infra_layer.adapters.out.persistence.document.memory.foresight_record import (
    ForesightRecord,
    ForesightRecordProjection,
)

# Define generic type variable
T = TypeVar('T', ForesightRecord, ForesightRecordProjection)

logger = get_logger(__name__)


@repository("foresight_record_repository", primary=True)
class ForesightRecordRawRepository(BaseRepository[ForesightRecord]):
    """
    Raw repository for personal foresight data

    Provides CRUD operations and basic query functions for personal foresight records.
    Note: Vectors should be generated during extraction; this Repository is not responsible for vector generation.
    """

    def __init__(self):
        super().__init__(ForesightRecord)

    # ==================== Basic CRUD Methods ====================

    async def save(
        self, foresight: ForesightRecord, session: Optional[AsyncClientSession] = None
    ) -> Optional[ForesightRecord]:
        """
        Save personal foresight record

        Args:
            foresight: ForesightRecord object
            session: Optional MongoDB session for transaction support

        Returns:
            Saved ForesightRecord or None
        """
        try:
            await foresight.insert(session=session)
            logger.info(
                "✅ Saved personal foresight successfully: id=%s, user_id=%s, parent_episode=%s",
                foresight.id,
                foresight.user_id,
                foresight.parent_episode_id,
            )
            return foresight
        except Exception as e:
            logger.error("❌ Failed to save personal foresight: %s", e)
            return None

    async def get_by_id(
        self,
        memory_id: str,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> Optional[Union[ForesightRecord, ForesightRecordProjection]]:
        """
        Retrieve personal foresight by ID

        Args:
            memory_id: Memory ID
            session: Optional MongoDB session for transaction support
            model: Type of model to return, defaults to ForesightRecord (full version)

        Returns:
            Foresight object of specified type or None
        """
        try:
            object_id = ObjectId(memory_id)

            # Use full version if model is not specified
            target_model = model if model is not None else self.model

            # Determine whether to use projection based on model type
            if target_model == self.model:
                result = await self.model.find_one({"_id": object_id}, session=session)
            else:
                result = await self.model.find_one(
                    {"_id": object_id}, projection_model=target_model, session=session
                )

            if result:
                logger.debug(
                    "✅ Retrieved personal foresight by ID successfully: %s (model=%s)",
                    memory_id,
                    target_model.__name__,
                )
            else:
                logger.debug("ℹ️  Personal foresight not found: id=%s", memory_id)
            return result
        except Exception as e:
            logger.error("❌ Failed to retrieve personal foresight by ID: %s", e)
            return None

    async def get_by_parent_episode_id(
        self,
        parent_episode_id: str,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> List[Union[ForesightRecord, ForesightRecordProjection]]:
        """
        Retrieve all foresights by parent episodic memory ID

        Args:
            parent_episode_id: Parent episodic memory ID
            session: Optional MongoDB session for transaction support
            model: Type of model to return, defaults to ForesightRecord (full version)

        Returns:
            List of foresight objects of specified type
        """
        try:
            # Use full version if model is not specified
            target_model = model if model is not None else self.model

            # Determine whether to use projection based on model type
            if target_model == self.model:
                query = self.model.find(
                    {"parent_episode_id": parent_episode_id}, session=session
                )
            else:
                query = self.model.find(
                    {"parent_episode_id": parent_episode_id},
                    projection_model=target_model,
                    session=session,
                )

            results = await query.to_list()
            logger.debug(
                "✅ Retrieved foresights by parent episodic memory ID successfully: %s, found %d records (model=%s)",
                parent_episode_id,
                len(results),
                target_model.__name__,
            )
            return results
        except Exception as e:
            logger.error(
                "❌ Failed to retrieve foresights by parent episodic memory ID: %s", e
            )
            return []

    async def get_by_user_id(
        self,
        user_id: str,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> List[Union[ForesightRecord, ForesightRecordProjection]]:
        """
        Retrieve list of foresights by user ID

        Args:
            user_id: User ID
            limit: Limit number of returned records
            skip: Number of records to skip
            session: Optional MongoDB session for transaction support
            model: Type of model to return, defaults to ForesightRecord (full version)

        Returns:
            List of foresight objects of specified type
        """
        try:
            # Use full version if model is not specified
            target_model = model if model is not None else self.model

            # Determine whether to use projection based on model type
            if target_model == self.model:
                query = self.model.find({"user_id": user_id}, session=session)
            else:
                query = self.model.find(
                    {"user_id": user_id}, projection_model=target_model, session=session
                )

            if skip:
                query = query.skip(skip)
            if limit:
                query = query.limit(limit)

            results = await query.to_list()
            logger.debug(
                "✅ Retrieved foresights by user ID successfully: %s, found %d records (model=%s)",
                user_id,
                len(results),
                target_model.__name__,
            )
            return results
        except Exception as e:
            logger.error("❌ Failed to retrieve foresights by user ID: %s", e)
            return []

    async def get_by_conversation_id(
        self,
        conversation_id: str,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
        user_id: Optional[str] = None,
    ) -> List[Union[ForesightRecord, ForesightRecordProjection]]:
        """Retrieve foresights by conversation_id (primary key)."""
        try:
            target_model = model if model is not None else self.model
            filter_dict: Dict[str, Any] = {"$or": [{"conversation_id": conversation_id}, {"group_id": conversation_id}]}
            if user_id:
                filter_dict["user_id"] = user_id
            if target_model == self.model:
                query = self.model.find(filter_dict, session=session)
            else:
                query = self.model.find(filter_dict, projection_model=target_model, session=session)
            if skip:
                query = query.skip(skip)
            if limit:
                query = query.limit(limit)
            results = await query.to_list()
            logger.debug(
                "✅ Retrieved foresights by conversation_id: %s, found %d records",
                conversation_id,
                len(results),
            )
            return results
        except Exception as e:
            logger.error("❌ Failed to retrieve foresights by conversation_id: %s", e)
            return []

    async def delete_by_conversation_id(
        self, conversation_id: str, session: Optional[AsyncClientSession] = None
    ) -> int:
        """Delete all foresights by conversation_id."""
        try:
            result = await self.model.find(
                {"$or": [{"conversation_id": conversation_id}, {"group_id": conversation_id}]},
                session=session,
            ).delete()
            count = result.deleted_count if result else 0
            logger.info(
                "✅ Deleted foresights by conversation_id: %s, deleted %d records",
                conversation_id,
                count,
            )
            return count
        except Exception as e:
            logger.error("❌ Failed to delete foresights by conversation_id: %s", e)
            return 0

    async def delete_by_id(
        self, memory_id: str, session: Optional[AsyncClientSession] = None
    ) -> bool:
        """
        Delete personal foresight by ID

        Args:
            memory_id: Memory ID
            session: Optional MongoDB session for transaction support

        Returns:
            Whether deletion was successful
        """
        try:
            object_id = ObjectId(memory_id)
            result = await self.model.find({"_id": object_id}, session=session).delete()
            success = result.deleted_count > 0 if result else False

            if success:
                logger.info("✅ Deleted personal foresight successfully: %s", memory_id)
            else:
                logger.warning(
                    "⚠️  Personal foresight to delete not found: %s", memory_id
                )

            return success
        except Exception as e:
            logger.error("❌ Failed to delete personal foresight: %s", e)
            return False

    async def delete_by_parent_episode_id(
        self, parent_episode_id: str, session: Optional[AsyncClientSession] = None
    ) -> int:
        """
        Delete all foresights by parent episodic memory ID

        Args:
            parent_episode_id: Parent episodic memory ID
            session: Optional MongoDB session for transaction support

        Returns:
            Number of deleted records
        """
        try:
            result = await self.model.find(
                {"parent_episode_id": parent_episode_id}, session=session
            ).delete()
            count = result.deleted_count if result else 0
            logger.info(
                "✅ Deleted foresights by parent episodic memory ID successfully: %s, deleted %d records",
                parent_episode_id,
                count,
            )
            return count
        except Exception as e:
            logger.error(
                "❌ Failed to delete foresights by parent episodic memory ID: %s", e
            )
            return 0


# Export
__all__ = ["ForesightRecordRawRepository"]
