"""
Unified Types for Social Copilot ↔ EverMemOS Integration

统一数据类型定义，用于 Social Copilot 和 EverMemOS 之间的数据交换。

设计原则：
- ID：系统生成，不依赖微信底层ID
- 存储：统一存入数据库（MongoDB + ES + Milvus）
- 格式：合并两边画像优点（证据+社交属性）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
import uuid
import hashlib

from common_utils.datetime_utils import get_now_with_timezone


# ============================================================================
# ID 生成工具
# ============================================================================

def generate_profile_id() -> str:
    """生成画像唯一ID"""
    return f"profile_{uuid.uuid4().hex[:16]}"


def generate_owner_user_id() -> str:
    """生成用户ID"""
    return f"user_{uuid.uuid4().hex[:12]}"


def generate_target_user_id(session_key: str, owner_user_id: str) -> str:
    """
    基于 session_key 生成稳定的联系人ID

    Args:
        session_key: 会话标识（如 "微信::张三"）
        owner_user_id: 所有者用户ID

    Returns:
        稳定的联系人ID
    """
    raw = f"{owner_user_id}:{session_key}"
    return f"contact_{hashlib.sha256(raw.encode()).hexdigest()[:12]}"


def generate_conversation_id(session_key: str) -> str:
    """
    基于 session_key 生成稳定的会话ID

    Args:
        session_key: 会话标识（如 "微信::张三"）

    Returns:
        稳定的会话ID
    """
    return f"conv_{hashlib.sha256(session_key.encode()).hexdigest()[:12]}"


def generate_message_id() -> str:
    """生成消息唯一ID"""
    return f"msg_{uuid.uuid4().hex[:16]}"


# ============================================================================
# 枚举类型
# ============================================================================

class ProfileType(str, Enum):
    """画像类型"""
    USER = "user"           # 用户自画像
    CONTACT = "contact"     # 联系人画像


class IntimacyLevel(str, Enum):
    """亲密度等级"""
    STRANGER = "stranger"
    FORMAL = "formal"
    CLOSE = "close"
    INTIMATE = "intimate"


def normalize_intimacy_level(value: Any) -> IntimacyLevel:
    """Normalize legacy or noisy intimacy values into the supported enum."""
    if isinstance(value, IntimacyLevel):
        return value

    normalized = str(value or "").strip().lower()
    aliases = {
        "": IntimacyLevel.STRANGER,
        "unknown": IntimacyLevel.STRANGER,
        "stranger": IntimacyLevel.STRANGER,
        "formal": IntimacyLevel.FORMAL,
        "familiar": IntimacyLevel.CLOSE,
        "close": IntimacyLevel.CLOSE,
        "friend": IntimacyLevel.CLOSE,
        "very_close": IntimacyLevel.INTIMATE,
        "intimate": IntimacyLevel.INTIMATE,
    }
    return aliases.get(normalized, IntimacyLevel.STRANGER)


class RiskLevel(str, Enum):
    """风险等级"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class MessageLength(str, Enum):
    """消息长度"""
    SHORT = "short"
    MEDIUM = "medium"
    LONG = "long"


class FactCategory(str, Enum):
    """事实分类"""
    TRAIT = "trait"
    INTEREST = "interest"
    ROLE = "role"
    STYLE = "style"
    OCCUPATION = "occupation"
    OTHER = "other"


class SenderType(str, Enum):
    """发送者类型"""
    USER = "user"
    CONTACT = "contact"
    UNKNOWN = "unknown"


# ============================================================================
# 统一消息格式
# ============================================================================

@dataclass
class UnifiedEvidence:
    """证据结构"""
    source: str                 # 来源：消息内容片段
    timestamp: str              # 发现时间
    message_id: Optional[str] = None  # 关联消息ID

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "timestamp": self.timestamp,
            "message_id": self.message_id
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'UnifiedEvidence':
        return cls(
            source=data.get("source", ""),
            timestamp=data.get("timestamp", ""),
            message_id=data.get("message_id")
        )


@dataclass
class UnifiedFact:
    """事实结构"""
    fact: str                               # 事实内容
    category: FactCategory                  # 分类
    evidence: List[UnifiedEvidence] = field(default_factory=list)
    confidence: float = 0.0                 # 置信度 0-1
    last_updated: str = ""                  # 最后更新时间

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fact": self.fact,
            "category": self.category.value,
            "evidence": [e.to_dict() for e in self.evidence],
            "confidence": self.confidence,
            "last_updated": self.last_updated
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'UnifiedFact':
        return cls(
            fact=data.get("fact", ""),
            category=FactCategory(data.get("category", "other")),
            evidence=[UnifiedEvidence.from_dict(e) for e in data.get("evidence", [])],
            confidence=data.get("confidence", 0.0),
            last_updated=data.get("last_updated", "")
        )


