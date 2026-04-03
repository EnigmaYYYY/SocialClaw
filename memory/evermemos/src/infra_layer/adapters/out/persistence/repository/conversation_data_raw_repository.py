"""
ConversationDataRepository interface and implementation

Redis-based cached conversation data access implementation using Redis length-limited cache manager to store RawData objects
"""

from abc import ABC, abstractmethod
from typing import List, Optional
from core.observation.logger import get_logger
from core.di.decorators import repository
from memory_layer.memcell_extractor.base_memcell_extractor import RawData
from biz_layer.mem_db_operations import _normalize_datetime_for_storage
from common_utils.datetime_utils import get_now_with_timezone
from core.di import get_bean
from core.tenants.tenantize.kv.redis.tenant_key_utils import patch_redis_tenant_key

logger = get_logger(__name__)


# ==================== Interface Definition ====================


class ConversationDataRepository(ABC):
    """Conversation data access interface"""

    @abstractmethod
    async def save_conversation_data(
        self, raw_data_list: List[RawData], group_id: str
    ) -> bool:
        """Save conversation data"""
        pass

    @abstractmethod
    async def get_conversation_data(
        self,
        group_id: str,
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
        limit: int = 100,
    ) -> List[RawData]:
        """Get conversation data"""
        pass

    @abstractmethod
    async def delete_conversation_data(self, group_id: str) -> bool:
        """
        Delete all conversation data for the specified group

        Args:
            group_id: Group ID

        Returns:
            bool: Return True if deletion succeeds, False otherwise
        """
        pass


# ==================== Implementation ====================


