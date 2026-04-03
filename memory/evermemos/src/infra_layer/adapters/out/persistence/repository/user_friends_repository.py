"""
User Friends Repository

用户好友关系的存储访问层。
"""

from typing import Dict, Any, List, Optional
from datetime import datetime
from core.observation.logger import get_logger
from core.di.decorators import repository
from core.oxm.mongo.base_repository import BaseRepository

from infra_layer.adapters.out.persistence.document.user_friends import UserFriendsDocument

logger = get_logger(__name__)


@repository("user_friends_repository", primary=True)
class UserFriendsRepository(BaseRepository[UserFriendsDocument]):
    """
    UserFriends 存储访问层

    提供用户好友列表的 CRUD 操作。
    """

    def __init__(self):
        super().__init__(UserFriendsDocument)

    # ==================== 核心查询方法 ====================

    async def get_by_owner(self, owner_user_id: str) -> Optional[UserFriendsDocument]:
        """根据 owner_user_id 获取好友列表"""
        try:
            doc = await self.model.find_one({"owner_user_id": owner_user_id})
            return doc
        except Exception as e:
            logger.error(f"Failed to get friends for owner: {owner_user_id}, error: {e}")
            return None

    async def get_friend_ids(self, owner_user_id: str) -> List[str]:
        """获取用户的好友ID列表"""
        doc = await self.get_by_owner(owner_user_id)
        return doc.friend_ids if doc else []

    async def get_friend_names(self, owner_user_id: str) -> Dict[str, str]:
        """获取用户的好友ID -> 名称映射"""
        doc = await self.get_by_owner(owner_user_id)
        return doc.friend_names if doc else {}

    async def is_friend(self, owner_user_id: str, friend_id: str) -> bool:
        """检查是否是好友"""
        doc = await self.get_by_owner(owner_user_id)
        if not doc:
            return False
        return friend_id in doc.friend_ids

    # ==================== 保存方法 ====================

    async def upsert_friends(
        self,
        owner_user_id: str,
        friend_ids: List[str],
        friend_names: Optional[Dict[str, str]] = None,
        source: str = "unknown"
    ) -> Optional[UserFriendsDocument]:
        """创建或更新好友列表"""
        try:
            existing = await self.get_by_owner(owner_user_id)
            now = datetime.now().isoformat()

            if existing:
                existing.friend_ids = friend_ids
                if friend_names:
                    existing.friend_names = friend_names
                existing.total_friends = len(friend_ids)
                existing.metadata["last_updated"] = now
                existing.metadata["version"] = existing.metadata.get("version", 1) + 1
                await existing.save()
                logger.info(f"Updated friends for owner: {owner_user_id}, count: {len(friend_ids)}")
                return existing
            else:
                doc = UserFriendsDocument(
                    owner_user_id=owner_user_id,
                    friend_ids=friend_ids,
                    friend_names=friend_names or {},
                    total_friends=len(friend_ids),
                    metadata={
                        "version": 1,
                        "created_at": now,
                        "last_updated": now,
                        "source": source,
                    }
                )
                await doc.insert()
                logger.info(f"Created friends for owner: {owner_user_id}, count: {len(friend_ids)}")
                return doc

        except Exception as e:
            logger.error(f"Failed to upsert friends for owner: {owner_user_id}, error: {e}")
            return None

    async def add_friend(
        self,
        owner_user_id: str,
        friend_id: str,
        friend_name: Optional[str] = None
    ) -> bool:
        """添加单个好友"""
        try:
            existing = await self.get_by_owner(owner_user_id)
            now = datetime.now().isoformat()

            if existing:
                if friend_id in existing.friend_ids:
                    # 已存在，可能更新名称
                    if friend_name and friend_name != existing.friend_names.get(friend_id):
                        existing.friend_names[friend_id] = friend_name
                        await existing.save()
                    return True

                existing.friend_ids.append(friend_id)
                if friend_name:
                    existing.friend_names[friend_id] = friend_name
                existing.total_friends = len(existing.friend_ids)
                existing.metadata["last_updated"] = now
                existing.metadata["version"] = existing.metadata.get("version", 1) + 1
                await existing.save()
                logger.info(f"Added friend: {friend_id} for owner: {owner_user_id}")
                return True
            else:
                # 创建新的好友列表
                doc = UserFriendsDocument(
                    owner_user_id=owner_user_id,
                    friend_ids=[friend_id],
                    friend_names={friend_id: friend_name} if friend_name else {},
                    total_friends=1,
                    metadata={
                        "version": 1,
                        "created_at": now,
                        "last_updated": now,
                        "source": "manual",
                    }
                )
                await doc.insert()
                logger.info(f"Created friends with first friend: {friend_id} for owner: {owner_user_id}")
                return True

        except Exception as e:
            logger.error(f"Failed to add friend: {friend_id} for owner: {owner_user_id}, error: {e}")
            return False

    async def remove_friend(
        self,
        owner_user_id: str,
        friend_id: str
    ) -> bool:
        """移除单个好友"""
        try:
            existing = await self.get_by_owner(owner_user_id)
            if not existing:
                return False

            if friend_id not in existing.friend_ids:
                return False

            existing.friend_ids.remove(friend_id)
            existing.friend_names.pop(friend_id, None)
            existing.total_friends = len(existing.friend_ids)
            existing.metadata["last_updated"] = datetime.now().isoformat()
            existing.metadata["version"] = existing.metadata.get("version", 1) + 1
            await existing.save()
            logger.info(f"Removed friend: {friend_id} for owner: {owner_user_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to remove friend: {friend_id} for owner: {owner_user_id}, error: {e}")
            return False

    # ==================== 删除方法 ====================

    async def delete_by_owner(self, owner_user_id: str) -> bool:
        """删除用户的好友列表"""
        try:
            result = await self.model.find(
                UserFriendsDocument.owner_user_id == owner_user_id
            ).delete()
            return result.deleted_count > 0
        except Exception as e:
            logger.error(f"Failed to delete friends for owner: {owner_user_id}, error: {e}")
            return False


# 用于 DI 的别名
user_friends_repository = UserFriendsRepository