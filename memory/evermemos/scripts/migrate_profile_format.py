"""
Profile Format Migration Script

将数据库中的旧格式 profile 统一转换为新的 ProfileField[] 格式。

旧格式:
- traits: ["直率", "踏实"]
- communication_style: {tone_style: "friendly", frequent_phrases: [...]}

新格式:
- traits: [{value: "直率", evidences: []}, {value: "踏实", evidences: []}]
- communication_style: [{value: "friendly", evidences: []}, ...]
"""

import asyncio
import sys
from typing import Any, Dict, List
from motor.motor_asyncio import AsyncIOMotorClient

# MongoDB 配置
MONGO_URI = "mongodb://admin:memsys123@localhost:27017/?authSource=admin"
DATABASE = "memsys"
COLLECTION = "unified_profiles"


def convert_string_array_to_profile_fields(items: List[str]) -> List[Dict[str, Any]]:
    """将字符串数组转换为 ProfileField 数组"""
    if not items:
        return []
    return [{"value": item, "evidences": []} for item in items if isinstance(item, str) and item.strip()]


def convert_nested_dict_to_profile_fields(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """将嵌套字典（如 communication_style）转换为 ProfileField 数组"""
    if not data:
        return []

    result = []

    # 需要提取为数组的字段
    array_fields = ['frequent_phrases', 'emoji_usage', 'punctuation_style']
    # 字符串值字段
    string_fields = ['tone_style', 'avg_message_length']

    for key, value in data.items():
        if key in array_fields and isinstance(value, list):
            for v in value:
                if isinstance(v, str) and v.strip():
                    result.append({"value": v.strip(), "evidences": []})
        elif key in string_fields and isinstance(value, str) and value.strip():
            # 过滤掉无效值
            if value not in ('short', 'medium', 'long', 'unknown'):
                result.append({"value": value.strip(), "evidences": []})

    return result


def is_profile_field_array(items: List) -> bool:
    """检查是否已经是 ProfileField 格式"""
    if not items:
        return True
    if not isinstance(items, list):
        return False
    if len(items) == 0:
        return True
    first = items[0]
    return isinstance(first, dict) and 'value' in first


def needs_conversion(field_data: Any) -> bool:
    """检查字段是否需要转换"""
    if not field_data:
        return False
    if isinstance(field_data, list):
        if len(field_data) == 0:
            return False
        # 字符串数组需要转换
        return isinstance(field_data[0], str)
    if isinstance(field_data, dict):
        # 嵌套字典需要转换
        return not ('value' in field_data)
    return False


def migrate_profile(profile: Dict[str, Any]) -> Dict[str, Any]:
    """迁移单个 profile"""
    updates = {}

    # 列表字段 - 字符串数组 -> ProfileField[]
    list_fields = [
        'traits', 'interests', 'way_of_decision_making', 'life_habit_preference',
        'catchphrase', 'user_to_friend_catchphrase', 'user_to_friend_chat_style',
        'motivation_system', 'fear_system', 'value_system', 'humor_use'
    ]

    for field in list_fields:
        data = profile.get(field)
        if data and isinstance(data, list) and len(data) > 0:
            if isinstance(data[0], str):
                updates[field] = convert_string_array_to_profile_fields(data)

    # communication_style - 嵌套字典 -> ProfileField[]
    cs = profile.get('communication_style')
    if cs and isinstance(cs, dict):
        updates['communication_style'] = convert_nested_dict_to_profile_fields(cs)

    # 单值字段 - 字符串 -> ProfileField
    single_fields = ['occupation', 'relationship']
    for field in single_fields:
        data = profile.get(field)
        if data and isinstance(data, str):
            updates[field] = {"value": data, "evidences": []}

    return updates


async def run_migration(dry_run: bool = True):
    """执行迁移"""
    client = AsyncIOMotorClient(MONGO_URI)
    db = client[DATABASE]
    collection = db[COLLECTION]

    print(f"{'[DRY RUN] ' if dry_run else ''}Starting profile format migration...")

    # 获取所有 profiles
    profiles = await collection.find({}).to_list(length=None)
    print(f"Found {len(profiles)} profiles to check")

    migrated_count = 0
    skipped_count = 0

    for profile in profiles:
        profile_id = profile.get('profile_id', 'unknown')
        display_name = profile.get('display_name', 'unknown')
        # 安全编码显示名称
        try:
            safe_name = display_name.encode('ascii', 'replace').decode('ascii')
        except:
            safe_name = 'unknown'

        updates = migrate_profile(profile)

        if updates:
            migrated_count += 1
            # 使用 profile_id 作为唯一标识，避免编码问题
            log_id = f"{profile_id}"
            sys.stdout.write(f"\n{'[DRY RUN] ' if dry_run else ''}Migrating: {log_id}\n")
            sys.stdout.write(f"  Updates: {list(updates.keys())}\n")
            sys.stdout.flush()

            if not dry_run:
                result = await collection.update_one(
                    {"profile_id": profile_id},
                    {"$set": updates}
                )
                if result.modified_count > 0:
                    sys.stdout.write(f"  OK\n")
                else:
                    sys.stdout.write(f"  No changes\n")
                sys.stdout.flush()
        else:
            skipped_count += 1

    print(f"\n{'='*50}")
    print(f"Migration {'simulation' if dry_run else 'complete'}:")
    print(f"  Total profiles: {len(profiles)}")
    print(f"  Would migrate: {migrated_count}")
    print(f"  Already correct format: {skipped_count}")

    if dry_run:
        print(f"\nRun with --execute to apply changes")

    client.close()


def main():
    dry_run = '--execute' not in sys.argv
    asyncio.run(run_migration(dry_run=dry_run))


if __name__ == "__main__":
    main()