@repository("conversation_data_repo", primary=True)
class ConversationDataRepositoryImpl(ConversationDataRepository):
    """
    Real database implementation of ConversationDataRepository

    Conversation data access implementation based on Redis length-limited cache manager, directly storing RawData objects into Redis
    """

    def __init__(self):
        """Initialize Repository"""
        # Get Redis length-limited cache manager factory
        self._cache_factory = get_bean("redis_length_cache_factory")
        self._cache_manager = None

    async def _get_cache_manager(self):
        """Get cache manager instance"""
        if self._cache_manager is None:
            # Create cache manager: max length 1000, expiration 60 minutes, cleanup probability 0.1
            self._cache_manager = await self._cache_factory.create_cache_manager(
                max_length=1000, expire_minutes=60, cleanup_probability=0.1
            )
        return self._cache_manager

    def _get_redis_key(self, conversation_id: str) -> str:
        """Generate Redis key name with tenant prefix"""
        raw_key = f"conversation_data:{conversation_id}"
        return patch_redis_tenant_key(raw_key)

    async def save_conversation_data(
        self, raw_data_list: List[RawData], group_id: str
    ) -> bool:
        """
        Save conversation data to Redis cache

        Directly serialize and store RawData objects into Redis length-limited queue

        Args:
            raw_data_list: List of RawData
            group_id: Group ID

        Returns:
            bool: Return True if save succeeds, False otherwise
        """
        if not raw_data_list:
            logger.info("No conversation data to save: group_id=%s", group_id)
            return True

        logger.info(
            "Starting to save conversation data to Redis: group_id=%s, count=%d",
            group_id,
            len(raw_data_list),
        )

        try:
            cache_manager = await self._get_cache_manager()
            redis_key = self._get_redis_key(group_id)
            saved_count = 0

            for raw_data in raw_data_list:
                try:
                    # Extract timestamp from RawData
                    timestamp = None
                    if raw_data.content:
                        timestamp = raw_data.content.get(
                            'timestamp'
                        ) or raw_data.content.get('createTime')

                    # Ensure timestamp is a datetime object
                    if timestamp:
                        timestamp = _normalize_datetime_for_storage(timestamp)
                    else:
                        timestamp = get_now_with_timezone()

                    # Use Redis length-limited cache manager to append data
                    # Directly pass RawData object; cache manager handles serialization
                    success = await cache_manager.append(
                        redis_key,
                        raw_data.to_json(),  # Store serialized JSON string
                        timestamp=timestamp,
                    )

                    if success:
                        saved_count += 1
                        logger.debug(
                            "Successfully saved RawData to Redis: data_id=%s",
                            raw_data.data_id,
                        )
                    else:
                        logger.error(
                            "Failed to save RawData to Redis: data_id=%s",
                            raw_data.data_id,
                        )

                except (ValueError, TypeError, AttributeError) as e:
                    logger.error("Failed to process single RawData: %s", e)
                    # Continue to next data item, do not interrupt entire process
                    continue

            logger.info(
                "Completed saving conversation data to Redis: group_id=%s, successfully saved=%d/%d",
                group_id,
                saved_count,
                len(raw_data_list),
            )
            return saved_count > 0

        except (
            RuntimeError,
            ConnectionError,
            TimeoutError,
            ValueError,
            TypeError,
        ) as e:
            logger.error(
                "Failed to save conversation data to Redis: group_id=%s, error=%s",
                group_id,
                e,
            )
            return False

    async def get_conversation_data(
        self,
        group_id: str,
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
        limit: int = 100,
    ) -> List[RawData]:
        """
        Retrieve conversation data from Redis cache

        Read JSON data from Redis length-limited queue and deserialize into RawData objects

        Args:
            group_id: Group ID
            start_time: Start time (ISO format string)
            end_time: End time (ISO format string)
            limit: Limit number of returned items

        Returns:
            List[RawData]: List of conversation data
        """
        logger.info(
            "Starting to retrieve conversation data from Redis: group_id=%s, start_time=%s, end_time=%s, limit=%d",
            group_id,
            start_time,
            end_time,
            limit,
        )

        raw_data_list: List[RawData] = []

        try:
            cache_manager = await self._get_cache_manager()
            redis_key = self._get_redis_key(group_id)

            # Convert time format to datetime object
            start_dt = (
                _normalize_datetime_for_storage(start_time) if start_time else None
            )
            end_dt = _normalize_datetime_for_storage(end_time) if end_time else None

            # Use cache manager's method to get data by timestamp range
            try:
                # Use new method of cache manager to get data within specified time range
                cache_data_list = await cache_manager.get_by_timestamp_range(
                    redis_key,
                    start_timestamp=start_dt,
                    end_timestamp=end_dt,
                    limit=limit,
                )

                logger.debug(
                    "Retrieved %d messages from Redis by time range",
                    len(cache_data_list),
                )

                # Sort by timestamp in ascending order, earlier ones come first
                cache_data_list = sorted(
                    cache_data_list, key=lambda x: x.get("timestamp", 0)
                )
                # Deserialize messages into RawData objects
                for cache_data in cache_data_list:
                    try:
                        # Extract JSON string from cache data
                        json_data = cache_data.get("data")
                        if json_data is None:
                            logger.warning(
                                "Missing 'data' field in cache data: %s", cache_data
                            )
                            continue

                        # Use directly if data is already string; otherwise convert to string
                        if isinstance(json_data, dict):
                            # If it's a dictionary, cache manager has already parsed JSON, need to re-serialize
                            import json

                            json_str = json.dumps(json_data, ensure_ascii=False)
                        else:
                            json_str = str(json_data)

                        # Deserialize RawData object
                        raw_data = RawData.from_json_str(json_str)
                        raw_data_list.append(raw_data)

                    except (ValueError, TypeError, AttributeError) as e:
                        logger.error("Failed to deserialize RawData: %s", e)
                        continue

                logger.debug(
                    "Successfully deserialized %d RawData objects", len(raw_data_list)
                )

            except (
                RuntimeError,
                ConnectionError,
                TimeoutError,
                ValueError,
                TypeError,
            ) as e:
                logger.error("Error occurred while retrieving data from Redis: %s", e)
                return []

            logger.info(
                "Completed retrieving conversation data from Redis: group_id=%s, returned %d items",
                group_id,
                len(raw_data_list),
            )
            return raw_data_list

        except (
            RuntimeError,
            ConnectionError,
            TimeoutError,
            ValueError,
            TypeError,
        ) as e:
            logger.error(
                "Failed to retrieve conversation data from Redis: group_id=%s, error=%s",
                group_id,
                e,
            )
            return []

    async def delete_conversation_data(self, group_id: str) -> bool:
        """
        Delete all conversation data for the specified group

        Clear all cached messages for this group in Redis, typically used to reset conversation history after boundary checks

        Args:
            group_id: Group ID

        Returns:
            bool: Return True if deletion succeeds, False otherwise
        """
        logger.info("Starting to delete conversation data: group_id=%s", group_id)

        try:
            cache_manager = await self._get_cache_manager()
            redis_key = self._get_redis_key(group_id)

            # Use cache manager to delete entire key
            success = await cache_manager.clear_queue(redis_key)

            if success:
                logger.info(
                    "Successfully deleted conversation data: group_id=%s", group_id
                )
            else:
                logger.warning(
                    "Failed to delete conversation data or key does not exist: group_id=%s",
                    group_id,
                )

            return success

        except (
            RuntimeError,
            ConnectionError,
            TimeoutError,
            ValueError,
            TypeError,
        ) as e:
            logger.error(
                "Failed to delete conversation data: group_id=%s, error=%s", group_id, e
            )
            return False
