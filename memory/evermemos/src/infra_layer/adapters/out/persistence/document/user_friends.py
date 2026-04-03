"""
User Friends Document Model

用户好友关系表的 MongoDB 文档模型定义。
"""

from datetime import datetime
from typing import List, Optional, Dict, Any
from beanie import Indexed
from core.oxm.mongo.document_base import DocumentBase
from pydantic import Field
from core.oxm.mongo.audit_base import AuditBase


class UserFriendsDocument(DocumentBase, AuditBase):
    """
    用户好友关系文档模型

    存储用户及其好友列表的映射关系。
    """

    # ==================== 基础标识 ====================
    owner_user_id: Indexed(str) = Field(..., description="用户ID（好友列表所属者）")

    # ==================== 好友列表 ====================
    friend_ids: List[str] = Field(default_factory=list, description="好友ID列表")

    # ==================== 扩展信息 ====================
    # 好友ID -> 显示名称的映射
    friend_names: Dict[str, str] = Field(default_factory=dict, description="好友ID -> 显示名称")

    # 统计信息
    total_friends: int = Field(default=0, description="好友总数")

    # 元数据
    metadata: Dict[str, Any] = Field(
        default_factory=lambda: {
            "version": 1,
            "created_at": "",
            "last_updated": "",
            "source": "unknown",  # 来源: conversation, manual, imported
        },
        description="元数据"
    )

    class Settings:
        name = "user_friends"
        indexes = [
            [("owner_user_id", 1)],  # 唯一索引
        ]