@dataclass
class UnifiedMessage:
    """
    统一消息格式

    用于 Social Copilot 和 EverMemOS 之间的消息交换。
    """
    # 必填字段
    message_id: str                      # 消息唯一ID
    conversation_id: str                 # 会话ID
    sender_id: str                       # 发送者ID
    sender_name: str                     # 发送者昵称
    sender_type: SenderType              # 发送者类型
    content: str                         # 消息内容
    timestamp: str                       # ISO 8601 格式时间

    # 可选字段
    content_type: str = "text"           # 消息类型
    reply_to: Optional[str] = None       # 回复的消息ID
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "message_id": self.message_id,
            "conversation_id": self.conversation_id,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "sender_type": self.sender_type.value,
            "content": self.content,
            "timestamp": self.timestamp,
            "content_type": self.content_type,
            "reply_to": self.reply_to,
            "metadata": self.metadata
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'UnifiedMessage':
        return cls(
            message_id=data.get("message_id", ""),
            conversation_id=data.get("conversation_id", ""),
            sender_id=data.get("sender_id", ""),
            sender_name=data.get("sender_name", ""),
            sender_type=SenderType(data.get("sender_type", "unknown")),
            content=data.get("content", ""),
            timestamp=data.get("timestamp", ""),
            content_type=data.get("content_type", "text"),
            reply_to=data.get("reply_to"),
            metadata=data.get("metadata", {})
        )


# ============================================================================
# 社交属性（来自 Social Copilot）
# ============================================================================

@dataclass
class IntermediaryInfo:
    """中间人信息"""
    has_intermediary: bool = False
    name: Optional[str] = None
    context: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "has_intermediary": self.has_intermediary,
            "name": self.name,
            "context": self.context
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'IntermediaryInfo':
        return cls(
            has_intermediary=data.get("has_intermediary", False),
            name=data.get("name"),
            context=data.get("context")
        )


@dataclass
class SocialAttributes:
    """
    社交属性

    来自 Social Copilot，描述社交关系和角色。
    """
    role: str = "unknown"                    # 角色: "colleague", "friend", "client"
    age_group: Optional[str] = None          # 年龄段: "20s", "30s"
    intimacy_level: IntimacyLevel = IntimacyLevel.STRANGER
    current_status: str = "unknown"          # 关系状态
    intermediary: IntermediaryInfo = field(default_factory=IntermediaryInfo)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "role": self.role,
            "age_group": self.age_group,
            "intimacy_level": self.intimacy_level.value,
            "current_status": self.current_status,
            "intermediary": self.intermediary.to_dict()
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'SocialAttributes':
        return cls(
            role=data.get("role", "unknown"),
            age_group=data.get("age_group"),
            intimacy_level=normalize_intimacy_level(data.get("intimacy_level", "stranger")),
            current_status=data.get("current_status", "unknown"),
            intermediary=IntermediaryInfo.from_dict(data.get("intermediary", {}))
        )


# ============================================================================
# 通信风格（来自 Social Copilot）
# ============================================================================

@dataclass
class CommunicationStyle:
    """
    通信风格

    来自 Social Copilot，用于模仿用户说话方式。
    """
    frequent_phrases: List[str] = field(default_factory=list)  # 口头禅
    emoji_usage: List[str] = field(default_factory=list)       # 常用emoji
    punctuation_style: str = ""                                 # 标点习惯
    avg_message_length: MessageLength = MessageLength.SHORT
    tone_style: str = "friendly"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "frequent_phrases": self.frequent_phrases,
            "emoji_usage": self.emoji_usage,
            "punctuation_style": self.punctuation_style,
            "avg_message_length": self.avg_message_length.value,
            "tone_style": self.tone_style
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'CommunicationStyle':
        return cls(
            frequent_phrases=data.get("frequent_phrases", []),
            emoji_usage=data.get("emoji_usage", []),
            punctuation_style=data.get("punctuation_style", ""),
            avg_message_length=MessageLength(data.get("avg_message_length", "short")),
            tone_style=data.get("tone_style", "friendly")
        )


# ============================================================================
# 风险评估（来自 Social Copilot）
# ============================================================================

