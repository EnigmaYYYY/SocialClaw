#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test version management functionality of CoreMemoryRawRepository

Test contents include:
1. CRUD operations based on user_id (with version management support)
2. Version management related features
3. ensure_latest method test
4. only_latest functionality test for batch queries
"""

import asyncio

from core.di import get_bean_by_type
from infra_layer.adapters.out.persistence.repository.core_memory_raw_repository import (
    CoreMemoryRawRepository,
)
from core.observation.logger import get_logger

logger = get_logger(__name__)


async def test_basic_crud_operations():
    """Test basic CRUD operations (with version management)"""
    logger.info("Starting test for basic CRUD operations...")

    repo = get_bean_by_type(CoreMemoryRawRepository)
    user_id = "test_user_001"

    try:
        # First clean up any existing test data
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Test creating a new record (version must be provided)
        user_data = {
            "version": "v1",
            "user_name": "Zhang San",
            "gender": "Male",
            "position": "Senior Engineer",
            "department": "Technology Department",
        }

        result = await repo.upsert_by_user_id(user_id, user_data)
        assert result is not None
        assert result.user_id == user_id
        assert result.user_name == "Zhang San"
        assert result.version == "v1"
        assert result.is_latest == True
        logger.info("✅ Successfully created new record (version=v1, is_latest=True)")

        # Test querying by user_id (should return the latest version)
        queried = await repo.get_by_user_id(user_id)
        assert queried is not None
        assert queried.user_id == user_id
        assert queried.version == "v1"
        assert queried.is_latest == True
        logger.info("✅ Successfully queried by user_id")

        # Test updating record (without changing version)
        update_data = {"position": "Senior Engineer", "department": "R&D Department"}

        updated = await repo.update_by_user_id(user_id, update_data)
        assert updated is not None
        assert updated.position == "Senior Engineer"
        assert updated.department == "R&D Department"
        assert updated.version == "v1"  # Version unchanged
        assert updated.user_name == "Zhang San"  # Unupdated fields should retain original values
        logger.info("✅ Successfully updated record (version unchanged)")

        # Test deleting a specific version
        deleted = await repo.delete_by_user_id(user_id, version="v1")
        assert deleted is True
        logger.info("✅ Successfully deleted specific version")

        # Verify deletion
        final_check = await repo.get_by_user_id(user_id)
        assert final_check is None, "Record should have been deleted"
        logger.info("✅ Verified deletion success")

    except Exception as e:
        logger.error("❌ Basic CRUD operations test failed: %s", e)
        raise

    logger.info("✅ Basic CRUD operations test completed")


async def test_version_management():
    """Test version management functionality"""
    logger.info("Starting test for version management functionality...")

    repo = get_bean_by_type(CoreMemoryRawRepository)
    user_id = "test_user_version_002"

    try:
        # First clean up any existing test data
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create first version
        v1_data = {"version": "202501", "user_name": "Li Si v1", "position": "Engineer"}

        v1_result = await repo.upsert_by_user_id(user_id, v1_data)
        assert v1_result is not None
        assert v1_result.version == "202501"
        assert v1_result.is_latest == True
        logger.info("✅ Successfully created version 202501, is_latest=True")

        # Create second version
        v2_data = {"version": "202502", "user_name": "Li Si v2", "position": "Senior Engineer"}

        v2_result = await repo.upsert_by_user_id(user_id, v2_data)
        assert v2_result is not None
        assert v2_result.version == "202502"
        assert v2_result.is_latest == True
        logger.info("✅ Successfully created version 202502, is_latest=True")

        # Create third version
        v3_data = {"version": "202503", "user_name": "Li Si v3", "position": "Senior Engineer"}

        v3_result = await repo.upsert_by_user_id(user_id, v3_data)
        assert v3_result is not None
        assert v3_result.version == "202503"
        assert v3_result.is_latest == True
        logger.info("✅ Successfully created version 202503, is_latest=True")

        # Test getting latest version (without specifying version_range)
        latest = await repo.get_by_user_id(user_id)
        assert latest is not None
        assert latest.version == "202503"
        assert latest.is_latest == True
        logger.info("✅ Successfully retrieved latest version: version=202503")

        # Test version range query (left-closed, right-open)
        v2_by_range = await repo.get_by_user_id(
            user_id, version_range=("202502", "202503")
        )
        assert v2_by_range is not None
        assert v2_by_range.version == "202502"
        logger.info("✅ Version range query [202502, 202503) succeeded, returned version=202502")

        # Test updating a specific version
        update_v2 = {"position": "Updated Senior Engineer"}

        updated_v2 = await repo.update_by_user_id(user_id, update_v2, version="202502")
        assert updated_v2 is not None
        assert updated_v2.version == "202502"
        assert updated_v2.position == "Updated Senior Engineer"
        logger.info("✅ Successfully updated specific version 202502")

        # Test deleting a middle version
        await repo.delete_by_user_id(user_id, version="202502")
        logger.info("✅ Successfully deleted version 202502")

        # Verify latest version remains correct after deletion
        latest_after_delete = await repo.get_by_user_id(user_id)
        assert latest_after_delete is not None
        assert latest_after_delete.version == "202503"
        assert latest_after_delete.is_latest == True
        logger.info("✅ After deleting middle version, latest version is still correct")

        # Clean up all versions
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Successfully cleaned up test data")

    except Exception as e:
        logger.error("❌ Version management functionality test failed: %s", e)
        raise

    logger.info("✅ Version management functionality test completed")


async def test_ensure_latest():
    """Test ensure_latest method"""
    logger.info("Starting test for ensure_latest method...")

    repo = get_bean_by_type(CoreMemoryRawRepository)
    user_id = "test_user_ensure_003"

    try:
        # First clean up any existing test data
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up existing test data")

        # Create multiple versions
        versions = ["202501", "202502", "202503", "202504"]
        for version in versions:
            data = {
                "version": version,
                "user_name": f"Wang Wu {version}",
                "position": f"Version {version}",
            }
            await repo.upsert_by_user_id(user_id, data)

        logger.info("✅ Created 4 versions")

        # Manually call ensure_latest
        result = await repo.ensure_latest(user_id)
        assert result is True
        logger.info("✅ ensure_latest executed successfully")

        # Verify latest version
        latest = await repo.get_by_user_id(user_id)
        assert latest is not None
        assert latest.version == "202504"
        assert latest.is_latest == True
        logger.info("✅ Verified latest version is correct: version=202504, is_latest=True")

        # Verify is_latest is False for old versions
        for old_version in ["202501", "202502", "202503"]:
            old_doc = await repo.get_by_user_id(
                user_id, version_range=(old_version, str(int(old_version) + 1))
            )
            assert old_doc is not None
            assert old_doc.is_latest == False
            logger.info("✅ Verified old version %s has is_latest=False", old_version)

        # Test idempotency: call ensure_latest again
        result2 = await repo.ensure_latest(user_id)
        assert result2 is True
        logger.info("✅ ensure_latest idempotency verification succeeded")

        # Clean up test data
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ ensure_latest method test failed: %s", e)
        raise

    logger.info("✅ ensure_latest method test completed")


async def test_batch_query_with_only_latest():
    """Test only_latest functionality in batch query"""
    logger.info("Starting test for only_latest functionality in batch query...")

    repo = get_bean_by_type(CoreMemoryRawRepository)
    base_user_id = "test_batch_user"

    try:
        # Create multiple users, each with multiple versions
        user_ids = [f"{base_user_id}_{i}" for i in range(1, 4)]

        # First clean up
        for uid in user_ids:
            await repo.delete_by_user_id(uid)
        logger.info("✅ Cleaned up existing test data")

        # Create multiple versions for each user
        for uid in user_ids:
            for version in ["202501", "202502", "202503"]:
                data = {
                    "version": version,
                    "user_name": f"{uid}_{version}",
                    "position": f"User {uid} Version {version}",
                }
                await repo.upsert_by_user_id(uid, data)

        logger.info("✅ Created 3 users, each with 3 versions")

        # Test only_latest=True (default)
        latest_results = await repo.find_by_user_ids(user_ids, only_latest=True)
        assert len(latest_results) == 3

        for result in latest_results:
            assert result.version == "202503"
            assert result.is_latest == True

        logger.info("✅ Batch query with only_latest=True succeeded, returned 3 latest versions")

        # Test only_latest=False (return all versions)
        all_results = await repo.find_by_user_ids(user_ids, only_latest=False)
        assert len(all_results) == 9  # 3 users * 3 versions
        logger.info("✅ Batch query with only_latest=False succeeded, returned 9 versions")

        # Clean up test data
        for uid in user_ids:
            await repo.delete_by_user_id(uid)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Batch query only_latest functionality test failed: %s", e)
        raise

    logger.info("✅ Batch query only_latest functionality test completed")


async def test_profile_fields():
    """Test profile related fields"""
    logger.info("Starting test for profile related fields...")

    repo = get_bean_by_type(CoreMemoryRawRepository)
    user_id = "test_user_profile_005"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)

        # Create record with profile fields
        user_data = {
            "version": "v1",
            "user_name": "Test User",
            "hard_skills": [
                {"value": "Python", "level": "Advanced", "evidences": ["conv_001"]}
            ],
            "soft_skills": [
                {"value": "Communication", "level": "Excellent", "evidences": ["conv_002"]}
            ],
            "personality": [{"value": "Introverted but communicative", "evidences": ["conv_003"]}],
            "interests": [{"value": "Programming", "evidences": ["conv_004"]}],
        }

        result = await repo.upsert_by_user_id(user_id, user_data)
        assert result is not None
        assert result.hard_skills is not None
        assert len(result.hard_skills) == 1
        assert result.hard_skills[0]["value"] == "Python"
        logger.info("✅ Successfully created record with profile fields")

        # Test get_profile method
        profile = repo.get_profile(result)
        assert profile is not None
        assert "hard_skills" in profile
        assert "soft_skills" in profile
        assert "personality" in profile
        assert "interests" in profile
        logger.info("✅ get_profile method test succeeded")

        # Test get_base method
        base = repo.get_base(result)
        assert base is not None
        assert "user_name" in base
        logger.info("✅ get_base method test succeeded")

        # Clean up
        await repo.delete_by_user_id(user_id)
        logger.info("✅ Cleaned up test data successfully")

    except Exception as e:
        logger.error("❌ Profile fields test failed: %s", e)
        raise

    logger.info("✅ Profile fields test completed")


async def test_create_without_version_should_fail():
    """Test creating without providing version should fail"""
    logger.info("Starting test for creating without version should fail...")

    repo = get_bean_by_type(CoreMemoryRawRepository)
    user_id = "test_no_version_006"

    try:
        # First clean up
        await repo.delete_by_user_id(user_id)

        # Attempt to create record without version
        data_without_version = {"user_name": "User without version", "position": "This should fail"}

        try:
            await repo.upsert_by_user_id(user_id, data_without_version)
            assert False, "Creating record without version should raise an exception"
        except ValueError as e:
            logger.info("✅ Correctly raised ValueError: %s", str(e))
            assert "Version field must be provided" in str(e)

        logger.info("✅ Creating without version correctly failed")

    except AssertionError:
        raise
    except Exception as e:
        logger.error("❌ Test for creating without version failed: %s", e)
        raise

    logger.info("✅ Test for creating without version completed")


async def run_all_tests():
    """Run all tests"""
    logger.info("🚀 Starting all CoreMemory tests...")

    try:
        await test_basic_crud_operations()
        await test_version_management()
        await test_ensure_latest()
        await test_batch_query_with_only_latest()
        await test_profile_fields()
        await test_create_without_version_should_fail()
        logger.info("✅ All tests completed")
    except Exception as e:
        logger.error("❌ Error occurred during testing: %s", e)
        raise


if __name__ == "__main__":
    asyncio.run(run_all_tests())