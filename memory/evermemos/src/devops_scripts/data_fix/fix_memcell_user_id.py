"""
修复 MemCell 的 user_id 字段

背景：
- MemCell 之前保存时 user_id 始终为 None
- 导致无法通过 owner_user_id 查询 MemCell
- 现在修复为：user_id = owner_user_id

迁移策略：
1. 查询所有 user_id 为 None 的 MemCell
2. 通过 group_id (conversation_id) 查询 unified_profiles 获取 owner_user_id
3. 更新 MemCell 的 user_id = owner_user_id

运行方式：
    cd D:\\SC\\EverMemOS
    python src/devops_scripts/data_fix/fix_memcell_user_id.py --dry-run
    python src/devops_scripts/data_fix/fix_memcell_user_id.py
"""

import asyncio
import os
from typing import Optional, Dict, Any

from core.observation.logger import get_logger

logger = get_logger(__name__)


async def fix_memcell_user_id(batch_size: int = 100, dry_run: bool = False) -> Dict[str, int]:
    """
    修复 MemCell 的 user_id 字段

    Args:
        batch_size: 批处理大小
        dry_run: 是否只模拟运行，不实际修改数据

    Returns:
        统计信息: {"total": 总数, "updated": 更新成功数, "skipped": 跳过数, "error": 错误数}
    """
    from motor.motor_asyncio import AsyncIOMotorClient
    from common_utils.load_env import load_dotenv

    # 加载环境变量
    load_dotenv()

    # 获取 MongoDB 连接信息
    mongo_uri = os.getenv("MONGODB_URI")
    mongo_host = os.getenv("MONGODB_HOST", "localhost")
    mongo_port = int(os.getenv("MONGODB_PORT", "27017"))
    mongo_user = os.getenv("MONGODB_USERNAME", "")
    mongo_password = os.getenv("MONGODB_PASSWORD", "")
    mongo_db = os.getenv("MONGODB_DATABASE", "memos")
    mongo_uri_params = os.getenv("MONGODB_URI_PARAMS", "")

    # 构建连接字符串
    if mongo_uri:
        # 优先使用 MONGODB_URI
        uri = mongo_uri
    elif mongo_user and mongo_password:
        # URL encode 密码中的特殊字符
        from urllib.parse import quote_plus
        encoded_user = quote_plus(mongo_user)
        encoded_password = quote_plus(mongo_password)
        uri = f"mongodb://{encoded_user}:{encoded_password}@{mongo_host}:{mongo_port}/{mongo_db}"
        if mongo_uri_params:
            uri += f"?{mongo_uri_params}"
    else:
        uri = f"mongodb://{mongo_host}:{mongo_port}/{mongo_db}"

    client = AsyncIOMotorClient(uri)
    db = client[mongo_db]

    stats = {
        "total": 0,
        "updated": 0,
        "skipped_no_group_id": 0,
        "skipped_no_profile": 0,
        "skipped_already_has_user_id": 0,
        "error": 0,
    }

    # 缓存 conversation_id -> owner_user_id 映射
    conversation_owner_cache: Dict[str, str] = {}

    async def get_owner_by_conversation_id(conversation_id: str) -> Optional[str]:
        """根据 conversation_id 获取 owner_user_id"""
        if conversation_id in conversation_owner_cache:
            return conversation_owner_cache[conversation_id] or None

        profile = await db.unified_profiles.find_one(
            {"conversation_id": conversation_id}
        )
        if profile:
            owner_user_id = profile.get("owner_user_id", "")
            conversation_owner_cache[conversation_id] = owner_user_id
            return owner_user_id

        # 缓存未找到的结果
        conversation_owner_cache[conversation_id] = ""
        return None

    logger.info("开始修复 MemCell user_id...")
    if dry_run:
        logger.info("【模拟运行】不会实际修改数据")

    # 分批查询所有 MemCell
    skip = 0
    while True:
        # 查询一批 MemCell
        memcells = await db.memcells.find().sort("timestamp", -1).skip(skip).limit(batch_size).to_list(length=None)

        if not memcells:
            logger.info("没有更多 MemCell 需要处理")
            break

        for memcell in memcells:
            stats["total"] += 1

            # 已经有 user_id 的跳过
            if memcell.get("user_id"):
                stats["skipped_already_has_user_id"] += 1
                continue

            # 没有 group_id 的跳过
            if not memcell.get("group_id"):
                stats["skipped_no_group_id"] += 1
                logger.debug(f"MemCell {memcell['_id']} 没有 group_id，跳过")
                continue

            # 通过 conversation_id 查找 owner_user_id
            owner_user_id = await get_owner_by_conversation_id(memcell["group_id"])

            if not owner_user_id:
                stats["skipped_no_profile"] += 1
                logger.debug(f"MemCell {memcell['_id']} 的 group_id={memcell['group_id']} 找不到对应的 profile，跳过")
                continue

            # 更新 user_id
            if dry_run:
                logger.info(f"【模拟】将更新 MemCell {memcell['_id']}: user_id=None -> {owner_user_id}")
                stats["updated"] += 1
            else:
                try:
                    result = await db.memcells.update_one(
                        {"_id": memcell["_id"]},
                        {"$set": {"user_id": owner_user_id}}
                    )
                    if result.modified_count > 0:
                        stats["updated"] += 1
                        logger.debug(f"已更新 MemCell {memcell['_id']}: user_id={owner_user_id}")
                    else:
                        stats["error"] += 1
                        logger.warning(f"MemCell {memcell['_id']} 更新未生效")
                except Exception as e:
                    stats["error"] += 1
                    logger.error(f"更新 MemCell {memcell['_id']} 失败: {e}")

        skip += batch_size
        logger.info(f"已处理 {stats['total']} 条 MemCell，更新 {stats['updated']} 条")

    # 关闭数据库连接
    client.close()

    logger.info("=" * 50)
    logger.info("修复完成，统计信息:")
    logger.info(f"  总处理数: {stats['total']}")
    logger.info(f"  更新成功: {stats['updated']}")
    logger.info(f"  跳过（已有 user_id）: {stats['skipped_already_has_user_id']}")
    logger.info(f"  跳过（无 group_id）: {stats['skipped_no_group_id']}")
    logger.info(f"  跳过（无对应 profile）: {stats['skipped_no_profile']}")
    logger.info(f"  错误数: {stats['error']}")

    return stats


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="修复 MemCell 的 user_id 字段")
    parser.add_argument("--batch-size", type=int, default=100, help="批处理大小")
    parser.add_argument("--dry-run", action="store_true", help="模拟运行，不实际修改数据")
    parser.add_argument("--stats", action="store_true", help="只显示统计信息")

    args = parser.parse_args()

    if args.stats:
        asyncio.run(show_stats())
    else:
        asyncio.run(fix_memcell_user_id(batch_size=args.batch_size, dry_run=args.dry_run))