@dataclass
class RiskAssessment:
    """
    风险评估

    来自 Social Copilot，用于诈骗检测。
    """
    is_suspicious: bool = False
    risk_level: RiskLevel = RiskLevel.LOW
    warning_msg: str = ""
    risk_patterns: List[str] = field(default_factory=list)
    last_checked: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_suspicious": self.is_suspicious,
            "risk_level": self.risk_level.value,
            "warning_msg": self.warning_msg,
            "risk_patterns": self.risk_patterns,
            "last_checked": self.last_checked
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'RiskAssessment':
        return cls(
            is_suspicious=data.get("is_suspicious", False),
            risk_level=RiskLevel(data.get("risk_level", "low")),
            warning_msg=data.get("warning_msg", ""),
            risk_patterns=data.get("risk_patterns", []),
            last_checked=data.get("last_checked")
        )


# ============================================================================
# 画像字段（统一格式：值 + 证据）
# ============================================================================

def _normalize_evidences(evidences: Any) -> List[Any]:
    """
    归一化 evidence 列表，统一为 [{"event_id": "...", "reasoning": "..."}] 格式。
    兼容旧格式 List[str] 和混合格式。
    """
    if not evidences:
        return []
    if not isinstance(evidences, list):
        evidences = [evidences]
    normalized = []
    for ev in evidences:
        if isinstance(ev, dict) and "event_id" in ev:
            # 新格式，直接保留
            normalized.append(ev)
        elif isinstance(ev, str) and ev.strip():
            # 旧格式字符串，转为 dict
            normalized.append({"event_id": ev.strip(), "reasoning": ""})
        # 忽略 None、空字符串、无效类型
    return normalized


