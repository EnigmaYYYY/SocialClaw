"""
Format Converters for Social Copilot 鈫?EverMemOS Integration

璐熻矗涓よ竟鏁版嵁鏍煎紡鐨勭浉浜掕浆鎹細
- SocialCopilotConverter: Social Copilot 鏍煎紡 鈫?UnifiedProfile
- EverMemOSConverter: EverMemOS 鏍煎紡 鈫?UnifiedProfile
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
import hashlib

from api_specs.unified_types import (
    UnifiedProfile,
    UnifiedMessage,
    UnifiedFact,
    UnifiedEvidence,
    SocialAttributes,
    CommunicationStyle,
    RiskAssessment,
    ProfileMetadata,
    ProfileField,
    RetrievalInfo,
    IntermediaryInfo,
    ProfileType,
    IntimacyLevel,
    RiskLevel,
    MessageLength,
    FactCategory,
    SenderType,
    generate_conversation_id,
    generate_target_user_id,
    get_now_with_timezone,
    normalize_intimacy_level,
)


class SocialCopilotConverter:
    """
    Social Copilot 鏍煎紡杞崲鍣?

    灏?Social Copilot 鐨?TypeScript 鏍煎紡杞崲涓?UnifiedProfile銆?
    """

    @staticmethod
    def convert_user_profile(
        sc_profile: Dict[str, Any],
        owner_user_id: str
    ) -> UnifiedProfile:
        """
        杞崲 Social Copilot UserProfile 涓?UnifiedProfile

        Args:
            sc_profile: Social Copilot UserProfile 鏍煎紡
            owner_user_id: 鐢ㄦ埛ID

        Returns:
            UnifiedProfile
        """
        now = get_now_with_timezone().isoformat()

        # 鎻愬彇 communication_habits
        habits = sc_profile.get("communication_habits", {})
        base_info = sc_profile.get("base_info", {})

        # 鏋勫缓 communication_style 鍒楄〃
        communication_style: List[ProfileField] = []

        # 娑堟伅闀垮害鍋忓ソ
        msg_length = habits.get("msg_avg_length", "short")
        length_map = {"short": "消息简短", "medium": "消息中等长度", "long": "消息较长"}
        communication_style.append(ProfileField(
            value=length_map.get(msg_length, "消息简短"),
            evidence_level="L2",
            evidences=[]
        ))

        # 璇皵椋庢牸
        tone_style = base_info.get("tone_style", "friendly")
        if tone_style:
            communication_style.append(ProfileField(
                value=tone_style,
                evidence_level="L2",
                evidences=[]
            ))

        # 鏋勫缓鍙ｅご绂呭垪琛?
        catchphrase: List[ProfileField] = []
        for phrase in habits.get("frequent_phrases", [])[:5]:
            catchphrase.append(ProfileField(
                value=phrase,
                evidence_level="L1",
                evidences=[]
            ))

        # 鏋勫缓鑱屼笟鍒楄〃
        occupation: List[ProfileField] = []
        if base_info.get("occupation"):
            occupation.append(ProfileField(
                value=base_info["occupation"],
                evidence_level="L1",
                evidences=[]
            ))

        return UnifiedProfile(
            profile_id=f"profile_{hashlib.sha256(owner_user_id.encode()).hexdigest()[:16]}",
            profile_type=ProfileType.USER,
            owner_user_id=owner_user_id,
            display_name="Me",
            occupation=occupation,
            communication_style=communication_style,
            catchphrase=catchphrase,
            metadata=ProfileMetadata(
                version=1,
                created_at=now,
                last_updated=now,
                update_count=0
            )
        )

    @staticmethod
    def convert_contact_profile(
        sc_profile: Dict[str, Any],
        owner_user_id: str,
        session_key: str
    ) -> UnifiedProfile:
        """
        杞崲 Social Copilot ContactProfile 涓?UnifiedProfile

        Args:
            sc_profile: Social Copilot ContactProfile 鏍煎紡
            owner_user_id: 鐢ㄦ埛ID
            session_key: 浼氳瘽鏍囪瘑

        Returns:
            UnifiedProfile
        """
        now = get_now_with_timezone().isoformat()

        target_user_id = generate_target_user_id(session_key, owner_user_id)
        conversation_id = generate_conversation_id(session_key)

        # 鎻愬彇 profile
        profile = sc_profile.get("profile", {})

        # 鎻愬彇 relationship_graph
        rel_graph = sc_profile.get("relationship_graph", {})

        # 杞崲 intimacy_level
        intimacy_map = {
            "stranger": IntimacyLevel.STRANGER,
            "formal": IntimacyLevel.FORMAL,
            "close": IntimacyLevel.CLOSE,
            "intimate": IntimacyLevel.INTIMATE
        }
        intimacy_level = intimacy_map.get(
            rel_graph.get("intimacy_level", "stranger"),
            IntimacyLevel.STRANGER
        )

        # 杞崲 intermediary
        intermediary_data = rel_graph.get("intermediary", {})
        intermediary = IntermediaryInfo(
            has_intermediary=intermediary_data.get("has_intermediary", False),
            name=intermediary_data.get("name"),
            context=intermediary_data.get("context")
        )

        # 鍒涘缓 social_attributes
        social_attributes = SocialAttributes(
            role=profile.get("role", "unknown"),
            age_group=profile.get("age_group"),
            intimacy_level=intimacy_level,
            current_status=rel_graph.get("current_status", "unknown"),
            intermediary=intermediary
        )

        # 杞崲 risk_assessment
        risk_data = sc_profile.get("risk_assessment", {})
        risk_assessment = None
        if risk_data.get("is_suspicious"):
            risk_level_map = {
                "low": RiskLevel.LOW,
                "medium": RiskLevel.MEDIUM,
                "high": RiskLevel.HIGH
            }
            risk_assessment = RiskAssessment(
                is_suspicious=risk_data.get("is_suspicious", False),
                risk_level=risk_level_map.get(risk_data.get("risk_level", "low"), RiskLevel.LOW),
                warning_msg=risk_data.get("warning_msg", ""),
                last_checked=now
            )

        # 杞崲 traits
        traits: List[ProfileField] = [
            ProfileField(value=trait, evidence_level="L2", evidences=[])
            for trait in profile.get("personality_tags", [])
        ]

        # 杞崲 interests
        interests: List[ProfileField] = [
            ProfileField(value=interest, evidence_level="L2", evidences=[])
            for interest in profile.get("interests", [])
        ]

        # 杞崲 occupation
        occupation: List[ProfileField] = []
        if profile.get("occupation"):
            occupation.append(ProfileField(
                value=profile["occupation"],
                evidence_level="L2",
                evidences=[]
            ))

        return UnifiedProfile(
            profile_id=f"profile_{hashlib.sha256(target_user_id.encode()).hexdigest()[:16]}",
            profile_type=ProfileType.CONTACT,
            owner_user_id=owner_user_id,
            target_user_id=target_user_id,
            conversation_id=conversation_id,
            display_name=sc_profile.get("nickname", "unknown"),
            traits=traits,
            interests=interests,
            occupation=occupation,
            social_attributes=social_attributes,
            risk_assessment=risk_assessment,
            metadata=ProfileMetadata(
                version=1,
                created_at=now,
                last_updated=now,
                update_count=0
            )
        )

    @staticmethod
    def convert_chat_record(
        record: Dict[str, Any],
        conversation_id: str,
        owner_user_id: str
    ) -> UnifiedMessage:
        """
        杞崲 Social Copilot ChatRecordEntry 涓?UnifiedMessage

        Args:
            record: ChatRecordEntry 鏍煎紡
            conversation_id: 浼氳瘽ID
            owner_user_id: 鐢ㄦ埛ID

        Returns:
            UnifiedMessage
        """
        # 杞崲 sender_type
        sender_map = {
            "user": SenderType.USER,
            "contact": SenderType.CONTACT,
            "unknown": SenderType.UNKNOWN
        }
        sender_type = sender_map.get(record.get("sender", "unknown"), SenderType.UNKNOWN)

        # 纭畾 sender_id
        if sender_type == SenderType.USER:
            sender_id = owner_user_id
        else:
            sender_id = generate_target_user_id(conversation_id, owner_user_id)

        return UnifiedMessage(
            message_id=record.get("event_id") or f"msg_{hashlib.sha256(str(record).encode()).hexdigest()[:16]}",
            conversation_id=conversation_id,
            sender_id=sender_id,
            sender_name=record.get("contact_name") or record.get("sender", "unknown"),
            sender_type=sender_type,
            content=record.get("text", ""),
            timestamp=record.get("timestamp") or get_now_with_timezone().isoformat(),
            content_type=record.get("content_type") or "text",
            metadata={
                "frame_id": record.get("frame_id"),
                "non_text_description": record.get("non_text_description")
            }
        )

    @staticmethod
    def to_sc_user_profile(profile: UnifiedProfile) -> Dict[str, Any]:
        """
        灏?UnifiedProfile 杞崲鍥?Social Copilot UserProfile 鏍煎紡

        Args:
            profile: UnifiedProfile

        Returns:
            Social Copilot UserProfile 鏍煎紡
        """
        # 浠?communication_style 鍒楄〃涓彁鍙栦俊鎭?
        tone_style = "friendly"
        msg_avg_length = "short"

        for field in profile.communication_style:
            if field.value in ["消息简短", "消息中等长度", "消息较长"]:
                length_map = {"消息简短": "short", "消息中等长度": "medium", "消息较长": "long"}
                msg_avg_length = length_map.get(field.value, "short")
            else:
                tone_style = field.value

        # 浠?catchphrase 鍒楄〃涓彁鍙栧彛澶寸
        frequent_phrases = [f.value for f in profile.catchphrase if f.value][:5]

        # 浠?occupation 鍒楄〃涓彁鍙栬亴涓?
        occupation = profile.occupation[0].value if profile.occupation else ""

        return {
            "user_id": "self",
            "base_info": {
                "gender": "other",
                "occupation": occupation,
                "tone_style": tone_style
            },
            "communication_habits": {
                "frequent_phrases": frequent_phrases,
                "emoji_usage": [],
                "punctuation_style": "",
                "msg_avg_length": msg_avg_length
            },
            "last_updated": int(datetime.fromisoformat(profile.metadata.last_updated).timestamp() * 1000) if profile.metadata.last_updated else 0
        }

    @staticmethod
    def to_sc_contact_profile(profile: UnifiedProfile) -> Dict[str, Any]:
        """
        灏?UnifiedProfile 杞崲鍥?Social Copilot ContactProfile 鏍煎紡

        Args:
            profile: UnifiedProfile

        Returns:
            Social Copilot ContactProfile 鏍煎紡
        """
        risk_assessment = {
            "is_suspicious": False,
            "risk_level": "low",
            "warning_msg": ""
        }
        if profile.risk_assessment:
            risk_assessment = {
                "is_suspicious": profile.risk_assessment.is_suspicious,
                "risk_level": profile.risk_assessment.risk_level.value,
                "warning_msg": profile.risk_assessment.warning_msg
            }

        return {
            "contact_id": profile.target_user_id or profile.profile_id,
            "nickname": profile.display_name,
            "profile": {
                "role": profile.social_attributes.role,
                "age_group": profile.social_attributes.age_group or "",
                "personality_tags": [f.value for f in profile.traits if f.value],
                "interests": [f.value for f in profile.interests if f.value],
                "occupation": [f.value for f in profile.occupation if f.value]
            },
            "relationship_graph": {
                "current_status": profile.social_attributes.current_status,
                "intimacy_level": profile.social_attributes.intimacy_level.value,
                "intermediary": profile.social_attributes.intermediary.to_dict()
            },
            "chat_history_summary": "",
            "risk_assessment": risk_assessment,
            "last_updated": int(datetime.fromisoformat(profile.metadata.last_updated).timestamp() * 1000) if profile.metadata.last_updated else 0
        }


class EverMemOSConverter:
    """
    EverMemOS 鏍煎紡杞崲鍣?

    灏?EverMemOS 鐨?ProfileMemory 绛夋牸寮忚浆鎹负 UnifiedProfile銆?
    """

    @staticmethod
    def unified_to_profile_memory(profile: UnifiedProfile) -> Dict[str, Any]:
        """Convert UnifiedProfile into a ProfileMemory-like dict for incremental merge."""

        def fields_to_list(fields: Any) -> List[Dict[str, Any]]:
            if not fields:
                return []
            result: List[Dict[str, Any]] = []
            for item in fields:
                if hasattr(item, "value") and getattr(item, "value", None):
                    entry: Dict[str, Any] = {
                        "value": item.value,
                        "evidences": getattr(item, "evidences", []),
                    }
                    if getattr(item, "evidence_level", None):
                        entry["evidence_level"] = item.evidence_level
                    result.append(entry)
                elif isinstance(item, dict) and item.get("value"):
                    result.append(item)
            return result

        def field_to_dict(field: Any) -> Optional[Dict[str, Any]]:
            if not field:
                return None
            if hasattr(field, "value") and getattr(field, "value", None):
                entry: Dict[str, Any] = {
                    "value": field.value,
                    "evidences": getattr(field, "evidences", []),
                }
                if getattr(field, "evidence_level", None):
                    entry["evidence_level"] = field.evidence_level
                return entry
            if isinstance(field, dict) and field.get("value"):
                return field
            return None

        profile_data: Dict[str, Any] = {}

        if profile.display_name:
            profile_data["user_name"] = profile.display_name

        if profile.gender:
            gender = field_to_dict(profile.gender)
            if gender:
                profile_data["gender"] = gender

        if profile.age:
            age = field_to_dict(profile.age)
            if age:
                profile_data["age"] = age

        if profile.education_level:
            education_level = field_to_dict(profile.education_level)
            if education_level:
                profile_data["education_level"] = education_level

        if profile.intimacy_level:
            intimacy_level = field_to_dict(profile.intimacy_level)
            if intimacy_level:
                profile_data["intimacy_level"] = intimacy_level

        list_fields = {
            "traits": profile.traits,
            "personality": profile.personality,
            "occupation": profile.occupation,
            "relationship": profile.relationship,
            "interests": profile.interests,
            "communication_style": profile.communication_style,
            "catchphrase": profile.catchphrase,
            "way_of_decision_making": profile.way_of_decision_making,
            "life_habit_preference": profile.life_habit_preference,
            "user_to_friend_catchphrase": profile.user_to_friend_catchphrase,
            "motivation_system": profile.motivation_system,
            "fear_system": profile.fear_system,
            "value_system": profile.value_system,
            "humor_use": profile.humor_use,
        }

        for key, value in list_fields.items():
            if value:
                profile_data[key] = fields_to_list(value)

        if profile.user_to_friend_chat_style:
            chat_style_list = fields_to_list(profile.user_to_friend_chat_style)
            profile_data["user_to_friend_chat_style"] = chat_style_list
            profile_data["user_to_friend_chat_style_preference"] = chat_style_list

        if profile.social_attributes.role:
            profile_data["social_role"] = profile.social_attributes.role

        if profile.social_attributes.intimacy_level and "intimacy_level" not in profile_data:
            profile_data["intimacy_level"] = {
                "value": profile.social_attributes.intimacy_level.value,
                "evidence_level": "L2",
                "evidences": [],
            }

        if profile.social_attributes.intermediary:
            intermediary = profile.social_attributes.intermediary
            if intermediary.has_intermediary:
                if intermediary.name:
                    profile_data["intermediary_name"] = intermediary.name
                if intermediary.context:
                    profile_data["intermediary_context"] = intermediary.context

        if profile.risk_assessment:
            profile_data["risk_level"] = profile.risk_assessment.risk_level.value
            if profile.risk_assessment.warning_msg:
                profile_data["warning_msg"] = profile.risk_assessment.warning_msg

        return {
            "event_id": profile.profile_id,
            "user_id": profile.target_user_id or profile.owner_user_id,
            "conversation_id": profile.conversation_id,
            "version": getattr(profile.metadata, "version", 1),
            "created_at": getattr(profile.metadata, "created_at", None),
            "updated_at": getattr(profile.metadata, "last_updated", None),
            "memcell_count": getattr(profile.metadata, "source_memcell_count", 0),
            "last_updated_cluster": getattr(profile.metadata, "last_cluster_id", None),
            "vector": getattr(getattr(profile, "retrieval", None), "vector", None),
            "vector_model": getattr(getattr(profile, "retrieval", None), "vector_model", None),
            "profile_data": profile_data,
        }

    @staticmethod
    def convert_profile_memory(
        profile_memory: Dict[str, Any],
        profile_type: ProfileType | str,
        owner_user_id: Optional[str] = None,
        target_user_id: Optional[str] = None,
    ) -> UnifiedProfile:
        """Convert EverMemOS ProfileMemory dict to UnifiedProfile."""
        from api_specs.unified_types import (
            ProfileField,
            parse_profile_fields,
            SocialAttributes,
            ProfileMetadata,
            RetrievalInfo,
            generate_profile_id,
        )

        if owner_user_id is None:
            owner_user_id = str(profile_type)
            profile_type = ProfileType.CONTACT

        now = get_now_with_timezone().isoformat()
        profile_data = profile_memory.get("profile_data", {})

        def parse_field(key: str) -> Optional[ProfileField]:
            return ProfileField.from_llm_output(profile_data.get(key))

        def parse_fields(key: str) -> List[ProfileField]:
            return parse_profile_fields(profile_data.get(key))

        def parse_string_field(key: str) -> str:
            value = profile_data.get(key, "")
            if isinstance(value, dict):
                value = value.get("value", "")
            return str(value).strip() if value is not None else ""

        name_data = profile_data.get("name", {})
        if isinstance(name_data, dict):
            display_name = name_data.get("value", "unknown")
        else:
            display_name = str(name_data) if name_data else "unknown"

        traits = parse_fields("traits")
        personality = parse_fields("personality")
        interests = parse_fields("interests")
        communication_style = parse_fields("communication_style")
        catchphrase = parse_fields("catchphrase")
        occupation_fields = parse_fields("occupation")
        relationship_fields = parse_fields("relationship")
        user_to_friend_chat_style = (
            parse_fields("user_to_friend_chat_style")
            or parse_fields("user_to_friend_chat_style_preference")
        )

        relationship_value = relationship_fields[0].value if relationship_fields else "unknown"
        intimacy_field = parse_field("intimacy_level")
        intimacy_value = intimacy_field.value if intimacy_field else "stranger"

        intermediary_name = parse_string_field("intermediary_name")
        intermediary_context = parse_string_field("intermediary_context")
        has_intermediary = bool(intermediary_name)

        risk_level = parse_string_field("risk_level")
        warning_msg = parse_string_field("warning_msg")
        risk_assessment = None
        if risk_level in ("low", "medium", "high"):
            from api_specs.unified_types import RiskLevel as RiskLevelEnum

            risk_level_map = {
                "low": RiskLevelEnum.LOW,
                "medium": RiskLevelEnum.MEDIUM,
                "high": RiskLevelEnum.HIGH,
            }
            risk_assessment = RiskAssessment(
                is_suspicious=True,
                risk_level=risk_level_map.get(risk_level, RiskLevelEnum.LOW),
                warning_msg=warning_msg or "",
                last_checked=now,
            )

        metadata = ProfileMetadata(
            version=profile_memory.get("version", 1),
            created_at=profile_memory.get("created_at", now),
            last_updated=profile_memory.get("updated_at", now),
            source_memcell_count=profile_memory.get("memcell_count", 0),
            last_cluster_id=profile_memory.get("last_updated_cluster"),
        )

        return UnifiedProfile(
            profile_id=profile_memory.get("event_id") or generate_profile_id(),
            profile_type=profile_type,
            owner_user_id=owner_user_id,
            target_user_id=target_user_id,
            conversation_id=profile_memory.get("conversation_id"),
            display_name=display_name,
            aliases=[display_name] if display_name != "unknown" else [],
            gender=parse_field("gender"),
            age=parse_field("age"),
            education_level=parse_field("education_level"),
            intimacy_level=intimacy_field,
            traits=traits,
            personality=personality,
            occupation=occupation_fields,
            relationship=relationship_fields,
            interests=interests,
            communication_style=communication_style,
            catchphrase=catchphrase,
            way_of_decision_making=parse_fields("way_of_decision_making"),
            life_habit_preference=parse_fields("life_habit_preference"),
            user_to_friend_catchphrase=parse_fields("user_to_friend_catchphrase"),
            user_to_friend_chat_style=user_to_friend_chat_style,
            motivation_system=parse_fields("motivation_system"),
            fear_system=parse_fields("fear_system"),
            value_system=parse_fields("value_system"),
            humor_use=parse_fields("humor_use"),
            social_attributes=SocialAttributes(
                role=relationship_value,
                intimacy_level=normalize_intimacy_level(intimacy_value),
                intermediary=IntermediaryInfo(
                    has_intermediary=has_intermediary,
                    name=intermediary_name if has_intermediary else None,
                    context=intermediary_context if has_intermediary else None,
                ),
            ),
            risk_assessment=risk_assessment,
            metadata=metadata,
            retrieval=RetrievalInfo(
                vector=profile_memory.get("vector"),
                vector_model=profile_memory.get("vector_model"),
            ),
        )

    @staticmethod
    def convert_profile_memory_v2(
        profile_memory: Dict[str, Any] | Any,
        profile_type: ProfileType | str,
        owner_user_id: Optional[str] = None,
        target_user_id: Optional[str] = None,
    ) -> UnifiedProfile:
        """Convert LLM output directly to UnifiedProfile (v2)."""
        from api_specs.unified_types import (
            ProfileField,
            parse_profile_fields,
            SocialAttributes,
            ProfileMetadata,
            RetrievalInfo,
            generate_profile_id,
        )

        if owner_user_id is None:
            owner_user_id = str(profile_type)
            profile_type = ProfileType.CONTACT

        now = get_now_with_timezone().isoformat()

        if hasattr(profile_memory, "to_dict"):
            try:
                profile_memory = profile_memory.to_dict()
            except Exception:
                profile_memory = getattr(profile_memory, "__dict__", {})
        elif not isinstance(profile_memory, dict):
            profile_memory = getattr(profile_memory, "__dict__", {})

        def get_field(key: str) -> Any:
            return profile_memory.get(key) or profile_memory.get("profile_data", {}).get(key)

        def parse_field(key: str) -> Optional[ProfileField]:
            return ProfileField.from_llm_output(get_field(key))

        def parse_fields(key: str) -> List[ProfileField]:
            return parse_profile_fields(get_field(key))

        def parse_string_field(key: str) -> str:
            value = get_field(key)
            if isinstance(value, dict):
                value = value.get("value", "")
            elif isinstance(value, list) and value:
                first = value[0]
                if isinstance(first, dict):
                    value = first.get("value", "")
                else:
                    value = first
            return str(value).strip() if value is not None else ""

        display_name = (
            profile_memory.get("user_name", "")
            or get_field("name")
            or get_field("display_name")
            or "unknown"
        ).strip() or "unknown"

        relationship_fields = parse_fields("relationship")
        relationship_value = relationship_fields[0].value if relationship_fields else "unknown"

        intimacy_field = parse_field("intimacy_level")
        intimacy_value = intimacy_field.value if intimacy_field else "stranger"

        intermediary_name = parse_string_field("intermediary_name")
        intermediary_context = parse_string_field("intermediary_context")
        has_intermediary = bool(intermediary_name)

        risk_level = parse_string_field("risk_level")
        warning_msg = parse_string_field("warning_msg")
        risk_assessment = None
        if risk_level in ("low", "medium", "high"):
            from api_specs.unified_types import RiskLevel as RiskLevelEnum

            risk_level_map = {
                "low": RiskLevelEnum.LOW,
                "medium": RiskLevelEnum.MEDIUM,
                "high": RiskLevelEnum.HIGH,
            }
            risk_assessment = RiskAssessment(
                is_suspicious=True,
                risk_level=risk_level_map.get(risk_level, RiskLevelEnum.LOW),
                warning_msg=warning_msg or "",
                last_checked=now,
            )

        return UnifiedProfile(
            profile_id=profile_memory.get("event_id") or generate_profile_id(),
            profile_type=profile_type,
            owner_user_id=owner_user_id,
            target_user_id=target_user_id,
            conversation_id=profile_memory.get("conversation_id"),
            display_name=display_name,
            aliases=[display_name] if display_name != "unknown" else [],
            gender=parse_field("gender"),
            age=parse_field("age"),
            education_level=parse_field("education_level"),
            intimacy_level=intimacy_field,
            traits=parse_fields("traits"),
            personality=parse_fields("personality"),
            occupation=parse_fields("occupation"),
            relationship=relationship_fields,
            interests=parse_fields("interests"),
            way_of_decision_making=parse_fields("way_of_decision_making"),
            life_habit_preference=parse_fields("life_habit_preference"),
            communication_style=parse_fields("communication_style"),
            catchphrase=parse_fields("catchphrase"),
            user_to_friend_catchphrase=parse_fields("user_to_friend_catchphrase"),
            user_to_friend_chat_style=(
                parse_fields("user_to_friend_chat_style")
                or parse_fields("user_to_friend_chat_style_preference")
            ),
            motivation_system=parse_fields("motivation_system"),
            fear_system=parse_fields("fear_system"),
            value_system=parse_fields("value_system"),
            humor_use=parse_fields("humor_use"),
            social_attributes=SocialAttributes(
                role=relationship_value,
                intimacy_level=normalize_intimacy_level(intimacy_value),
                intermediary=IntermediaryInfo(
                    has_intermediary=has_intermediary,
                    name=intermediary_name if has_intermediary else None,
                    context=intermediary_context if has_intermediary else None,
                ),
            ),
            risk_assessment=risk_assessment,
            metadata=ProfileMetadata(
                version=profile_memory.get("version", 1),
                created_at=profile_memory.get("created_at", now),
                last_updated=profile_memory.get("updated_at", now),
                source_memcell_count=profile_memory.get("memcell_count", 0),
                last_cluster_id=profile_memory.get("last_updated_cluster"),
            ),
            retrieval=RetrievalInfo(
                vector=profile_memory.get("vector"),
                vector_model=profile_memory.get("vector_model"),
            ),
        )

    @staticmethod
    def _infer_fact_category(key: str) -> FactCategory:
        """鎺ㄦ柇浜嬪疄鍒嗙被"""
        key_lower = key.lower()

        if key_lower in ["occupation", "job", "鑱屼笟"]:
            return FactCategory.OCCUPATION
        elif key_lower in ["interest", "hobby", "鍏磋叮", "鐖卞ソ"]:
            return FactCategory.INTEREST
        elif key_lower in ["trait", "personality", "鎬ф牸", "鐗瑰緛"]:
            return FactCategory.TRAIT
        elif key_lower in ["role", "瑙掕壊"]:
            return FactCategory.ROLE
        elif key_lower in ["style", "catchphrase", "风格", "口头禅"]:
            return FactCategory.STYLE
        else:
            return FactCategory.OTHER

    @staticmethod
    def convert_memcell_to_messages(
        memcell: Dict[str, Any],
        conversation_id: str,
        owner_user_id: str
    ) -> List[UnifiedMessage]:
        """
        灏?EverMemOS MemCell.original_data 杞崲涓?UnifiedMessage 鍒楄〃

        Args:
            memcell: MemCell 鏍煎紡
            conversation_id: 浼氳瘽ID
            owner_user_id: 鐢ㄦ埛ID

        Returns:
            UnifiedMessage 鍒楄〃
        """
        messages = []
        original_data = memcell.get("original_data", [])

        for item in original_data:
            # 鎺ㄦ柇 sender_type
            sender_id = item.get("sender", "")
            if sender_id == owner_user_id or item.get("isSend"):
                sender_type = SenderType.USER
            else:
                sender_type = SenderType.CONTACT

            # 鎻愬彇鏃堕棿鎴?
            timestamp = item.get("timestamp") or item.get("createTime")
            if isinstance(timestamp, (int, float)):
                timestamp = datetime.fromtimestamp(timestamp).isoformat()
            elif not timestamp:
                timestamp = get_now_with_timezone().isoformat()

            message = UnifiedMessage(
                message_id=item.get("message_id") or item.get("msgId") or f"msg_{hashlib.sha256(str(item).encode()).hexdigest()[:16]}",
                conversation_id=conversation_id,
                sender_id=sender_id,
                sender_name=item.get("sender_name") or item.get("fromUser", "unknown"),
                sender_type=sender_type,
                content=item.get("content", ""),
                timestamp=timestamp,
                content_type=item.get("type") or item.get("msgType", "text"),
                metadata=item.get("metadata", {})
            )
            messages.append(message)

        return messages






