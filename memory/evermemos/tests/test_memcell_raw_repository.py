#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test the functionality of MemCellRawRepository

Test contents include:
1. CRUD operations based on event_id
2. Queries based on user_id
3. Queries based on time range (including segmented queries)
4. Queries based on group_id
5. Queries based on participants
6. Queries based on keywords
7. Batch deletion operations
8. Statistical and aggregation queries
"""

import asyncio
from common_utils.datetime_utils import get_now_with_timezone
from datetime import timedelta, datetime
from bson import ObjectId
from pydantic import BaseModel, Field

from core.di import get_bean_by_type
from infra_layer.adapters.out.persistence.repository.memcell_raw_repository import (
    MemCellRawRepository,
)
from infra_layer.adapters.out.persistence.document.memory.memcell import (
    MemCell,
    DataTypeEnum,
)
from core.observation.logger import get_logger

logger = get_logger(__name__)


# ==================== Projection Model Definition ====================
class MemCellProjection(BaseModel):
    """
    MemCell projection model - used to test field projection functionality
    Includes only partial fields, excluding large fields such as original_data
    """

    id: ObjectId = Field(alias="_id")
    user_id: str
    timestamp: datetime
    summary: str
    type: DataTypeEnum

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


async def test_basic_crud_operations():
    """Test basic CRUD operations based on event_id"""
    logger.info("Starting test of basic CRUD operations based on event_id...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_001"

    try:
        # First clean up any existing test data
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Test creating a new MemCell
        now = get_now_with_timezone()
        memcell = MemCell(
            user_id=user_id,
            timestamp=now,
            summary="This is a test memory: discussed the project's technical solution",
            type=DataTypeEnum.CONVERSATION,
            keywords=["technical solution", "project discussion"],
            participants=["Zhang San", "Li Si"],
        )

        created = await repo.append_memcell(memcell)
        assert created is not None
        assert created.user_id == user_id
        assert created.summary == "This is a test memory: discussed the project's technical solution"
        assert created.event_id is not None
        logger.info("✅ Test creating new MemCell succeeded, event_id=%s", created.event_id)

        event_id = str(created.event_id)

        # Test querying by event_id
        queried = await repo.get_by_event_id(event_id)
        assert queried is not None
        assert queried.user_id == user_id
        assert str(queried.event_id) == event_id
        logger.info("✅ Test querying by event_id succeeded")

        # Test updating MemCell
        update_data = {
            "summary": "Updated summary: project technical solution has been confirmed",
            "keywords": ["technical solution", "project discussion", "confirmed"],
        }

        updated = await repo.update_by_event_id(event_id, update_data)
        assert updated is not None
        assert updated.summary == "Updated summary: project technical solution has been confirmed"
        assert len(updated.keywords) == 3
        logger.info("✅ Test updating MemCell succeeded")

        # Test deleting MemCell
        deleted = await repo.delete_by_event_id(event_id)
        assert deleted is True
        logger.info("✅ Test deleting MemCell succeeded")

        # Verify deletion
        final_check = await repo.get_by_event_id(event_id)
        assert final_check is None, "Record should have been deleted"
        logger.info("✅ Verified deletion succeeded")

    except Exception as e:
        logger.error("❌ Basic CRUD operations test failed: %s", e)
        raise

    logger.info("✅ Basic CRUD operations test completed")


async def test_find_by_user_id():
    """Test queries based on user_id"""
    logger.info("Starting test of queries based on user_id...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_002"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create multiple records
        now = get_now_with_timezone()
        for i in range(5):
            memcell = MemCell(
                user_id=user_id,
                timestamp=now - timedelta(hours=i),
                summary=f"Test memory {i+1}",
                type=DataTypeEnum.CONVERSATION,
            )
            await repo.append_memcell(memcell)

        logger.info("✅ Created 5 test records")

        # Test querying all records (descending)
        results = await repo.find_by_user_id(user_id, sort_desc=True)
        assert len(results) == 5
        assert results[0].summary == "Test memory 1"  # Latest
        logger.info("✅ Test querying all records (descending) succeeded")

        # Test querying all records (ascending)
        results_asc = await repo.find_by_user_id(user_id, sort_desc=False)
        assert len(results_asc) == 5
        assert results_asc[0].summary == "Test memory 5"  # Earliest
        logger.info("✅ Test querying all records (ascending) succeeded")

        # Test limiting number
        limited_results = await repo.find_by_user_id(user_id, limit=2)
        assert len(limited_results) == 2
        logger.info("✅ Test limiting number succeeded")

        # Test skip and limit
        skip_results = await repo.find_by_user_id(user_id, skip=2, limit=2)
        assert len(skip_results) == 2
        logger.info("✅ Test skip and limit succeeded")

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test based on user_id query failed: %s", e)
        raise

    logger.info("✅ Queries based on user_id test completed")


async def test_find_by_time_range():
    """Test queries based on time range (including segmented queries)"""
    logger.info("Starting test of queries based on time range...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_003"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create test data with a large span (10 days)
        # Use time from 1990 to avoid conflicts with existing data
        # Note: Must use timezone-aware time, otherwise it will not match the timezone stored in MongoDB
        from common_utils.datetime_utils import get_timezone

        tz = get_timezone()
        start_time = datetime(1990, 1, 1, 0, 0, 0, tzinfo=tz)

        # Create one record per day
        created_timestamps = []
        for i in range(10):
            ts = start_time + timedelta(days=i)
            created_timestamps.append(ts)
            memcell = MemCell(
                user_id=user_id,
                timestamp=ts,
                summary=f"Day {i+1} memory",
                type=DataTypeEnum.CONVERSATION,
            )
            await repo.append_memcell(memcell)

        logger.info("✅ Created 10 days of test data")
        logger.info(
            "   Timestamp range: %s to %s", created_timestamps[0], created_timestamps[-1]
        )

        # Test small range query (3 days, does not trigger segmentation)
        # Query day 0, 1, 2 (total 3 records)
        small_start = start_time  # 1990-01-01 00:00:00
        small_end = start_time + timedelta(days=3)  # 1990-01-04 00:00:00 (exclusive)
        small_results = await repo.find_by_time_range(small_start, small_end)
        logger.info("   Small range query returned %d records (expected 3)", len(small_results))
        assert (
            len(small_results) == 3
        ), f"Expected 3 records, got {len(small_results)}"
        logger.info("✅ Test small range query (3 days) succeeded, found %d records", len(small_results))

        # Test large range query (10 days, triggers segmented query)
        # Query day 0-9 (total 10 records)
        # The last record is 1990-01-10 00:00:00, query uses $lt, so end time must be > 1990-01-10
        large_start = start_time  # 1990-01-01 00:00:00
        large_end = start_time + timedelta(
            days=10, seconds=1
        )  # 1990-01-11 00:00:01 (ensure day 9 is included)
        logger.info("   Query time range: %s to %s", large_start, large_end)
        large_results = await repo.find_by_time_range(large_start, large_end)
        logger.info("   Large range query returned %d records (expected 10)", len(large_results))

        # Print returned record timestamps for debugging
        logger.info("   Returned record details:")
        for idx, mc in enumerate(large_results):
            logger.info("     [%d] %s - %s", idx, mc.timestamp, mc.summary)

        if len(large_results) != 10:
            logger.warning("   ⚠️ Record count mismatch!")
            logger.warning("   Expected timestamps:")
            for idx, ts in enumerate(created_timestamps):
                logger.warning("     [%d] %s", idx, ts)

            # Find missing records
            returned_timestamps = {mc.timestamp for mc in large_results}
            missing = [ts for ts in created_timestamps if ts not in returned_timestamps]
            if missing:
                logger.error("   ❌ Missing timestamps:")
                for ts in missing:
                    logger.error("     - %s", ts)

        assert (
            len(large_results) == 10
        ), f"Expected 10 records, got {len(large_results)}"
        logger.info("✅ Test large range query (10 days) succeeded, found %d records", len(large_results))

        # Test descending query
        desc_results = await repo.find_by_time_range(
            large_start, large_end, sort_desc=True
        )
        assert len(desc_results) == 10
        assert "Day 10" in desc_results[0].summary  # Latest first
        logger.info("✅ Test descending query succeeded")

        # Test ascending query
        asc_results = await repo.find_by_time_range(
            large_start, large_end, sort_desc=False
        )
        assert len(asc_results) == 10
        assert "Day 1" in asc_results[0].summary  # Earliest first
        logger.info("✅ Test ascending query succeeded")

        # Test pagination
        page_results = await repo.find_by_time_range(large_start, large_end, limit=5)
        assert len(page_results) == 5
        logger.info("✅ Test pagination succeeded")

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test time range query failed: %s", e)
        raise

    logger.info("✅ Time range query test completed")


async def test_find_by_user_and_time_range():
    """Test queries based on user and time range"""
    logger.info("Starting test of queries based on user and time range...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_004"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create test data
        now = get_now_with_timezone()
        start_time = now - timedelta(days=5)

        for i in range(5):
            memcell = MemCell(
                user_id=user_id,
                timestamp=start_time + timedelta(days=i),
                summary=f"User memory {i+1}",
                type=DataTypeEnum.CONVERSATION,
            )
            await repo.append_memcell(memcell)

        logger.info("✅ Created 5 test records")

        # Test querying data for middle 3 days
        query_start = start_time + timedelta(days=1)
        query_end = start_time + timedelta(days=4)
        results = await repo.find_by_user_and_time_range(
            user_id, query_start, query_end
        )

        assert len(results) == 3
        logger.info("✅ Test user and time range query succeeded, found %d records", len(results))

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test user and time range query failed: %s", e)
        raise

    logger.info("✅ User and time range query test completed")


async def test_find_by_group_id():
    """Test queries based on group_id"""
    logger.info("Starting test of queries based on group_id...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_005"
    group_id = "test_group_001"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create group records
        now = get_now_with_timezone()
        for i in range(3):
            memcell = MemCell(
                user_id=user_id,
                group_id=group_id,
                timestamp=now - timedelta(hours=i),
                summary=f"Group memory {i+1}",
                type=DataTypeEnum.CONVERSATION,
            )
            await repo.append_memcell(memcell)

        logger.info("✅ Created 3 group records")

        # Test query
        results = await repo.find_by_group_id(group_id)
        assert len(results) == 3
        logger.info("✅ Test querying by group_id succeeded, found %d records", len(results))

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test group_id query failed: %s", e)
        raise

    logger.info("✅ group_id query test completed")


async def test_find_by_participants():
    """Test queries based on participants"""
    logger.info("Starting test of queries based on participants...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_006"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create test data
        now = get_now_with_timezone()

        # Record 1: Zhang San, Li Si
        memcell1 = MemCell(
            user_id=user_id,
            timestamp=now - timedelta(hours=1),
            summary="Record 1: Conversation between Zhang San and Li Si",
            participants=["Zhang San", "Li Si"],
        )
        await repo.append_memcell(memcell1)

        # Record 2: Zhang San, Wang Wu
        memcell2 = MemCell(
            user_id=user_id,
            timestamp=now - timedelta(hours=2),
            summary="Record 2: Conversation between Zhang San and Wang Wu",
            participants=["Zhang San", "Wang Wu"],
        )
        await repo.append_memcell(memcell2)

        # Record 3: Li Si, Wang Wu
        memcell3 = MemCell(
            user_id=user_id,
            timestamp=now - timedelta(hours=3),
            summary="Record 3: Conversation between Li Si and Wang Wu",
            participants=["Li Si", "Wang Wu"],
        )
        await repo.append_memcell(memcell3)

        logger.info("✅ Created 3 test records")

        # Test matching any participant (containing "Zhang San")
        results_any = await repo.find_by_participants(["Zhang San"], match_all=False)
        assert len(results_any) == 2
        logger.info("✅ Test matching any participant succeeded, found %d records", len(results_any))

        # Test matching all participants (containing both "Zhang San" and "Li Si")
        results_all = await repo.find_by_participants(["Zhang San", "Li Si"], match_all=True)
        assert len(results_all) == 1
        logger.info("✅ Test matching all participants succeeded, found %d records", len(results_all))

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test participant query failed: %s", e)
        raise

    logger.info("✅ Participant query test completed")


async def test_search_by_keywords():
    """Test queries based on keywords"""
    logger.info("Starting test of queries based on keywords...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_007"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create test data
        now = get_now_with_timezone()

        # Record 1: technology, Python
        memcell1 = MemCell(
            user_id=user_id,
            timestamp=now - timedelta(hours=1),
            summary="Record 1: Python technology discussion",
            keywords=["technology", "Python"],
        )
        await repo.append_memcell(memcell1)

        # Record 2: technology, Java
        memcell2 = MemCell(
            user_id=user_id,
            timestamp=now - timedelta(hours=2),
            summary="Record 2: Java technology discussion",
            keywords=["technology", "Java"],
        )
        await repo.append_memcell(memcell2)

        # Record 3: design, architecture
        memcell3 = MemCell(
            user_id=user_id,
            timestamp=now - timedelta(hours=3),
            summary="Record 3: Architecture design discussion",
            keywords=["design", "architecture"],
        )
        await repo.append_memcell(memcell3)

        logger.info("✅ Created 3 test records")

        # Test matching any keyword (containing "technology")
        results_any = await repo.search_by_keywords(["technology"], match_all=False)
        assert len(results_any) == 2
        logger.info("✅ Test matching any keyword succeeded, found %d records", len(results_any))

        # Test matching all keywords (containing both "technology" and "Python")
        results_all = await repo.search_by_keywords(["technology", "Python"], match_all=True)
        assert len(results_all) == 1
        logger.info("✅ Test matching all keywords succeeded, found %d records", len(results_all))

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test keyword query failed: %s", e)
        raise

    logger.info("✅ Keyword query test completed")


async def test_batch_delete_operations():
    """Test batch deletion operations"""
    logger.info("Starting test of batch deletion operations...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_008"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create test data
        now = get_now_with_timezone()
        for i in range(10):
            memcell = MemCell(
                user_id=user_id,
                timestamp=now - timedelta(days=i),
                summary=f"Test memory {i+1}",
                type=DataTypeEnum.CONVERSATION,
            )
            await repo.append_memcell(memcell)

        logger.info("✅ Created 10 test records")

        # Test deleting records within a time range (first 5 days)
        delete_start = now - timedelta(days=5)
        delete_end = now
        deleted_count = await repo.delete_by_time_range(
            delete_start, delete_end, user_id=user_id
        )
        assert deleted_count == 5
        logger.info("✅ Test deleting records within time range succeeded, deleted %d records", deleted_count)

        # Verify remaining records
        remaining = await repo.find_by_user_id(user_id)
        assert len(remaining) == 5
        logger.info("✅ Verified remaining records successfully, %d records left", len(remaining))

        # Test deleting all user records
        total_deleted = await repo.delete_by_user_id(user_id)
        assert total_deleted == 5
        logger.info("✅ Test deleting all user records succeeded, deleted %d records", total_deleted)

        # Verify all deleted
        final_check = await repo.find_by_user_id(user_id)
        assert len(final_check) == 0
        logger.info("✅ Verified all deleted successfully")

    except Exception as e:
        logger.error("❌ Test batch deletion operations failed: %s", e)
        raise

    logger.info("✅ Batch deletion operations test completed")


async def test_statistics_and_aggregation():
    """Test statistical and aggregation queries"""
    logger.info("Starting test of statistical and aggregation queries...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_009"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create test data of different types
        now = get_now_with_timezone()
        start_time = now - timedelta(days=7)

        # Create 6 conversation memories (Note: Originally 3 conversations, 2 emails, 1 document, but now only CONVERSATION type)
        for i in range(3):
            memcell = MemCell(
                user_id=user_id,
                timestamp=start_time + timedelta(days=i),
                summary=f"Conversation memory {i+1}",
                type=DataTypeEnum.CONVERSATION,
            )
            await repo.append_memcell(memcell)

        for i in range(2):
            memcell = MemCell(
                user_id=user_id,
                timestamp=start_time + timedelta(days=i + 3),
                summary=f"Email memory {i+1}",
                type=DataTypeEnum.CONVERSATION,
            )
            await repo.append_memcell(memcell)

        memcell = MemCell(
            user_id=user_id,
            timestamp=start_time + timedelta(days=5),
            summary="Document memory",
            type=DataTypeEnum.CONVERSATION,
        )
        await repo.append_memcell(memcell)

        logger.info("✅ Created 6 test records (all CONVERSATION type)")

        # Test counting total user records
        total_count = await repo.count_by_user_id(user_id)
        assert total_count == 6
        logger.info("✅ Test counting total user records succeeded, total %d records", total_count)

        # Test counting records within a time range
        range_start = start_time
        range_end = start_time + timedelta(days=4)
        range_count = await repo.count_by_time_range(
            range_start, range_end, user_id=user_id
        )
        assert range_count == 4  # Records from first 4 days (3 conversation memories + 1 email memory)
        logger.info("✅ Test counting records within time range succeeded, total %d records", range_count)

        # Test getting user's latest records
        latest = await repo.get_latest_by_user(user_id, limit=3)
        assert len(latest) == 3
        assert latest[0].summary == "Document memory"  # Latest
        logger.info("✅ Test getting user's latest records succeeded")

        # Test getting user activity summary
        summary = await repo.get_user_activity_summary(user_id, start_time, now)
        assert summary["total_count"] == 6
        assert summary["user_id"] == user_id
        assert DataTypeEnum.CONVERSATION.value in summary["type_distribution"]
        assert (
            summary["type_distribution"][DataTypeEnum.CONVERSATION.value] == 6
        )  # All records are of CONVERSATION type
        logger.info("✅ Test getting user activity summary succeeded")
        logger.info("   Activity summary: %s", summary)

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test statistical and aggregation queries failed: %s", e)
        raise

    logger.info("✅ Statistical and aggregation queries test completed")


async def test_get_by_event_ids():
    """Test batch query by event_ids"""
    logger.info("Starting test of batch query by event_ids...")

    repo = get_bean_by_type(MemCellRawRepository)
    user_id = "test_user_010"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create test data
        now = get_now_with_timezone()
        created_memcells = []

        for i in range(5):
            memcell = MemCell(
                user_id=user_id,
                timestamp=now - timedelta(hours=i),
                summary=f"Test memory {i+1}",
                episode=f"This is the detailed content of test memory {i+1}",
                type=DataTypeEnum.CONVERSATION,
                keywords=[f"keyword{i+1}", "test"],
            )
            created = await repo.append_memcell(memcell)
            created_memcells.append(created)

        logger.info("✅ Created 5 test records")

        # Prepare event_ids
        event_ids = [str(mc.event_id) for mc in created_memcells[:3]]
        logger.info("   Preparing to query event_ids: %s", event_ids)

        # Test 1: Batch query (without projection)
        results = await repo.get_by_event_ids(event_ids)
        assert isinstance(results, dict), "Return result should be a dictionary"
        assert len(results) == 3, f"Should return 3 records, got {len(results)}"

        # Verify returned is a dictionary, key is event_id
        for event_id in event_ids:
            assert event_id in results, f"event_id {event_id} should be in results"
            memcell = results[event_id]
            assert memcell.user_id == user_id
            assert memcell.episode is not None

        logger.info("✅ Test batch query (without projection) succeeded, returned %d records", len(results))

        # Test 2: Batch query (with field projection)
        # Use Pydantic projection model to return only specified fields, excluding large fields like original_data
        results_with_projection = await repo.get_by_event_ids(
            event_ids, projection_model=MemCellProjection
        )

        assert isinstance(results_with_projection, dict), "Return result should be a dictionary"
        assert (
            len(results_with_projection) == 3
        ), f"Should return 3 records, got {len(results_with_projection)}"

        # Verify projection effect: returned should be MemCellProjection instances
        for event_id, memcell_projection in results_with_projection.items():
            assert isinstance(
                memcell_projection, MemCellProjection
            ), "Returned should be MemCellProjection instance"
            assert memcell_projection.summary is not None, "summary field should exist"
            assert memcell_projection.timestamp is not None, "timestamp field should exist"
            assert memcell_projection.type is not None, "type field should exist"
            assert memcell_projection.user_id == user_id, "user_id should match"
            # Verify fields not defined in projection model are not included
            assert not hasattr(
                memcell_projection, 'original_data'
            ), "original_data field should not exist"
            assert not hasattr(memcell_projection, 'episode'), "episode field should not exist"

        logger.info(
            "✅ Test batch query (with field projection) succeeded, returned %d records",
            len(results_with_projection),
        )

        # Test 3: Query partially valid event_ids (including an invalid one)
        mixed_event_ids = event_ids[:2] + ["invalid_id_123", "507f1f77bcf86cd799439011"]
        results_mixed = await repo.get_by_event_ids(mixed_event_ids)

        # Should only return 2 valid records
        assert (
            len(results_mixed) == 2
        ), f"Should return 2 records, got {len(results_mixed)}"
        assert event_ids[0] in results_mixed
        assert event_ids[1] in results_mixed
        assert "invalid_id_123" not in results_mixed
        assert "507f1f77bcf86cd799439011" not in results_mixed

        logger.info(
            "✅ Test querying partially valid event_ids succeeded, returned %d records", len(results_mixed)
        )

        # Test 4: Empty list input
        results_empty = await repo.get_by_event_ids([])
        assert isinstance(results_empty, dict), "Return result should be a dictionary"
        assert len(results_empty) == 0, "Empty list should return empty dictionary"
        logger.info("✅ Test empty list input succeeded")

        # Test 5: Query non-existent event_ids
        non_existent_ids = ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
        results_non_existent = await repo.get_by_event_ids(non_existent_ids)
        assert isinstance(results_non_existent, dict), "Return result should be a dictionary"
        assert len(results_non_existent) == 0, "Non-existent event_ids should return empty dictionary"
        logger.info("✅ Test querying non-existent event_ids succeeded")

        # Test 6: Verify returned data integrity
        first_event_id = event_ids[0]
        first_memcell = results[first_event_id]
        original_memcell = created_memcells[0]

        assert str(first_memcell.event_id) == str(original_memcell.event_id)
        assert first_memcell.summary == original_memcell.summary
        assert first_memcell.user_id == original_memcell.user_id
        logger.info("✅ Verified returned data integrity succeeded")

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Test batch query by event_ids failed: %s", e)
        import traceback

        logger.error("Detailed error: %s", traceback.format_exc())
        raise

    logger.info("✅ Batch query by event_ids test completed")


async def run_all_tests():
    """Run all tests"""
    logger.info("🚀 Starting to run all MemCellRawRepository tests...")

    try:
        await test_basic_crud_operations()
        await test_find_by_user_id()
        await test_find_by_time_range()
        await test_find_by_user_and_time_range()
        await test_find_by_group_id()
        await test_find_by_participants()
        await test_search_by_keywords()
        await test_batch_delete_operations()
        await test_statistics_and_aggregation()
        await test_get_by_event_ids()
        logger.info("✅✅✅ All tests completed!")
    except Exception as e:
        logger.error("❌ Error occurred during testing: %s", e)
        raise


if __name__ == "__main__":
    asyncio.run(run_all_tests())