async def show_stats():
    """显示统计信息"""
    from motor.motor_asyncio import AsyncIOMotorClient
    from common_utils.load_env import load_dotenv

    load_dotenv()

    mongo_uri = os.getenv("MONGODB_URI")
    mongo_host = os.getenv("MONGODB_HOST", "localhost")
    mongo_port = int(os.getenv("MONGODB_PORT", "27017"))
    mongo_user = os.getenv("MONGODB_USERNAME", "")
    mongo_password = os.getenv("MONGODB_PASSWORD", "")
    mongo_db = os.getenv("MONGODB_DATABASE", "memos")
    mongo_uri_params = os.getenv("MONGODB_URI_PARAMS", "")

    if mongo_uri:
        uri = mongo_uri
    elif mongo_user and mongo_password:
        from urllib.parse import quote_plus
        encoded_user = quote_plus(mongo_user)
        encoded_password = quote_plus(mongo_password)
        uri = f"mongodb://{encoded_user}:{encoded_password}@{mongo_host}:{mongo_port}/{mongo_db}"
        if mongo_uri_params:
            uri += f"?{mongo_uri_params}"
    else:
        uri = f"mongodb://{mongo_host}:{mongo_port}/{mongo_db}"

    client = AsyncIOMotorClient(uri)
    db = client[mongo_db]

    # 统计 unified_profiles 中不同的 owner_user_id
    pipeline = [
        {"$group": {"_id": "$owner_user_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}
    ]
    result = await db.unified_profiles.aggregate(pipeline).to_list(length=None)

    print("=== unified_profiles 中的 owner_user_id 统计 ===")
    for r in result:
        print(f"  {r['_id']}: {r['count']} 条 profile")

    # 统计 memcells 中不同的 user_id
    pipeline2 = [
        {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}
    ]
    result2 = await db.memcells.aggregate(pipeline2).to_list(length=None)

    print()
    print("=== memcells 中的 user_id 统计 ===")
    for r in result2:
        print(f"  {r['_id']}: {r['count']} 条 memcell")

    client.close()


if __name__ == "__main__":
    main()