@dataclass
class ProfileField:
    """
    画像字段统一格式

    LLM 直接返回此格式，无需转换：
    {"value": "字段值", "evidence_level": "L1", "evidences": [{"event_id": "...", "reasoning": "..."}]}
    兼容旧格式：evidences 也可能是 ["conversation_id"] 字符串列表
    """
    value: str
    evidence_level: str = "L2"  # L1 显式 / L2 强隐含 / L3 弱推断（禁止提取）
    evidences: List[Any] = field(default_factory=list)  # List[Dict[str,str]] or List[str] for legacy

    def to_dict(self) -> Dict[str, Any]:
        return {
            "value": self.value,
            "evidence_level": self.evidence_level,
            "evidences": self.evidences
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ProfileField':
        if isinstance(data, str):
            # 兼容旧格式：纯字符串
            return cls(value=data, evidences=[])
        return cls(
            value=data.get("value", ""),
            evidence_level=data.get("evidence_level", "L2"),
            evidences=_normalize_evidences(data.get("evidences", []))
        )

    @classmethod
    def from_llm_output(cls, data: Any) -> Optional['ProfileField']:
        """从 LLM 输出创建，支持多种格式，自动归一化 evidence 格式"""
        if data is None:
            return None
        if isinstance(data, str):
            return cls(value=data.strip()) if data.strip() else None
        if isinstance(data, dict):
            value = data.get("value", "") or data.get("trait", "") or data.get("interest", "")
            if not value:
                return None
            evidences = data.get("evidences", []) or data.get("evidence", [])
            if isinstance(evidences, str):
                evidences = [evidences]
            evidences = _normalize_evidences(evidences)
            evidence_level = data.get("evidence_level", "L2")
            return cls(value=str(value).strip(), evidence_level=evidence_level, evidences=evidences)
        return None


def parse_profile_fields(data: Any) -> List[ProfileField]:
    """解析 LLM 返回的字段列表，兼容旧格式"""
    if not data:
        return []

    # 新格式：List[ProfileField]
    if isinstance(data, list):
        result = []
        for item in data:
            field = ProfileField.from_llm_output(item)
            if field:
                result.append(field)
        return result

    # 新格式：单个 ProfileField dict
    if isinstance(data, dict):
        # 检查是否是 ProfileField 格式
        if "value" in data:
            field = ProfileField.from_llm_output(data)
            return [field] if field else []

        # 旧格式：嵌套对象如 communication_style = {tone_style: "friendly", frequent_phrases: []}
        # 提取有效值转换为 ProfileField
        result = []
        for key, val in data.items():
            if key in ("frequent_phrases", "emoji_usage") and isinstance(val, list):
                # 从列表中提取每个值
                for v in val:
                    if isinstance(v, str) and v.strip():
                        result.append(ProfileField(value=v.strip(), evidences=[]))
            elif isinstance(val, str) and val.strip() and val not in ("unknown", "short", "medium", "long"):
                # tone_style, punctuation_style 等字符串值
                result.append(ProfileField(value=val.strip(), evidences=[]))
        return result

    # 单个字符串
    if isinstance(data, str):
        field = ProfileField.from_llm_output(data)
        return [field] if field else []

    return []


# ============================================================================
# 元数据（来自 EverMemOS）
# ============================================================================

@dataclass
class ProfileMetadata:
    """
    画像元数据

    来自 EverMemOS，用于版本管理和追踪。
    """
    version: int = 1
    created_at: str = ""
    last_updated: str = ""
    source_memcell_count: int = 0
    last_cluster_id: Optional[str] = None
    update_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "created_at": self.created_at,
            "last_updated": self.last_updated,
            "source_memcell_count": self.source_memcell_count,
            "last_cluster_id": self.last_cluster_id,
            "update_count": self.update_count
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ProfileMetadata':
        return cls(
            version=data.get("version", 1),
            created_at=data.get("created_at", ""),
            last_updated=data.get("last_updated", ""),
            source_memcell_count=data.get("source_memcell_count", 0),
            last_cluster_id=data.get("last_cluster_id"),
            update_count=data.get("update_count", 0)
        )


# ============================================================================
# 检索信息（来自 EverMemOS）
# ============================================================================

@dataclass
class RetrievalInfo:
    """
    检索信息

    来自 EverMemOS，用于向量检索。
    """
    vector: Optional[List[float]] = None
    vector_model: Optional[str] = None
    keywords: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "vector": self.vector,
            "vector_model": self.vector_model,
            "keywords": self.keywords
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'RetrievalInfo':
        return cls(
            vector=data.get("vector"),
            vector_model=data.get("vector_model"),
            keywords=data.get("keywords", [])
        )


# ============================================================================
# 统一画像格式
# ============================================================================

@dataclass
class UnifiedProfile:
    """
    统一画像格式

    LLM 返回格式与存储格式一致，无需转换：
    - 所有字段都是 ProfileField 或 List[ProfileField]
    - 每个字段自带证据

    存储位置：MongoDB（主）+ ES（检索）+ Milvus（向量）
    """

    # ==================== 基础标识 ====================
    profile_id: str                              # 系统生成的唯一ID
    profile_type: ProfileType                    # 画像类型
    owner_user_id: str                           # 所属用户
    target_user_id: Optional[str] = None         # 目标用户（contact类型）
    conversation_id: Optional[str] = None        # 关联的会话ID

    # ==================== 基础信息 ====================
    display_name: str = ""                       # 显示名称
    aliases: List[str] = field(default_factory=list)

    # ==================== 画像字段（全部带证据）====================
    # 单值字段
    gender: Optional[ProfileField] = None          # 性别
    age: Optional[ProfileField] = None             # 年龄
    education_level: Optional[ProfileField] = None # 学历
    intimacy_level: Optional[ProfileField] = None  # 熟悉程度

    # 列表字段
    traits: List[ProfileField] = field(default_factory=list)           # 性格特征
    personality: List[ProfileField] = field(default_factory=list)      # 人格特征（中文描述）
    occupation: List[ProfileField] = field(default_factory=list)       # 职业（可多个）
    relationship: List[ProfileField] = field(default_factory=list)     # 与 owner 的关系（可多重）
    interests: List[ProfileField] = field(default_factory=list)        # 兴趣爱好
    way_of_decision_making: List[ProfileField] = field(default_factory=list)  # 决策方式
    life_habit_preference: List[ProfileField] = field(default_factory=list)   # 生活偏好
    communication_style: List[ProfileField] = field(default_factory=list)     # 沟通风格
    catchphrase: List[ProfileField] = field(default_factory=list)             # 口头禅
    user_to_friend_catchphrase: List[ProfileField] = field(default_factory=list)  # owner 对联系人的口头禅
    user_to_friend_chat_style: List[ProfileField] = field(default_factory=list)   # owner 对联系人的回复风格
    motivation_system: List[ProfileField] = field(default_factory=list)       # 动机系统
    fear_system: List[ProfileField] = field(default_factory=list)             # 恐惧系统
    value_system: List[ProfileField] = field(default_factory=list)            # 价值系统
    humor_use: List[ProfileField] = field(default_factory=list)               # 幽默使用

    # ==================== 社交属性 ====================
    social_attributes: SocialAttributes = field(default_factory=SocialAttributes)

    # ==================== 风险评估 ====================
    risk_assessment: Optional[RiskAssessment] = None

    # ==================== 元数据 ====================
    metadata: ProfileMetadata = field(default_factory=ProfileMetadata)

    # ==================== 向量检索 ====================
    retrieval: Optional[RetrievalInfo] = None

    # ==================== 扩展字段 ====================
    extend: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        def field_to_dict(f: Optional[ProfileField]) -> Optional[Dict[str, Any]]:
            return f.to_dict() if f else None

        def fields_to_dict(fields: List[ProfileField]) -> List[Dict[str, Any]]:
            return [f.to_dict() for f in fields]

        result = {
            "profile_id": self.profile_id,
            "profile_type": self.profile_type.value,
            "owner_user_id": self.owner_user_id,
            "target_user_id": self.target_user_id,
            "conversation_id": self.conversation_id,
            "display_name": self.display_name,
            "aliases": self.aliases,
            "gender": field_to_dict(self.gender),
            "age": field_to_dict(self.age),
            "education_level": field_to_dict(self.education_level),
            "intimacy_level": field_to_dict(self.intimacy_level),
            "traits": fields_to_dict(self.traits),
            "personality": fields_to_dict(self.personality),
            "occupation": fields_to_dict(self.occupation),
            "relationship": fields_to_dict(self.relationship),
            "interests": fields_to_dict(self.interests),
            "way_of_decision_making": fields_to_dict(self.way_of_decision_making),
            "life_habit_preference": fields_to_dict(self.life_habit_preference),
            "communication_style": fields_to_dict(self.communication_style),
            "catchphrase": fields_to_dict(self.catchphrase),
            "user_to_friend_catchphrase": fields_to_dict(self.user_to_friend_catchphrase),
            "user_to_friend_chat_style": fields_to_dict(self.user_to_friend_chat_style),
            "motivation_system": fields_to_dict(self.motivation_system),
            "fear_system": fields_to_dict(self.fear_system),
            "value_system": fields_to_dict(self.value_system),
            "humor_use": fields_to_dict(self.humor_use),
            "social_attributes": self.social_attributes.to_dict(),
            "metadata": self.metadata.to_dict(),
            "extend": self.extend
        }

        if self.risk_assessment:
            result["risk_assessment"] = self.risk_assessment.to_dict()

        if self.retrieval:
            result["retrieval"] = self.retrieval.to_dict()

        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'UnifiedProfile':
        """从字典创建，支持新旧格式兼容"""
        def parse_field(d: Any) -> Optional[ProfileField]:
            if d is None:
                return None
            return ProfileField.from_llm_output(d)

        def parse_fields(d: Any) -> List[ProfileField]:
            return parse_profile_fields(d)

        # 兼容旧格式：traits/interests/occupation/relationship 可能是 List[str] 或单值
        old_traits = data.get("traits", [])
        old_interests = data.get("interests", [])
        old_occupation = data.get("occupation")
        old_relationship = data.get("relationship")

        # 如果旧格式是 List[str]，转换为新格式
        if old_traits and isinstance(old_traits[0], str):
            old_traits = [{"value": t, "evidences": []} for t in old_traits]
        if old_interests and isinstance(old_interests[0], str):
            old_interests = [{"value": i, "evidences": []} for i in old_interests]

        # occupation 和 relationship 现在是列表字段，兼容旧的单值格式
        if old_occupation:
            if isinstance(old_occupation, str):
                old_occupation = [{"value": old_occupation, "evidences": []}]
            elif isinstance(old_occupation, dict):
                old_occupation = [old_occupation]
        if old_relationship:
            if isinstance(old_relationship, str):
                old_relationship = [{"value": old_relationship, "evidences": []}]
            elif isinstance(old_relationship, dict):
                old_relationship = [old_relationship]

        risk_assessment = None
        if data.get("risk_assessment"):
            risk_assessment = RiskAssessment.from_dict(data["risk_assessment"])

        retrieval = None
        if data.get("retrieval"):
            retrieval = RetrievalInfo.from_dict(data["retrieval"])

        return cls(
            profile_id=data.get("profile_id", ""),
            profile_type=ProfileType(data.get("profile_type", "user")),
            owner_user_id=data.get("owner_user_id", ""),
            target_user_id=data.get("target_user_id"),
            conversation_id=data.get("conversation_id"),
            display_name=data.get("display_name", ""),
            aliases=data.get("aliases", []),
            gender=parse_field(data.get("gender")),
            age=parse_field(data.get("age")),
            education_level=parse_field(data.get("education_level")),
            intimacy_level=parse_field(data.get("intimacy_level")),
            traits=parse_fields(old_traits),
            personality=parse_fields(data.get("personality")),
            occupation=parse_fields(old_occupation),
            relationship=parse_fields(old_relationship),
            interests=parse_fields(old_interests),
            way_of_decision_making=parse_fields(data.get("way_of_decision_making")),
            life_habit_preference=parse_fields(data.get("life_habit_preference")),
            communication_style=parse_fields(data.get("communication_style")),
            catchphrase=parse_fields(data.get("catchphrase")),
            user_to_friend_catchphrase=parse_fields(data.get("user_to_friend_catchphrase")),
            user_to_friend_chat_style=parse_fields(data.get("user_to_friend_chat_style")),
            motivation_system=parse_fields(data.get("motivation_system")),
            fear_system=parse_fields(data.get("fear_system")),
            value_system=parse_fields(data.get("value_system")),
            humor_use=parse_fields(data.get("humor_use")),
            social_attributes=SocialAttributes.from_dict(data.get("social_attributes", {})),
            risk_assessment=risk_assessment,
            metadata=ProfileMetadata.from_dict(data.get("metadata", {})),
            retrieval=retrieval,
            extend=data.get("extend", {})
        )

    @classmethod
    def create_user_profile(
        cls,
        owner_user_id: str,
        display_name: str = "我"
    ) -> 'UnifiedProfile':
        """创建用户自画像"""
        now = get_now_with_timezone().isoformat()
        return cls(
            profile_id=generate_profile_id(),
            profile_type=ProfileType.USER,
            owner_user_id=owner_user_id,
            display_name=display_name,
            aliases=[display_name] if display_name else [],
            metadata=ProfileMetadata(
                version=1,
                created_at=now,
                last_updated=now,
                update_count=0
            )
        )

    @classmethod
    def create_contact_profile(
        cls,
        owner_user_id: str,
        session_key: str,
        display_name: str,
        target_user_id: Optional[str] = None,
    ) -> 'UnifiedProfile':
        """创建联系人画像"""
        now = get_now_with_timezone().isoformat()
        target_user_id = target_user_id or generate_target_user_id(session_key, owner_user_id)
        conversation_id = generate_conversation_id(session_key)

        return cls(
            profile_id=generate_profile_id(),
            profile_type=ProfileType.CONTACT,
            owner_user_id=owner_user_id,
            target_user_id=target_user_id,
            conversation_id=conversation_id,
            display_name=display_name,
            aliases=[display_name] if display_name else [],
            metadata=ProfileMetadata(
                version=1,
                created_at=now,
                last_updated=now,
                update_count=0
            )
        )


# ============================================================================
# API 请求/响应类型
# ============================================================================

@dataclass
class ReplySuggestionRequest:
    """回复建议请求"""
    conversation_id: str
    owner_user_id: str
    target_user_id: Optional[str] = None
    incoming_message: Optional[UnifiedMessage] = None
    manual_intent: Optional[str] = None    # 手动意图
    history_window: int = 20

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "conversation_id": self.conversation_id,
            "owner_user_id": self.owner_user_id,
            "target_user_id": self.target_user_id,
            "manual_intent": self.manual_intent,
            "history_window": self.history_window
        }
        if self.incoming_message:
            result["incoming_message"] = self.incoming_message.to_dict()
        return result


@dataclass
class ReplySuggestionResponse:
    """回复建议响应"""
    should_reply: bool
    reply_text: Optional[str] = None
    alternatives: List[Dict[str, str]] = field(default_factory=list)
    planner_decision: Optional[Dict[str, Any]] = None
    evidence: Optional[Dict[str, Any]] = None
    risk_check: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "should_reply": self.should_reply,
            "reply_text": self.reply_text,
            "alternatives": self.alternatives,
            "planner_decision": self.planner_decision,
            "evidence": self.evidence,
            "risk_check": self.risk_check
        }
        return result


@dataclass
class MemorizeRequest:
    """记忆写入请求"""
    conversation_id: str
    owner_user_id: str
    messages: List[UnifiedMessage]
    options: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "owner_user_id": self.owner_user_id,
            "messages": [m.to_dict() for m in self.messages],
            "options": self.options
        }
