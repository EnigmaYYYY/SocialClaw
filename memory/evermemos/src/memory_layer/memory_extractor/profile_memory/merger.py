"""Utilities for merging profile memories collected from multiple groups."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from core.observation.logger import get_logger

from memory_layer.llm.llm_provider import LLMProvider
from memory_layer.memory_extractor.profile_memory.types import (
    ImportanceEvidence,
    ProfileMemory,
)
from memory_layer.memory_extractor.profile_memory.value_helpers import (
    merge_value_with_evidences_lists,
    merge_value_with_evidences_lists_keep_highest_level,
)

logger = get_logger(__name__)


def convert_important_info_to_evidence(
    important_info: Dict[str, Any]
) -> List[ImportanceEvidence]:
    """Convert aggregated group stats into ImportanceEvidence instances."""
    evidence_list: List[ImportanceEvidence] = []
    total_msgs = important_info["group_data"]["total_messages"]
    for user_id, user_data in important_info["user_data"].items():
        evidence_list.append(
            ImportanceEvidence(
                user_id=user_id,
                group_id=important_info["group_id"],
                speak_count=user_data["chat_count"],
                refer_count=user_data["at_count"],
                conversation_count=total_msgs,
            )
        )
    return evidence_list


class ProfileMemoryMerger:
    """Merge multiple ProfileMemory instances for a single user."""

    def __init__(self, llm_provider: LLMProvider) -> None:
        if llm_provider is None:
            error_msg = "llm_provider must not be None"
            logger.exception(error_msg)
            raise ValueError(error_msg)
        self.llm_provider = llm_provider

    @staticmethod
    def _truncate_evidences(evidences: Iterable[Any]) -> List[Dict[str, str]]:
        """Normalize evidences into canonical dict format while deduplicating by event_id."""
        if not evidences:
            return []

        normalized: List[Dict[str, str]] = []
        index_by_event_id: Dict[str, int] = {}
        for item in evidences:
            if item is None:
                continue

            event_id = ""
            reasoning = ""
            if isinstance(item, dict):
                raw_event_id = item.get("event_id", "")
                if raw_event_id:
                    event_id = (
                        raw_event_id.strip()
                        if isinstance(raw_event_id, str)
                        else str(raw_event_id).strip()
                    )
                raw_reasoning = item.get("reasoning", "")
                if raw_reasoning:
                    reasoning = (
                        raw_reasoning.strip()
                        if isinstance(raw_reasoning, str)
                        else str(raw_reasoning).strip()
                    )
            elif isinstance(item, str):
                event_id = item.strip()
            else:
                event_id = str(item).strip()

            if not event_id:
                continue

            existing_index = index_by_event_id.get(event_id)
            if existing_index is None:
                normalized.append({"event_id": event_id, "reasoning": reasoning})
                index_by_event_id[event_id] = len(normalized) - 1
            elif reasoning and not normalized[existing_index].get("reasoning"):
                normalized[existing_index]["reasoning"] = reasoning

        return normalized

    @classmethod
    def _profile_memory_to_prompt_dict(cls, profile: ProfileMemory) -> Dict[str, Any]:
        def truncate_evidences_in_items(
            items: Optional[List[Dict[str, Any]]]
        ) -> List[Dict[str, Any]]:
            if not items:
                return []
            result = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_copy = item.copy()
                evidences = item_copy.get("evidences", [])
                if evidences:
                    item_copy["evidences"] = cls._truncate_evidences(evidences)
                result.append(item_copy)
            return result

        return {
            "group_id": profile.group_id or "",
            "user_id": profile.user_id,
            "user_name": profile.user_name or "",
            "interests": truncate_evidences_in_items(profile.interests),
            "traits": truncate_evidences_in_items(profile.traits),
            "personality": truncate_evidences_in_items(profile.personality),
            "way_of_decision_making": truncate_evidences_in_items(
                profile.way_of_decision_making
            ),
            "life_habit_preference": truncate_evidences_in_items(
                profile.life_habit_preference
            ),
            "communication_style": truncate_evidences_in_items(
                profile.communication_style
            ),
            "catchphrase": truncate_evidences_in_items(profile.catchphrase),
            "user_to_friend_catchphrase": truncate_evidences_in_items(
                profile.user_to_friend_catchphrase
            ),
            "occupation": truncate_evidences_in_items(profile.occupation),
            "gender": profile.gender or "",
            "relationship": truncate_evidences_in_items(profile.relationship),
            "user_to_friend_chat_style_preference": truncate_evidences_in_items(
                profile.user_to_friend_chat_style_preference
            ),
        }

    async def merge_group_profiles(
        self, group_profiles: List[ProfileMemory], user_id: str
    ) -> ProfileMemory:
        """Merge multiple ProfileMemory instances from different groups for one user."""
        if not group_profiles:
            error_msg = "group_profiles must not be empty when merging"
            logger.exception(error_msg)
            raise ValueError(error_msg)

        all_matching_profiles: List[ProfileMemory] = []
        important_profiles: List[ProfileMemory] = []

        for profile in group_profiles:
            if profile is not None and profile.user_id == user_id:
                all_matching_profiles.append(profile)
                if (
                    profile.group_importance_evidence is None
                    or profile.group_importance_evidence.is_important is True
                ):
                    important_profiles.append(profile)

        if not all_matching_profiles:
            error_msg = f"No ProfileMemory found for user_id '{user_id}' when merging"
            logger.exception(error_msg)
            raise ValueError(error_msg)

        matching_profiles = (
            important_profiles if important_profiles else all_matching_profiles
        )
        base_profile = matching_profiles[0]

        merged_motivation_system = merge_value_with_evidences_lists_keep_highest_level(
            *[p.motivation_system for p in matching_profiles]
        )
        merged_fear_system = merge_value_with_evidences_lists_keep_highest_level(
            *[p.fear_system for p in matching_profiles]
        )
        merged_value_system = merge_value_with_evidences_lists_keep_highest_level(
            *[p.value_system for p in matching_profiles]
        )
        merged_humor_use = merge_value_with_evidences_lists_keep_highest_level(
            *[p.humor_use for p in matching_profiles]
        )

        def merge_field_normal(field_name: str) -> Optional[List[Dict[str, Any]]]:
            result = None
            for profile in matching_profiles:
                field_value = getattr(profile, field_name, None)
                result = merge_value_with_evidences_lists(result, field_value)
            return result

        merged_way_of_decision_making = merge_field_normal("way_of_decision_making")
        merged_traits = merge_field_normal("traits")
        merged_personality = merge_field_normal("personality")
        merged_interests = merge_field_normal("interests")
        merged_life_habit_preference = merge_field_normal("life_habit_preference")
        merged_communication_style = merge_field_normal("communication_style")
        merged_catchphrase = merge_field_normal("catchphrase")
        merged_user_to_friend_catchphrase = merge_field_normal(
            "user_to_friend_catchphrase"
        )
        merged_user_to_friend_chat_style_preference = merge_field_normal(
            "user_to_friend_chat_style_preference"
        )
        merged_occupation = merge_field_normal("occupation")
        merged_relationship = merge_field_normal("relationship")

        reasoning_parts: List[str] = []
        for profile in matching_profiles:
            text = profile.output_reasoning
            if text:
                stripped = text.strip()
                if stripped:
                    reasoning_parts.append(stripped)
        output_reasoning = "$".join(reasoning_parts) if reasoning_parts else None

        user_name = None
        gender = None
        for profile in reversed(matching_profiles):
            if profile.user_name and not user_name:
                user_name = profile.user_name
            if profile.gender and not gender:
                gender = profile.gender

        group_ids = [p.group_id for p in matching_profiles if p.group_id]
        merged_group_id = (
            ",".join(group_ids) if group_ids else base_profile.group_id or ""
        )

        timestamp = base_profile.timestamp
        ori_event_id_list = base_profile.ori_event_id_list
        for profile in matching_profiles[1:]:
            if profile.timestamp:
                timestamp = profile.timestamp
            if profile.ori_event_id_list:
                ori_event_id_list = profile.ori_event_id_list

        return ProfileMemory(
            memory_type=base_profile.memory_type,
            user_id=user_id,
            timestamp=timestamp,
            ori_event_id_list=ori_event_id_list,
            user_name=user_name,
            group_id=merged_group_id,
            output_reasoning=output_reasoning,
            motivation_system=merged_motivation_system,
            fear_system=merged_fear_system,
            value_system=merged_value_system,
            humor_use=merged_humor_use,
            life_habit_preference=merged_life_habit_preference,
            communication_style=merged_communication_style,
            catchphrase=merged_catchphrase,
            user_to_friend_catchphrase=merged_user_to_friend_catchphrase,
            user_to_friend_chat_style_preference=merged_user_to_friend_chat_style_preference,
            way_of_decision_making=merged_way_of_decision_making,
            traits=merged_traits,
            personality=merged_personality,
            occupation=merged_occupation,
            gender=gender,
            relationship=merged_relationship,
            interests=merged_interests,
        )
