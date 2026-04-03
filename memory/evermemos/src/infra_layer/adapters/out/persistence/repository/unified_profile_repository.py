"""
Unified Profile Repository

统一画像的存储访问层。
"""

from typing import Dict, Any, List, Optional
from core.observation.logger import get_logger
from core.di.decorators import repository
from core.oxm.mongo.base_repository import BaseRepository

from infra_layer.adapters.out.persistence.document.unified_profile import UnifiedProfileDocument
from api_specs.unified_types import UnifiedProfile, ProfileType

logger = get_logger(__name__)


@repository("unified_profile_repository", primary=True)
class UnifiedProfileRepository(BaseRepository[UnifiedProfileDocument]):
    """
    UnifiedProfile 存储访问层

    提供统一画像的 CRUD 操作。
    所有字段统一使用 ProfileField 格式: {value: str, evidences: List[str]}
    """

    def __init__(self):
        super().__init__(UnifiedProfileDocument)

    # ==================== 核心查询方法 ====================

    async def get_by_profile_id(self, profile_id: str) -> Optional[UnifiedProfile]:
        """根据 profile_id 获取画像"""
        try:
            doc = await self.model.find_one({"profile_id": profile_id})
            if doc:
                return self._document_to_profile(doc)
            return None
        except Exception as e:
            logger.error(f"Failed to get profile by profile_id: {profile_id}, error: {e}")
            return None

    async def get_by_owner_and_target(
        self,
        owner_user_id: str,
        target_user_id: str
    ) -> Optional[UnifiedProfile]:
        """根据 owner_user_id 和 target_user_id 获取联系人画像"""
        try:
            doc = await self.model.find_one({
                "owner_user_id": owner_user_id,
                "target_user_id": target_user_id,
            })
            if doc:
                return self._document_to_profile(doc)
            return None
        except Exception as e:
            logger.error(f"Failed to get profile: owner={owner_user_id}, target={target_user_id}, error: {e}")
            return None

    async def get_user_profile(self, owner_user_id: str) -> Optional[UnifiedProfile]:
        """获取用户自画像"""
        try:
            doc = await self.model.find_one({
                "owner_user_id": owner_user_id,
                "profile_type": ProfileType.USER.value
            })
            if doc:
                return self._document_to_profile(doc)
            return None
        except Exception as e:
            logger.error(f"Failed to get user profile: owner={owner_user_id}, error: {e}")
            return None

    async def list_contact_profiles(
        self,
        owner_user_id: str,
        limit: int = 50
    ) -> List[UnifiedProfile]:
        """获取用户的所有联系人画像"""
        try:
            docs = await self.model.find({
                "owner_user_id": owner_user_id,
                "profile_type": ProfileType.CONTACT.value
            }).limit(limit).to_list()

            return [self._document_to_profile(doc) for doc in docs]
        except Exception as e:
            logger.error(f"Failed to list contact profiles: owner={owner_user_id}, error: {e}")
            return []

    async def list_by_conversation(
        self,
        conversation_id: str,
        limit: int = 10
    ) -> List[UnifiedProfile]:
        """根据会话ID获取画像列表"""
        try:
            docs = await self.model.find(
                UnifiedProfileDocument.conversation_id == conversation_id
            ).limit(limit).to_list()

            return [self._document_to_profile(doc) for doc in docs]
        except Exception as e:
            logger.error(f"Failed to list profiles by conversation: {conversation_id}, error: {e}")
            return []

    # ==================== 保存方法 ====================

    async def save_profile(self, profile: UnifiedProfile) -> bool:
        """保存画像（新建或更新）"""
        try:
            doc = self._profile_to_document(profile)
            existing = await self.model.find_one({"profile_id": profile.profile_id})

            if existing:
                # 更新所有字段
                existing.display_name = doc.display_name
                existing.aliases = doc.aliases
                existing.gender = doc.gender
                existing.age = doc.age
                existing.education_level = doc.education_level
                existing.intimacy_level = doc.intimacy_level
                existing.traits = doc.traits
                existing.personality = doc.personality
                existing.interests = doc.interests
                existing.occupation = doc.occupation
                existing.relationship = doc.relationship
                existing.way_of_decision_making = doc.way_of_decision_making
                existing.life_habit_preference = doc.life_habit_preference
                existing.communication_style = doc.communication_style
                existing.catchphrase = doc.catchphrase
                existing.user_to_friend_catchphrase = doc.user_to_friend_catchphrase
                existing.user_to_friend_chat_style = doc.user_to_friend_chat_style
                existing.motivation_system = doc.motivation_system
                existing.fear_system = doc.fear_system
                existing.value_system = doc.value_system
                existing.humor_use = doc.humor_use
                existing.social_attributes = doc.social_attributes
                existing.risk_assessment = doc.risk_assessment
                existing.metadata = doc.metadata
                existing.retrieval = doc.retrieval
                existing.extend = doc.extend

                await existing.save()
                logger.info(f"Updated profile: {profile.profile_id}")
            else:
                await doc.insert()
                logger.info(f"Created profile: {profile.profile_id}")

            return True
        except Exception as e:
            logger.error(f"Failed to save profile: {profile.profile_id}, error: {e}")
            return False

    async def upsert_by_owner_target(
        self,
        profile: UnifiedProfile
    ) -> Optional[UnifiedProfileDocument]:
        """根据 owner_user_id 和 target_user_id 更新或创建画像"""
        try:
            if profile.profile_type == ProfileType.USER:
                existing = await self.model.find_one({
                    "owner_user_id": profile.owner_user_id,
                    "profile_type": ProfileType.USER.value
                })
            else:
                existing = await self.model.find_one({
                    "owner_user_id": profile.owner_user_id,
                    "target_user_id": profile.target_user_id
                })

            if existing:
                # 更新所有字段
                existing.display_name = profile.display_name
                existing.aliases = profile.aliases
                existing.gender = self._field_to_storage(profile.gender)
                existing.age = self._field_to_storage(profile.age)
                existing.education_level = self._field_to_storage(profile.education_level)
                existing.intimacy_level = self._field_to_storage(profile.intimacy_level)
                existing.traits = self._fields_to_storage(profile.traits)
                existing.personality = self._fields_to_storage(profile.personality)
                existing.interests = self._fields_to_storage(profile.interests)
                existing.occupation = self._fields_to_storage(profile.occupation)
                existing.relationship = self._fields_to_storage(profile.relationship)
                existing.way_of_decision_making = self._fields_to_storage(profile.way_of_decision_making)
                existing.life_habit_preference = self._fields_to_storage(profile.life_habit_preference)
                existing.communication_style = self._fields_to_storage(profile.communication_style)
                existing.catchphrase = self._fields_to_storage(profile.catchphrase)
                existing.user_to_friend_catchphrase = self._fields_to_storage(profile.user_to_friend_catchphrase)
                existing.user_to_friend_chat_style = self._fields_to_storage(profile.user_to_friend_chat_style)
                existing.motivation_system = self._fields_to_storage(profile.motivation_system)
                existing.fear_system = self._fields_to_storage(profile.fear_system)
                existing.value_system = self._fields_to_storage(profile.value_system)
                existing.humor_use = self._fields_to_storage(profile.humor_use)
                existing.social_attributes = profile.social_attributes.to_dict()
                existing.risk_assessment = profile.risk_assessment.to_dict() if profile.risk_assessment else None
                existing.metadata = profile.metadata.to_dict()
                existing.retrieval = profile.retrieval.to_dict() if profile.retrieval else None
                existing.extend = profile.extend

                # 增加版本号
                existing.metadata["version"] = existing.metadata.get("version", 1) + 1
                existing.metadata["update_count"] = existing.metadata.get("update_count", 0) + 1

                await existing.save()
                logger.info(f"Updated profile: {profile.profile_id}")
                return existing
            else:
                doc = self._profile_to_document(profile)
                await doc.insert()
                logger.info(f"Created profile: {profile.profile_id}")
                return doc

        except Exception as e:
            logger.error(f"Failed to upsert profile: {profile.profile_id}, error: {e}")
            return None

    # ==================== 更新方法 ====================

    async def update_social_attributes(
        self,
        profile_id: str,
        social_attributes: Dict[str, Any]
    ) -> bool:
        """更新画像的社交属性"""
        try:
            doc = await self.model.find_one(
                UnifiedProfileDocument.profile_id == profile_id
            )
            if doc:
                doc.social_attributes = social_attributes
                doc.metadata["version"] = doc.metadata.get("version", 1) + 1
                await doc.save()
                return True
            return False
        except Exception as e:
            logger.error(f"Failed to update social attributes: {profile_id}, error: {e}")
            return False

    # ==================== 删除方法 ====================

    async def delete_by_profile_id(self, profile_id: str) -> bool:
        """根据 profile_id 删除画像"""
        try:
            result = await self.model.find(
                UnifiedProfileDocument.profile_id == profile_id
            ).delete()
            return result.deleted_count > 0
        except Exception as e:
            logger.error(f"Failed to delete profile: {profile_id}, error: {e}")
            return False

    async def delete_by_owner(self, owner_user_id: str) -> int:
        """删除用户的所有画像"""
        try:
            result = await self.model.find(
                UnifiedProfileDocument.owner_user_id == owner_user_id
            ).delete()
            return result.deleted_count
        except Exception as e:
            logger.error(f"Failed to delete profiles by owner: {owner_user_id}, error: {e}")
            return 0

    # ==================== 转换方法 ====================

    def _fields_to_storage(self, fields) -> List[Dict[str, Any]]:
        """将 ProfileField 列表转换为存储格式"""
        if not fields:
            return []
        return [f.to_dict() if hasattr(f, 'to_dict') else f for f in fields]

    def _field_to_storage(self, field) -> Optional[Dict[str, Any]]:
        """将单个 ProfileField 转换为存储格式"""
        if not field:
            return None
        return field.to_dict() if hasattr(field, 'to_dict') else field

    def _document_to_profile(self, doc: UnifiedProfileDocument) -> UnifiedProfile:
        """将文档转换为 UnifiedProfile 对象"""
        return UnifiedProfile.from_dict({
            "profile_id": doc.profile_id,
            "profile_type": doc.profile_type,
            "owner_user_id": doc.owner_user_id,
            "target_user_id": doc.target_user_id,
            "conversation_id": doc.conversation_id,
            "display_name": doc.display_name,
            "aliases": doc.aliases or [],
            "gender": doc.gender,
            "age": doc.age,
            "education_level": doc.education_level,
            "intimacy_level": doc.intimacy_level,
            "traits": doc.traits or [],
            "personality": doc.personality or [],
            "interests": doc.interests or [],
            "occupation": doc.occupation or [],
            "relationship": doc.relationship or [],
            "way_of_decision_making": doc.way_of_decision_making or [],
            "life_habit_preference": doc.life_habit_preference or [],
            "communication_style": doc.communication_style or [],
            "catchphrase": doc.catchphrase or [],
            "user_to_friend_catchphrase": doc.user_to_friend_catchphrase or [],
            "user_to_friend_chat_style": doc.user_to_friend_chat_style or [],
            "motivation_system": doc.motivation_system or [],
            "fear_system": doc.fear_system or [],
            "value_system": doc.value_system or [],
            "humor_use": doc.humor_use or [],
            "social_attributes": doc.social_attributes,
            "risk_assessment": doc.risk_assessment,
            "metadata": doc.metadata,
            "retrieval": doc.retrieval,
            "extend": doc.extend or {}
        })

    def _profile_to_document(self, profile: UnifiedProfile) -> UnifiedProfileDocument:
        """将 UnifiedProfile 对象转换为文档"""
        return UnifiedProfileDocument(
            profile_id=profile.profile_id,
            profile_type=profile.profile_type.value,
            owner_user_id=profile.owner_user_id,
            target_user_id=profile.target_user_id,
            conversation_id=profile.conversation_id,
            display_name=profile.display_name,
            aliases=profile.aliases,
            gender=self._field_to_storage(profile.gender),
            age=self._field_to_storage(profile.age),
            education_level=self._field_to_storage(profile.education_level),
            intimacy_level=self._field_to_storage(profile.intimacy_level),
            traits=self._fields_to_storage(profile.traits),
            personality=self._fields_to_storage(profile.personality),
            interests=self._fields_to_storage(profile.interests),
            occupation=self._fields_to_storage(profile.occupation),
            relationship=self._fields_to_storage(profile.relationship),
            way_of_decision_making=self._fields_to_storage(profile.way_of_decision_making),
            life_habit_preference=self._fields_to_storage(profile.life_habit_preference),
            communication_style=self._fields_to_storage(profile.communication_style),
            catchphrase=self._fields_to_storage(profile.catchphrase),
            user_to_friend_catchphrase=self._fields_to_storage(profile.user_to_friend_catchphrase),
            user_to_friend_chat_style=self._fields_to_storage(profile.user_to_friend_chat_style),
            motivation_system=self._fields_to_storage(profile.motivation_system),
            fear_system=self._fields_to_storage(profile.fear_system),
            value_system=self._fields_to_storage(profile.value_system),
            humor_use=self._fields_to_storage(profile.humor_use),
            social_attributes=profile.social_attributes.to_dict(),
            risk_assessment=profile.risk_assessment.to_dict() if profile.risk_assessment else None,
            metadata=profile.metadata.to_dict(),
            retrieval=profile.retrieval.to_dict() if profile.retrieval else None,
            extend=profile.extend
        )


# 用于 DI 的别名
unified_profile_repository = UnifiedProfileRepository