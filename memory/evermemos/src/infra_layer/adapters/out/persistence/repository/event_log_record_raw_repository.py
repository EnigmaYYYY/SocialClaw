"""
EventLogRecord Repository

Provides CRUD operations and query capabilities for generic event logs.
"""

from datetime import datetime
from typing import List, Optional, Type, TypeVar, Union
from pymongo.asynchronous.client_session import AsyncClientSession
from bson import ObjectId
from core.observation.logger import get_logger
from core.di.decorators import repository
from core.oxm.mongo.base_repository import BaseRepository
from infra_layer.adapters.out.persistence.document.memory.event_log_record import (
    EventLogRecord,
    EventLogRecordProjection,
)

# Define generic type variable
T = TypeVar('T', EventLogRecord, EventLogRecordProjection)

logger = get_logger(__name__)


@repository("event_log_record_repository", primary=True)
class EventLogRecordRawRepository(BaseRepository[EventLogRecord]):
    """
    Personal event log raw data repository

    Provides CRUD operations and basic query functions for personal event logs.
    Note: Vectors should be generated during extraction; this Repository is not responsible for vector generation.
    """

    def __init__(self):
        super().__init__(EventLogRecord)

    # ==================== Basic CRUD Methods ====================

    async def save(
        self, event_log: EventLogRecord, session: Optional[AsyncClientSession] = None
    ) -> Optional[EventLogRecord]:
        """
        Save personal event log

        Args:
            event_log: Personal event log object
            session: Optional MongoDB session, for transaction support

        Returns:
            Saved EventLogRecord or None
        """
        try:
            await event_log.insert(session=session)
            logger.info(
                "✅ Saved personal event log successfully: id=%s, user_id=%s, parent_episode=%s",
                event_log.id,
                event_log.user_id,
                event_log.parent_episode_id,
            )
            return event_log
        except Exception as e:
            logger.error("❌ Failed to save personal event log: %s", e)
            return None

    async def get_by_id(
        self,
        log_id: str,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> Optional[Union[EventLogRecord, EventLogRecordProjection]]:
        """
        Get personal event log by ID

        Args:
            log_id: Log ID
            session: Optional MongoDB session, for transaction support
            model: Returned model type, default is EventLogRecord (full version), can pass EventLogRecordShort

        Returns:
            Event log object of specified type or None
        """
        try:
            object_id = ObjectId(log_id)

            # If model is not specified, use full version
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
                    "✅ Retrieved personal event log by ID successfully: %s (model=%s)",
                    log_id,
                    target_model.__name__,
                )
            else:
                logger.debug("ℹ️  Personal event log not found: id=%s", log_id)
            return result
        except Exception as e:
            logger.error("❌ Failed to retrieve personal event log by ID: %s", e)
            return None

    async def get_by_parent_episode_id(
        self,
        parent_episode_id: str,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> List[Union[EventLogRecord, EventLogRecordProjection]]:
        """
        Get all event logs by parent episodic memory ID

        Args:
            parent_episode_id: Parent episodic memory ID
            session: Optional MongoDB session, for transaction support
            model: Returned model type, default is EventLogRecord (full version), can pass EventLogRecordShort

        Returns:
            List of event log objects of specified type
        """
        try:
            # If model is not specified, use full version
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
                "✅ Retrieved event logs by parent episodic memory ID successfully: %s, found %d records (model=%s)",
                parent_episode_id,
                len(results),
                target_model.__name__,
            )
            return results
        except Exception as e:
            logger.error(
                "❌ Failed to retrieve event logs by parent episodic memory ID: %s", e
            )
            return []

    async def get_by_user_id(
        self,
        user_id: str,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
        sort_desc: bool = True,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> List[Union[EventLogRecord, EventLogRecordProjection]]:
        """
        Get list of event logs by user ID

        Args:
            user_id: User ID
            limit: Limit number of returned records
            skip: Number of records to skip
            sort_desc: Whether to sort by time in descending order
            session: Optional MongoDB session, for transaction support
            model: Returned model type, default is EventLogRecord (full version), can pass EventLogRecordShort

        Returns:
            List of event log objects of specified type
        """
        try:
            # If model is not specified, use full version
            target_model = model if model is not None else self.model

            # Determine whether to use projection based on model type
            if target_model == self.model:
                query = self.model.find({"user_id": user_id}, session=session)
            else:
                query = self.model.find(
                    {"user_id": user_id}, projection_model=target_model, session=session
                )

            if sort_desc:
                query = query.sort("-timestamp")
            else:
                query = query.sort("timestamp")

            if skip:
                query = query.skip(skip)
            if limit:
                query = query.limit(limit)

            results = await query.to_list()
            logger.debug(
                "✅ Retrieved event logs by user ID successfully: %s, found %d records (model=%s)",
                user_id,
                len(results),
                target_model.__name__,
            )
            return results
        except Exception as e:
            logger.error("❌ Failed to retrieve event logs by user ID: %s", e)
            return []

    async def find_by_time_range(
        self,
        start_time: datetime,
        end_time: datetime,
        user_id: Optional[str] = None,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
        sort_desc: bool = False,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> List[Union[EventLogRecord, EventLogRecordProjection]]:
        """
        Query event logs by time range

        Args:
            start_time: Start time
            end_time: End time
            user_id: Optional user ID filter
            limit: Limit number of returned records
            skip: Number of records to skip
            sort_desc: Whether to sort by time in descending order, default False (ascending)
            session: Optional MongoDB session, for transaction support
            model: Returned model type, default is EventLogRecord (full version), can pass EventLogRecordShort

        Returns:
            List of event log objects of specified type
        """
        try:
            # If model is not specified, use full version
            target_model = model if model is not None else self.model

            filter_dict = {"timestamp": {"$gte": start_time, "$lt": end_time}}
            if user_id:
                filter_dict["user_id"] = user_id

            # Determine whether to use projection based on model type
            if target_model == self.model:
                query = self.model.find(filter_dict, session=session)
            else:
                query = self.model.find(
                    filter_dict, projection_model=target_model, session=session
                )

            if sort_desc:
                query = query.sort("-timestamp")
            else:
                query = query.sort("timestamp")

            if skip:
                query = query.skip(skip)
            if limit:
                query = query.limit(limit)

            results = await query.to_list()
            logger.debug(
                "✅ Queried event logs by time range successfully: Time range: %s - %s, found %d records (model=%s)",
                start_time,
                end_time,
                len(results),
                target_model.__name__,
            )
            return results
        except Exception as e:
            logger.error("❌ Failed to query event logs by time range: %s", e)
            return []

    async def get_by_conversation_id(
        self,
        conversation_id: str,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
        sort_desc: bool = True,
        session: Optional[AsyncClientSession] = None,
        model: Optional[Type[T]] = None,
    ) -> List[Union[EventLogRecord, EventLogRecordProjection]]:
        """Retrieve event logs by conversation_id (primary key)."""
        try:
            target_model = model if model is not None else self.model
            filter_dict = {"$or": [{"conversation_id": conversation_id}, {"group_id": conversation_id}]}
            if target_model == self.model:
                query = self.model.find(filter_dict, session=session)
            else:
                query = self.model.find(filter_dict, projection_model=target_model, session=session)
            if sort_desc:
                query = query.sort("-timestamp")
            else:
                query = query.sort("timestamp")
            if skip:
                query = query.skip(skip)
            if limit:
                query = query.limit(limit)
            results = await query.to_list()
            logger.debug(
                "✅ Retrieved event logs by conversation_id: %s, found %d records",
                conversation_id,
                len(results),
            )
            return results
        except Exception as e:
            logger.error("❌ Failed to retrieve event logs by conversation_id: %s", e)
            return []

    async def delete_by_conversation_id(
        self, conversation_id: str, session: Optional[AsyncClientSession] = None
    ) -> int:
        """Delete all event logs by conversation_id."""
        try:
            result = await self.model.find(
                {"$or": [{"conversation_id": conversation_id}, {"group_id": conversation_id}]},
                session=session,
            ).delete()
            count = result.deleted_count if result else 0
            logger.info(
                "✅ Deleted event logs by conversation_id: %s, deleted %d records",
                conversation_id,
                count,
            )
            return count
        except Exception as e:
            logger.error("❌ Failed to delete event logs by conversation_id: %s", e)
            return 0

    async def delete_by_id(
        self, log_id: str, session: Optional[AsyncClientSession] = None
    ) -> bool:
        """
        Delete personal event log by ID

        Args:
            log_id: Log ID
            session: Optional MongoDB session, for transaction support

        Returns:
            Whether deletion was successful
        """
        try:
            object_id = ObjectId(log_id)
            result = await self.model.find({"_id": object_id}, session=session).delete()
            success = result.deleted_count > 0 if result else False

            if success:
                logger.info("✅ Deleted personal event log successfully: %s", log_id)
            else:
                logger.warning("⚠️  Personal event log to delete not found: %s", log_id)

            return success
        except Exception as e:
            logger.error("❌ Failed to delete personal event log: %s", e)
            return False

    async def delete_by_parent_episode_id(
        self, parent_episode_id: str, session: Optional[AsyncClientSession] = None
    ) -> int:
        """
        Delete all event logs by parent episodic memory ID

        Args:
            parent_episode_id: Parent episodic memory ID
            session: Optional MongoDB session, for transaction support

        Returns:
            Number of deleted records
        """
        try:
            result = await self.model.find(
                {"parent_episode_id": parent_episode_id}, session=session
            ).delete()
            count = result.deleted_count if result else 0
            logger.info(
                "✅ Deleted event logs by parent episodic memory ID successfully: %s, deleted %d records",
                parent_episode_id,
                count,
            )
            return count
        except Exception as e:
            logger.error(
                "❌ Failed to delete event logs by parent episodic memory ID: %s", e
            )
            return 0


# Export
__all__ = ["EventLogRecordRawRepository"]
