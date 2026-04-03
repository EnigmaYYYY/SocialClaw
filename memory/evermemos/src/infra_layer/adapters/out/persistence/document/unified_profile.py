"""
Unified Profile Document Model

UnifiedProfile 的 MongoDB 文档模型定义。

所有字段统一使用 ProfileField 格式: {value: str, evidences: List[str]}
"""

from datetime import datetime
from typing import List, Optional, Dict, Any
from beanie import Indexed
from core.oxm.mongo.document_base import DocumentBase
from pydantic import Field
from core.oxm.mongo.audit_base import AuditBase


class UnifiedProfileDocument(DocumentBase, AuditBase):
    """
    统一画像文档模型

    存储 Social Copilot 和 EverMemOS 合并后的画像数据。
    所有字段统一使用 ProfileField 格式。
    """

    # ==================== 基础标识 ====================
    profile_id: Indexed(str) = Field(..., description="画像唯一ID")
    profile_type: Indexed(str) = Field(..., description="画像类型: user/contact")
    owner_user_id: Indexed(str) = Field(..., description="所属用户ID")
    target_user_id: Optional[Indexed(str)] = Field(default=None, description="目标用户ID (contact类型)")
    conversation_id: Optional[Indexed(str)] = Field(default=None, description="关联会话ID")

    # ==================== 基础信息 ====================
    display_name: str = Field(default="", description="显示名称")
    aliases: List[str] = Field(default_factory=list, description="别名列表")

    # ==================== 画像字段（全部 ProfileField 格式）====================
    # 单值字段 {value, evidence_level, evidences}
    gender: Optional[Dict[str, Any]] = Field(default=None, description="性别")
    age: Optional[Dict[str, Any]] = Field(default=None, description="年龄")
    education_level: Optional[Dict[str, Any]] = Field(default=None, description="学历")
    intimacy_level: Optional[Dict[str, Any]] = Field(default=None, description="熟悉程度")

    # 列表字段 [{value, evidence_level, evidences}]
    traits: List[Dict[str, Any]] = Field(default_factory=list, description="性格特征（英文枚举）")
    personality: List[Dict[str, Any]] = Field(default_factory=list, description="人格特征（中文描述）")
    occupation: List[Dict[str, Any]] = Field(default_factory=list, description="职业（可多个）")
    relationship: List[Dict[str, Any]] = Field(default_factory=list, description="与owner的关系（可多重）")
    interests: List[Dict[str, Any]] = Field(default_factory=list, description="兴趣爱好")
    way_of_decision_making: List[Dict[str, Any]] = Field(default_factory=list, description="决策方式")
    life_habit_preference: List[Dict[str, Any]] = Field(default_factory=list, description="生活偏好")
    communication_style: List[Dict[str, Any]] = Field(default_factory=list, description="沟通风格")
    catchphrase: List[Dict[str, Any]] = Field(default_factory=list, description="口头禅")
    user_to_friend_catchphrase: List[Dict[str, Any]] = Field(default_factory=list, description="owner对联系人的口头禅")
    user_to_friend_chat_style: List[Dict[str, Any]] = Field(default_factory=list, description="owner对联系人的回复风格")
    motivation_system: List[Dict[str, Any]] = Field(default_factory=list, description="动机系统")
    fear_system: List[Dict[str, Any]] = Field(default_factory=list, description="恐惧系统")
    value_system: List[Dict[str, Any]] = Field(default_factory=list, description="价值系统")
    humor_use: List[Dict[str, Any]] = Field(default_factory=list, description="幽默使用")

    # ==================== 社交属性 ====================
    social_attributes: Dict[str, Any] = Field(
        default_factory=lambda: {
            "role": "unknown",
            "age_group": None,
            "intimacy_level": "stranger",
            "current_status": "unknown",
            "intermediary": {
                "has_intermediary": False,
                "name": None,
                "context": None
            }
        },
        description="社交属性"
    )

    # ==================== 风险评估 ====================
    risk_assessment: Optional[Dict[str, Any]] = Field(
        default=None,
        description="风险评估"
    )

    # ==================== 元数据 ====================
    metadata: Dict[str, Any] = Field(
        default_factory=lambda: {
            "version": 1,
            "created_at": "",
            "last_updated": "",
            "source_memcell_count": 0,
            "last_cluster_id": None,
            "update_count": 0
        },
        description="元数据"
    )

    # ==================== 检索信息 ====================
    retrieval: Optional[Dict[str, Any]] = Field(
        default=None,
        description="向量检索信息"
    )

    # ==================== 扩展字段 ====================
    extend: Dict[str, Any] = Field(
        default_factory=dict,
        description="扩展字段"
    )

    class Settings:
        name = "unified_profiles"
        indexes = [
            [("profile_id", 1)],                    # 唯一索引
            [("owner_user_id", 1), ("profile_type", 1)],  # 组合索引
            [("owner_user_id", 1), ("target_user_id", 1)],  # 组合索引
            [("conversation_id", 1)],               # 会话索引
        ]