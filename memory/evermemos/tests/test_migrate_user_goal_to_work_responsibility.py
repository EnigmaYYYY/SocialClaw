#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Core Memories Data Migration Script

Feature 1: Copy the user_goal value from each record in the core_memories and group_core_profile_memory tables to the work_responsibility field,
           and set the user_goal field to null.

Feature 2: Rename the "skill" key to "value" key within the soft_skills and hard_skills fields of the core_memories and group_core_profile_memory tables.

Function Selection:
    1. Execute user_goal data migration only
    2. Execute skill field renaming only
    3. Execute all functions
    4. Exit

Usage:
    python src/bootstrap.py tests/migrate_user_goal_to_work_responsibility.py
"""

import asyncio
from typing import List, Optional, Dict, Any

# Import dependency injection related modules
from core.di.utils import get_bean_by_type, get_bean
from core.observation.logger import get_logger

# Import MongoDB related modules
from infra_layer.adapters.out.persistence.document.memory.core_memory import CoreMemory
from infra_layer.adapters.out.persistence.repository.core_memory_raw_repository import (
    CoreMemoryRawRepository,
)
from infra_layer.adapters.out.persistence.document.memory.group_user_profile_memory import (
    GroupUserProfileMemory,
)
from infra_layer.adapters.out.persistence.repository.group_user_profile_memory_raw_repository import (
    GroupUserProfileMemoryRawRepository,
)

# Get logger
logger = get_logger(__name__)


async def get_core_memory_repository():
    """Get CoreMemory repository instance"""
    try:
        # Get Bean by type (recommended)
        core_memory_repo = get_bean_by_type(CoreMemoryRawRepository)
        logger.info(f"✅ Successfully obtained CoreMemoryRawRepository: {type(core_memory_repo)}")
        return core_memory_repo
    except Exception as e:
        logger.error(f"❌ Failed to get CoreMemoryRawRepository: {e}")
        raise


async def get_group_user_profile_memory_repository():
    """Get GroupUserProfileMemory repository instance"""
    try:
        # Get Bean by type (recommended)
        group_repo = get_bean_by_type(GroupUserProfileMemoryRawRepository)
        logger.info(
            f"✅ Successfully obtained GroupUserProfileMemoryRawRepository: {type(group_repo)}"
        )
        return group_repo
    except Exception as e:
        logger.error(f"❌ Failed to get GroupUserProfileMemoryRawRepository: {e}")
        raise


async def preview_migration_data(repo: CoreMemoryRawRepository):
    """Preview data to be migrated"""
    print("\n" + "=" * 60)
    print("📊 Preview migration data")
    print("=" * 60)

    try:
        # Query data in batches to avoid loading all data into memory at once
        batch_size = 2000
        all_records = []
        total_count = 0
        batch_num = 0

        print("🔍 Querying data in batches...")

        while True:
            batch_num += 1
            print(f"📦 Querying batch {batch_num}...")

            # Batch query, use sorting to ensure data consistency, use skip and limit
            batch_records = (
                await CoreMemory.find({"user_goal": {"$ne": None, "$exists": True}})
                .sort([("_id", 1)])
                .skip(total_count)
                .limit(batch_size)
                .to_list()
            )

            if not batch_records:
                break

            all_records.extend(batch_records)
            total_count += len(batch_records)
            print(f"   Found {len(batch_records)} records in batch {batch_num}")

            # If the number of returned records is less than the batch size, it means the query is complete
            if len(batch_records) < batch_size:
                break

        print(f"📈 Found a total of {total_count} records containing user_goal data")

        if total_count > 0:
            print("\n📋 Preview of first 5 records:")
            for i, record in enumerate(all_records[:5]):
                print(f"  {i+1}. User ID: {record.user_id}")
                print(f"     user_goal: {record.user_goal}")
                print(f"     work_responsibility: {record.work_responsibility}")
                print()

        return all_records

    except Exception as e:
        logger.error(f"❌ Failed to preview data: {e}")
        raise


async def migrate_user_goal_to_work_responsibility(
    repo: CoreMemoryRawRepository, records: List[CoreMemory]
):
    """Execute data migration: copy user_goal to work_responsibility, and set user_goal to null"""
    print("\n" + "=" * 60)
    print("🔄 Starting data migration")
    print("=" * 60)

    success_count = 0
    error_count = 0

    for record in records:
        try:
            # Check if there is user_goal data
            if not record.user_goal:
                logger.warning(f"⚠️  Record {record.user_id} has empty user_goal, skipping")
                continue

            # Directly modify record attributes
            record.work_responsibility = (
                record.user_goal
            )  # Copy user_goal to work_responsibility
            record.user_goal = None  # Set user_goal to null

            # Save updated record
            await record.save()

            # Update success
            success_count += 1
            logger.info(f"✅ Successfully migrated record {record.user_id}")
            print(f"✅ Migration successful: {record.user_id}")

        except Exception as e:
            error_count += 1
            logger.error(f"❌ Error migrating record {record.user_id}: {e}")
            print(f"❌ Migration error: {record.user_id} - {e}")

    print(f"\n📊 Migration completion statistics:")
    print(f"   ✅ Success: {success_count} records")
    print(f"   ❌ Failure: {error_count} records")
    print(f"   📈 Total: {len(records)} records")

    return success_count, error_count


async def verify_migration_results(repo: CoreMemoryRawRepository):
    """Verify migration results"""
    print("\n" + "=" * 60)
    print("🔍 Verifying migration results")
    print("=" * 60)

    try:
        # Check if there are still records where user_goal is not null
        remaining_user_goals = await CoreMemory.find(
            {"user_goal": {"$ne": None}}
        ).to_list()

        # Check how many records have data in work_responsibility
        records_with_work_responsibility = await CoreMemory.find(
            {"work_responsibility": {"$ne": None, "$exists": True}}
        ).to_list()

        print(f"📊 Verification results:")
        print(f"   Remaining records where user_goal is not null: {len(remaining_user_goals)}")
        print(
            f"   Records with work_responsibility data: {len(records_with_work_responsibility)}"
        )

        if len(remaining_user_goals) == 0:
            print("✅ All user_goal fields have been successfully set to null")
        else:
            print("⚠️  Some user_goal fields have not been set to null")
            for record in remaining_user_goals[:3]:  # Show first 3
                print(f"   - {record.user_id}: {record.user_goal}")

        return len(remaining_user_goals) == 0

    except Exception as e:
        logger.error(f"❌ Failed to verify migration results: {e}")
        raise


async def preview_group_migration_data():
    """Preview data to be migrated for group user profile memory"""
    print("\n" + "=" * 60)
    print("📊 Previewing group user profile memory migration data")
    print("=" * 60)

    try:
        # Query data in batches to avoid loading all data into memory at once
        batch_size = 2000
        all_records = []
        total_count = 0
        batch_num = 0

        print("🔍 Querying group data in batches...")

        while True:
            batch_num += 1
            print(f"📦 Querying batch {batch_num}...")

            # Batch query, use sorting to ensure data consistency, use skip and limit
            batch_records = (
                await GroupUserProfileMemory.find(
                    {"user_goal": {"$ne": None, "$exists": True}}
                )
                .sort([("_id", 1)])
                .skip(total_count)
                .limit(batch_size)
                .to_list()
            )

            if not batch_records:
                break

            all_records.extend(batch_records)
            total_count += len(batch_records)
            print(f"   Found {len(batch_records)} records in batch {batch_num}")

            # If the number of returned records is less than the batch size, it means the query is complete
            if len(batch_records) < batch_size:
                break

        print(f"📈 Found a total of {total_count} group user profile records containing user_goal data")

        if total_count > 0:
            print("\n📋 Preview of first 5 records:")
            for i, record in enumerate(all_records[:5]):
                print(
                    f"  {i+1}. User ID: {record.user_id}, Group ID: {record.group_id}"
                )
                print(f"     user_goal: {record.user_goal}")
                print(f"     work_responsibility: {record.work_responsibility}")
                print()

        return all_records

    except Exception as e:
        logger.error(f"❌ Failed to preview group data: {e}")
        raise


async def migrate_group_user_goal_to_work_responsibility(
    records: List[GroupUserProfileMemory],
):
    """Execute group user profile memory data migration: copy user_goal to work_responsibility, and set user_goal to null"""
    print("\n" + "=" * 60)
    print("🔄 Starting group user profile memory data migration")
    print("=" * 60)

    success_count = 0
    error_count = 0

    for record in records:
        try:
            # Check if there is user_goal data
            if not record.user_goal:
                logger.warning(
                    f"⚠️  Group record {record.user_id}-{record.group_id} has empty user_goal, skipping"
                )
                continue

            # Directly modify record attributes
            record.work_responsibility = (
                record.user_goal
            )  # Copy user_goal to work_responsibility
            record.user_goal = None  # Set user_goal to null

            # Save updated record
            await record.save()

            # Update success
            success_count += 1
            logger.info(f"✅ Successfully migrated group record {record.user_id}-{record.group_id}")
            print(f"✅ Group migration successful: {record.user_id}-{record.group_id}")

        except Exception as e:
            error_count += 1
            logger.error(
                f"❌ Error migrating group record {record.user_id}-{record.group_id}: {e}"
            )
            print(f"❌ Group migration error: {record.user_id}-{record.group_id} - {e}")

    print(f"\n📊 Group migration completion statistics:")
    print(f"   ✅ Success: {success_count} records")
    print(f"   ❌ Failure: {error_count} records")
    print(f"   📈 Total: {len(records)} records")

    return success_count, error_count


async def verify_group_migration_results():
    """Verify group user profile memory migration results"""
    print("\n" + "=" * 60)
    print("🔍 Verifying group user profile memory migration results")
    print("=" * 60)

    try:
        # Check if there are still records where user_goal is not null
        remaining_user_goals = await GroupUserProfileMemory.find(
            {"user_goal": {"$ne": None}}
        ).to_list()

        # Check how many records have data in work_responsibility
        records_with_work_responsibility = await GroupUserProfileMemory.find(
            {"work_responsibility": {"$ne": None, "$exists": True}}
        ).to_list()

        print(f"📊 Group verification results:")
        print(f"   Remaining records where user_goal is not null: {len(remaining_user_goals)}")
        print(
            f"   Records with work_responsibility data: {len(records_with_work_responsibility)}"
        )

        if len(remaining_user_goals) == 0:
            print("✅ All group user_goal fields have been successfully set to null")
        else:
            print("⚠️  Some group user_goal fields have not been set to null")
            for record in remaining_user_goals[:3]:  # Show first 3
                print(f"   - {record.user_id}-{record.group_id}: {record.user_goal}")

        return len(remaining_user_goals) == 0

    except Exception as e:
        logger.error(f"❌ Failed to verify group migration results: {e}")
        raise


async def preview_skills_rename_data():
    """Preview data for skill field renaming"""
    print("\n" + "=" * 60)
    print("📊 Previewing skill field renaming data")
    print("=" * 60)

    try:
        # Query CoreMemory records containing skill fields in batches
        print("🔍 Querying CoreMemory skill field data in batches...")
        core_batch_size = 2000
        core_all_records = []
        core_total_count = 0
        core_batch_num = 0

        while True:
            core_batch_num += 1
            print(f"📦 Querying CoreMemory batch {core_batch_num}...")

            batch_records = (
                await CoreMemory.find(
                    {
                        "$or": [
                            {"soft_skills.skill": {"$exists": True}},
                            {"hard_skills.skill": {"$exists": True}},
                        ]
                    }
                )
                .sort([("_id", 1)])
                .skip(core_total_count)
                .limit(core_batch_size)
                .to_list()
            )

            if not batch_records:
                break

            core_all_records.extend(batch_records)
            core_total_count += len(batch_records)
            print(f"   Found {len(batch_records)} records in batch {core_batch_num}")

            if len(batch_records) < core_batch_size:
                break

        # Query GroupUserProfileMemory records containing skill fields in batches
        print("🔍 Querying GroupUserProfileMemory skill field data in batches...")
        group_batch_size = 2000
        group_all_records = []
        group_total_count = 0
        group_batch_num = 0

        while True:
            group_batch_num += 1
            print(f"📦 Querying GroupUserProfileMemory batch {group_batch_num}...")

            batch_records = (
                await GroupUserProfileMemory.find(
                    {
                        "$or": [
                            {"soft_skills.skill": {"$exists": True}},
                            {"hard_skills.skill": {"$exists": True}},
                        ]
                    }
                )
                .sort([("_id", 1)])
                .skip(group_total_count)
                .limit(group_batch_size)
                .to_list()
            )

            if not batch_records:
                break

            group_all_records.extend(batch_records)
            group_total_count += len(batch_records)
            print(f"   Found {len(batch_records)} records in batch {group_batch_num}")

            if len(batch_records) < group_batch_size:
                break

        print(f"📈 Found a total of {core_total_count} records in CoreMemory table containing skill fields")
        print(
            f"📈 Found a total of {group_total_count} records in GroupUserProfileMemory table containing skill fields"
        )

        if core_all_records:
            print("\n📋 Preview of first 3 CoreMemory records:")
            for i, record in enumerate(core_all_records[:3]):
                print(f"  {i+1}. User ID: {record.user_id}")
                if hasattr(record, 'soft_skills') and record.soft_skills:
                    print(f"     soft_skills: {record.soft_skills}")
                if hasattr(record, 'hard_skills') and record.hard_skills:
                    print(f"     hard_skills: {record.hard_skills}")
                print()

        if group_all_records:
            print("\n📋 Preview of first 3 GroupUserProfileMemory records:")
            for i, record in enumerate(group_all_records[:3]):
                print(
                    f"  {i+1}. User ID: {record.user_id}, Group ID: {record.group_id}"
                )
                if hasattr(record, 'soft_skills') and record.soft_skills:
                    print(f"     soft_skills: {record.soft_skills}")
                if hasattr(record, 'hard_skills') and record.hard_skills:
                    print(f"     hard_skills: {record.hard_skills}")
                print()

        return core_all_records, group_all_records

    except Exception as e:
        logger.error(f"❌ Failed to preview skill field data: {e}")
        raise


async def rename_skill_to_value_in_core_memory(records: List[CoreMemory]):
    """Rename the skill key to value key in skill fields of CoreMemory"""
    print("\n" + "=" * 60)
    print("🔄 Starting renaming of CoreMemory skill fields")
    print("=" * 60)

    success_count = 0
    error_count = 0

    for record in records:
        try:
            updated = False

            # Process soft_skills field
            if hasattr(record, 'soft_skills') and record.soft_skills:
                if isinstance(record.soft_skills, list):
                    for skill_item in record.soft_skills:
                        if isinstance(skill_item, dict) and 'skill' in skill_item:
                            skill_item['value'] = skill_item.pop('skill')
                            updated = True
                elif (
                    isinstance(record.soft_skills, dict)
                    and 'skill' in record.soft_skills
                ):
                    record.soft_skills['value'] = record.soft_skills.pop('skill')
                    updated = True

            # Process hard_skills field
            if hasattr(record, 'hard_skills') and record.hard_skills:
                if isinstance(record.hard_skills, list):
                    for skill_item in record.hard_skills:
                        if isinstance(skill_item, dict) and 'skill' in skill_item:
                            skill_item['value'] = skill_item.pop('skill')
                            updated = True
                elif (
                    isinstance(record.hard_skills, dict)
                    and 'skill' in record.hard_skills
                ):
                    record.hard_skills['value'] = record.hard_skills.pop('skill')
                    updated = True

            if updated:
                # Save updated record
                await record.save()
                success_count += 1
                logger.info(
                    f"✅ Successfully renamed skill fields in CoreMemory record {record.user_id}"
                )
                print(f"✅ Rename successful: {record.user_id}")
            else:
                logger.warning(
                    f"⚠️  CoreMemory record {record.user_id} has no skill fields to rename"
                )

        except Exception as e:
            error_count += 1
            logger.error(f"❌ Error renaming skill fields in CoreMemory record {record.user_id}: {e}")
            print(f"❌ Rename error: {record.user_id} - {e}")

    print(f"\n📊 CoreMemory rename completion statistics:")
    print(f"   ✅ Success: {success_count} records")
    print(f"   ❌ Failure: {error_count} records")
    print(f"   📈 Total: {len(records)} records")

    return success_count, error_count


async def rename_skill_to_value_in_group_memory(records: List[GroupUserProfileMemory]):
    """Rename the skill key to value key in skill fields of GroupUserProfileMemory"""
    print("\n" + "=" * 60)
    print("🔄 Starting renaming of GroupUserProfileMemory skill fields")
    print("=" * 60)

    success_count = 0
    error_count = 0

    for record in records:
        try:
            updated = False

            # Process soft_skills field
            if hasattr(record, 'soft_skills') and record.soft_skills:
                if isinstance(record.soft_skills, list):
                    for skill_item in record.soft_skills:
                        if isinstance(skill_item, dict) and 'skill' in skill_item:
                            skill_item['value'] = skill_item.pop('skill')
                            updated = True
                elif (
                    isinstance(record.soft_skills, dict)
                    and 'skill' in record.soft_skills
                ):
                    record.soft_skills['value'] = record.soft_skills.pop('skill')
                    updated = True

            # Process hard_skills field
            if hasattr(record, 'hard_skills') and record.hard_skills:
                if isinstance(record.hard_skills, list):
                    for skill_item in record.hard_skills:
                        if isinstance(skill_item, dict) and 'skill' in skill_item:
                            skill_item['value'] = skill_item.pop('skill')
                            updated = True
                elif (
                    isinstance(record.hard_skills, dict)
                    and 'skill' in record.hard_skills
                ):
                    record.hard_skills['value'] = record.hard_skills.pop('skill')
                    updated = True

            if updated:
                # Save updated record
                await record.save()
                success_count += 1
                logger.info(
                    f"✅ Successfully renamed skill fields in GroupUserProfileMemory record {record.user_id}-{record.group_id}"
                )
                print(f"✅ Group rename successful: {record.user_id}-{record.group_id}")
            else:
                logger.warning(
                    f"⚠️  GroupUserProfileMemory record {record.user_id}-{record.group_id} has no skill fields to rename"
                )

        except Exception as e:
            error_count += 1
            logger.error(
                f"❌ Error renaming skill fields in GroupUserProfileMemory record {record.user_id}-{record.group_id}: {e}"
            )
            print(f"❌ Group rename error: {record.user_id}-{record.group_id} - {e}")

    print(f"\n📊 GroupUserProfileMemory rename completion statistics:")
    print(f"   ✅ Success: {success_count} records")
    print(f"   ❌ Failure: {error_count} records")
    print(f"   📈 Total: {len(records)} records")

    return success_count, error_count


async def verify_skills_rename_results():
    """Verify skill field rename results"""
    print("\n" + "=" * 60)
    print("🔍 Verifying skill field rename results")
    print("=" * 60)

    try:
        # Check if there are still records with skill fields in CoreMemory
        core_remaining_skill = await CoreMemory.find(
            {
                "$or": [
                    {"soft_skills.skill": {"$exists": True}},
                    {"hard_skills.skill": {"$exists": True}},
                ]
            }
        ).to_list()

        # Check if there are still records with skill fields in GroupUserProfileMemory
        group_remaining_skill = await GroupUserProfileMemory.find(
            {
                "$or": [
                    {"soft_skills.skill": {"$exists": True}},
                    {"hard_skills.skill": {"$exists": True}},
                ]
            }
        ).to_list()

        # Check how many records have data in value fields
        core_records_with_value = await CoreMemory.find(
            {
                "$or": [
                    {"soft_skills.value": {"$exists": True}},
                    {"hard_skills.value": {"$exists": True}},
                ]
            }
        ).to_list()

        group_records_with_value = await GroupUserProfileMemory.find(
            {
                "$or": [
                    {"soft_skills.value": {"$exists": True}},
                    {"hard_skills.value": {"$exists": True}},
                ]
            }
        ).to_list()

        print(f"📊 Skill field rename verification results:")
        print(f"   CoreMemory records with remaining skill fields: {len(core_remaining_skill)}")
        print(
            f"   GroupUserProfileMemory records with remaining skill fields: {len(group_remaining_skill)}"
        )
        print(f"   CoreMemory records with value fields: {len(core_records_with_value)}")
        print(
            f"   GroupUserProfileMemory records with value fields: {len(group_records_with_value)}"
        )

        if len(core_remaining_skill) == 0 and len(group_remaining_skill) == 0:
            print("✅ All skill keys in skill fields have been successfully renamed to value")
        else:
            print("⚠️  Some skill keys in skill fields have not been renamed")
            if core_remaining_skill:
                print("   CoreMemory remaining records:")
                for record in core_remaining_skill[:2]:
                    print(f"   - {record.user_id}")
            if group_remaining_skill:
                print("   GroupUserProfileMemory remaining records:")
                for record in group_remaining_skill[:2]:
                    print(f"   - {record.user_id}-{record.group_id}")

        return len(core_remaining_skill) == 0 and len(group_remaining_skill) == 0

    except Exception as e:
        logger.error(f"❌ Failed to verify skill field rename results: {e}")
        raise


async def main():
    """Main function"""
    print("🚀 Core Memories and Group User Profile Memory Data Migration Script Started")
    print(f"📝 Current script: {__file__}")
    print("📋 Involved tables: core_memories, group_core_profile_memory")

    # Function selection menu
    print("\n" + "=" * 60)
    print("📋 Please select the function to execute:")
    print("=" * 60)
    print("1. Migrate user_goal data to work_responsibility field")
    print("2. Rename skill fields (skill -> value)")
    print("3. Execute all functions")
    print("4. Exit")
    print("=" * 60)

    try:
        # Get user selection
        while True:
            try:
                choice = input("\nPlease enter your choice (1-4): ").strip()
                if choice in ['1', '2', '3', '4']:
                    break
                else:
                    print("❌ Invalid choice, please enter a number between 1-4")
            except KeyboardInterrupt:
                print("\n\n👋 User canceled operation, exiting program")
                return
            except EOFError:
                print("\n\n👋 Input ended, exiting program")
                return

        # Execute selected function
        if choice == '4':
            print("👋 Exiting program")
            return

        print(f"\n✅ Selected function: {choice}")

        # Execute selected function
        if choice == '1':
            await execute_user_goal_migration()
        elif choice == '2':
            await execute_skills_rename()
        elif choice == '3':
            await execute_all_functions()

    except Exception as e:
        logger.error(f"❌ Migration script execution failed: {e}")
        print(f"\n❌ Migration failed: {e}")
        raise


async def execute_user_goal_migration():
    """Execute user_goal data migration function"""
    print("\n" + "=" * 80)
    print("🏠 Starting user_goal data migration")
    print("=" * 80)

    try:
        # ==================== 1. Core Memories Migration ====================
        print("\n" + "=" * 80)
        print("🏠 Starting processing of Core Memories table")
        print("=" * 80)

        # 1.1 Get repository instance
        core_memory_repo = await get_core_memory_repository()

        # 1.2 Preview data to be migrated
        core_records_to_migrate = await preview_migration_data(core_memory_repo)

        if core_records_to_migrate:
            print(f"\n⚠️  About to migrate {len(core_records_to_migrate)} Core Memories records")
            print("   This operation will:")
            print("   - Copy the value of user_goal to work_responsibility")
            print("   - Set the user_goal field to null")
            print("   - This operation is irreversible, please confirm to continue")

            # 1.3 Execute Core Memories data migration
            core_success_count, core_error_count = (
                await migrate_user_goal_to_work_responsibility(
                    core_memory_repo, core_records_to_migrate
                )
            )

            # 1.4 Verify Core Memories migration results
            core_migration_success = await verify_migration_results(core_memory_repo)
        else:
            print("ℹ️  No data to migrate in Core Memories table")
            core_success_count, core_error_count = 0, 0
            core_migration_success = True

        # ==================== 2. Group User Profile Memory Migration ====================
        print("\n" + "=" * 80)
        print("👥 Starting processing of Group User Profile Memory table")
        print("=" * 80)

        # 2.1 Get group repository instance
        group_repo = await get_group_user_profile_memory_repository()

        # 2.2 Preview group data to be migrated
        group_records_to_migrate = await preview_group_migration_data()

        if group_records_to_migrate:
            print(
                f"\n⚠️  About to migrate {len(group_records_to_migrate)} Group User Profile Memory records"
            )
            print("   This operation will:")
            print("   - Copy the value of user_goal to work_responsibility")
            print("   - Set the user_goal field to null")
            print("   - This operation is irreversible, please confirm to continue")

            # 2.3 Execute group data migration
            group_success_count, group_error_count = (
                await migrate_group_user_goal_to_work_responsibility(
                    group_records_to_migrate
                )
            )

            # 2.4 Verify group migration results
            group_migration_success = await verify_group_migration_results()
        else:
            print("ℹ️  No data to migrate in Group User Profile Memory table")
            group_success_count, group_error_count = 0, 0
            group_migration_success = True

        # ==================== 3. Summary Report ====================
        print("\n" + "=" * 80)
        print("📊 user_goal migration completion summary report")
        print("=" * 80)

        print(f"🏠 Core Memories table:")
        print(f"   ✅ Success: {core_success_count} records")
        print(f"   ❌ Failure: {core_error_count} records")
        print(
            f"   📈 Total: {len(core_records_to_migrate) if core_records_to_migrate else 0} records"
        )

        print(f"\n👥 Group User Profile Memory table:")
        print(f"   ✅ Success: {group_success_count} records")
        print(f"   ❌ Failure: {group_error_count} records")
        print(
            f"   📈 Total: {len(group_records_to_migrate) if group_records_to_migrate else 0} records"
        )

        total_success = core_success_count + group_success_count
        total_error = core_error_count + group_error_count

        print(f"\n🎯 Overall results:")
        print(f"   ✅ Total success: {total_success} records")
        print(f"   ❌ Total failure: {total_error} records")

        if core_migration_success and group_migration_success and total_error == 0:
            print("\n🎉 user_goal data migration completed successfully!")
        elif total_success > 0:
            print("\n⚠️  user_goal data migration partially successful, please check error logs")
        else:
            print("\n❌ user_goal data migration failed, please check error logs")
        print("=" * 80)

    except Exception as e:
        logger.error(f"❌ user_goal migration script execution failed: {e}")
        print(f"\n❌ user_goal migration failed: {e}")
        raise


async def execute_skills_rename():
    """Execute skill field rename function"""
    print("\n" + "=" * 80)
    print("🔧 Starting skill field rename")
    print("=" * 80)

    try:
        # ==================== 1. Preview skill field rename data ====================
        print("\n" + "=" * 80)
        print("🔧 Starting processing of skill field rename")
        print("=" * 80)

        # 1.1 Preview data for skill field rename
        core_skill_records, group_skill_records = await preview_skills_rename_data()

        # ==================== 2. Process CoreMemory skill field rename ====================
        core_skill_success_count = 0
        core_skill_error_count = 0
        if core_skill_records:
            print(f"\n⚠️  About to rename {len(core_skill_records)} CoreMemory skill fields")
            print("   This operation will:")
            print("   - Rename the 'skill' key to 'value' key in soft_skills and hard_skills")
            print("   - This operation is irreversible, please confirm to continue")

            core_skill_success_count, core_skill_error_count = (
                await rename_skill_to_value_in_core_memory(core_skill_records)
            )
        else:
            print("ℹ️  No skill fields to rename in CoreMemory table")

        # ==================== 3. Process GroupUserProfileMemory skill field rename ====================
        group_skill_success_count = 0
        group_skill_error_count = 0
        if group_skill_records:
            print(
                f"\n⚠️  About to rename {len(group_skill_records)} GroupUserProfileMemory skill fields"
            )
            print("   This operation will:")
            print("   - Rename the 'skill' key to 'value' key in soft_skills and hard_skills")
            print("   - This operation is irreversible, please confirm to continue")

            group_skill_success_count, group_skill_error_count = (
                await rename_skill_to_value_in_group_memory(group_skill_records)
            )
        else:
            print("ℹ️  No skill fields to rename in GroupUserProfileMemory table")

        # ==================== 4. Verify skill field rename results ====================
        skills_rename_success = await verify_skills_rename_results()

        # ==================== 5. Summary Report ====================
        print("\n" + "=" * 80)
        print("📊 Skill field rename completion summary report")
        print("=" * 80)

        print(f"🔧 CoreMemory table:")
        print(f"   ✅ Success: {core_skill_success_count} records")
        print(f"   ❌ Failure: {core_skill_error_count} records")
        print(f"   📈 Total: {len(core_skill_records) if core_skill_records else 0} records")

        print(f"\n🔧 GroupUserProfileMemory table:")
        print(f"   ✅ Success: {group_skill_success_count} records")
        print(f"   ❌ Failure: {group_skill_error_count} records")
        print(
            f"   📈 Total: {len(group_skill_records) if group_skill_records else 0} records"
        )

        total_success = core_skill_success_count + group_skill_success_count
        total_error = core_skill_error_count + group_skill_error_count

        print(f"\n🎯 Overall results:")
        print(f"   ✅ Total success: {total_success} records")
        print(f"   ❌ Total failure: {total_error} records")

        if skills_rename_success and total_error == 0:
            print("\n🎉 Skill field rename completed successfully!")
        elif total_success > 0:
            print("\n⚠️  Skill field rename partially successful, please check error logs")
        else:
            print("\n❌ Skill field rename failed, please check error logs")
        print("=" * 80)

    except Exception as e:
        logger.error(f"❌ Skill field rename script execution failed: {e}")
        print(f"\n❌ Skill field rename failed: {e}")
        raise


async def execute_all_functions():
    """Execute all functions"""
    print("\n" + "=" * 80)
    print("🚀 Starting execution of all functions")
    print("=" * 80)

    try:
        # Execute user_goal migration
        # await execute_user_goal_migration()

        # Execute skill field rename
        await execute_skills_rename()

        print("\n🎉 All functions executed successfully!")

    except Exception as e:
        logger.error(f"❌ Failed to execute all functions: {e}")
        print(f"\n❌ Failed to execute all functions: {e}")
        raise


if __name__ == "__main__":
    # Execute when this script is run directly
    # Note: When running through bootstrap.py, the environment has already been initialized
    asyncio.run(main())