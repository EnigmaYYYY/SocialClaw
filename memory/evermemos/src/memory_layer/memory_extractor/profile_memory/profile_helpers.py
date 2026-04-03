"""Profile-level helpers: payload conversion, accumulation, and merging."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Set

from core.observation.logger import get_logger

from api_specs.memory_types import BaseMemory, MemoryType, RawDataType
from memory_layer.memory_extractor.profile_memory.types import ProfileMemory
from memory_layer.memory_extractor.profile_memory.value_helpers import (
    extract_values_with_evidence,
    merge_value_with_evidences_lists,
)


# Evidence level priority mapping (L1 is highest)
EVIDENCE_LEVEL_PRIORITY = {"L1": 2, "L2": 1, "": 0}


def merge_value_lists_with_evidence_level(
    existing: Optional[List[Dict[str, Any]]],
    incoming: Optional[List[Dict[str, Any]]],
) -> Optional[List[Dict[str, Any]]]:
    """Merge value lists after LLM has resolved conflicts.

    LLM output already contains resolved values, so we just:
    1. Add incoming values (LLM decided to keep them)
    2. Merge evidences for same values (deduplicate by event_id)
    3. Keep higher evidence_level (L1 > L2)

    Supports new evidence format with reasoning:
    - evidences: [{"event_id": "...", "reasoning": "..."}]

    Args:
        existing: Existing value list from profile
        incoming: New value list from LLM (LLM has already decided what to keep)

    Returns:
        Merged value list with evidences and evidence_level preserved
    """
    if not existing and not incoming:
        return None

    merged_map: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    def add_from(source: Optional[List[Dict[str, Any]]]) -> None:
        if not source:
            return
        for item in source:
            if not isinstance(item, dict):
                continue
            value = item.get("value", "")
            if not value:
                continue

            value_key = value.strip() if isinstance(value, str) else str(value).strip()
            if not value_key:
                continue

            evidences = item.get("evidences", [])
            evidence_level = item.get("evidence_level", "")
            level = item.get("level", "")

            if value_key not in merged_map:
                order.append(value_key)
                merged_map[value_key] = {
                    "evidences": [],
                    "evidence_level": "",
                    "level": "",
                }

            # Merge evidences (deduplicate by event_id)
            # Support both old format (string list) and new format (dict list with reasoning)
            existing_event_ids = set()
            for ev in merged_map[value_key]["evidences"]:
                if isinstance(ev, dict):
                    existing_event_ids.add(ev.get("event_id", ""))
                else:
                    existing_event_ids.add(str(ev))

            for ev in evidences:
                if isinstance(ev, dict):
                    event_id = ev.get("event_id", "")
                    reasoning = ev.get("reasoning", "")
                    if event_id and event_id not in existing_event_ids:
                        merged_map[value_key]["evidences"].append({
                            "event_id": event_id,
                            "reasoning": reasoning,
                        })
                        existing_event_ids.add(event_id)
                elif isinstance(ev, str) and ev not in existing_event_ids:
                    merged_map[value_key]["evidences"].append({
                        "event_id": ev,
                        "reasoning": "",
                    })
                    existing_event_ids.add(ev)

            # Keep higher evidence_level (L1 > L2)
            current_priority = EVIDENCE_LEVEL_PRIORITY.get(
                merged_map[value_key]["evidence_level"], 0
            )
            new_priority = EVIDENCE_LEVEL_PRIORITY.get(evidence_level, 0)
            if new_priority > current_priority:
                merged_map[value_key]["evidence_level"] = evidence_level

            # Keep level if provided
            if level:
                merged_map[value_key]["level"] = level

    # First add existing, then incoming (incoming may replace existing values)
    add_from(existing)
    add_from(incoming)

    if not order:
        return None

    result: List[Dict[str, Any]] = []
    for val in order:
        entry: Dict[str, Any] = {
            "value": val,
            "evidences": merged_map[val]["evidences"],
        }
        evidence_level = merged_map[val].get("evidence_level", "")
        if evidence_level:
            entry["evidence_level"] = evidence_level
        level = merged_map[val].get("level", "")
        if level:
            entry["level"] = level
        result.append(entry)

    return result

logger = get_logger(__name__)


def _normalize_single_field(value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    field_value = value.get("value")
    if field_value is None or not str(field_value).strip():
        return None
    normalized: Dict[str, Any] = {"value": str(field_value).strip()}
    evidences = value.get("evidences", [])
    normalized["evidences"] = evidences if isinstance(evidences, list) else []
    evidence_level = value.get("evidence_level")
    if isinstance(evidence_level, str) and evidence_level.strip():
        normalized["evidence_level"] = evidence_level.strip()
    return normalized


def _merge_single_field_with_pending_conflict(
    existing_value: Optional[Dict[str, Any]],
    new_value: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    existing_normalized = _normalize_single_field(existing_value)
    new_normalized = _normalize_single_field(new_value)

    if not existing_normalized:
        return new_normalized
    if not new_normalized:
        return existing_normalized

    old_text = str(existing_normalized.get("value", "")).strip()
    new_text = str(new_normalized.get("value", "")).strip()
    if old_text == new_text:
        old_level = str(existing_normalized.get("evidence_level", "")).strip()
        new_level = str(new_normalized.get("evidence_level", "")).strip()
        old_priority = EVIDENCE_LEVEL_PRIORITY.get(old_level, 0)
        new_priority = EVIDENCE_LEVEL_PRIORITY.get(new_level, 0)
        stronger = new_normalized if new_priority >= old_priority else existing_normalized

        merged_evidences: List[Dict[str, Any]] = []
        seen_event_ids: Set[str] = set()
        for source in (existing_normalized, new_normalized):
            for evidence in source.get("evidences", []) if isinstance(source.get("evidences"), list) else []:
                if isinstance(evidence, dict):
                    event_id = str(evidence.get("event_id", "")).strip()
                    reasoning = str(evidence.get("reasoning", "")).strip()
                    if not event_id or event_id in seen_event_ids:
                        continue
                    merged_evidences.append({"event_id": event_id, "reasoning": reasoning})
                    seen_event_ids.add(event_id)
                elif isinstance(evidence, str):
                    event_id = evidence.strip()
                    if not event_id or event_id in seen_event_ids:
                        continue
                    merged_evidences.append({"event_id": event_id, "reasoning": ""})
                    seen_event_ids.add(event_id)

        result = dict(stronger)
        result["evidences"] = merged_evidences
        return result

    old_level = str(existing_normalized.get("evidence_level", "")).strip()
    new_level = str(new_normalized.get("evidence_level", "")).strip()
    old_priority = EVIDENCE_LEVEL_PRIORITY.get(old_level, 0)
    new_priority = EVIDENCE_LEVEL_PRIORITY.get(new_level, 0)

    # Allow overwrite only when new evidence is significantly stronger.
    if new_priority > old_priority:
        return new_normalized
    if old_priority > new_priority:
        return existing_normalized

    merged_evidence_list: List[Dict[str, Any]] = []
    seen_event_ids: Set[str] = set()
    for source in (existing_normalized, new_normalized):
        evidences = source.get("evidences", [])
        if not isinstance(evidences, list):
            continue
        for evidence in evidences:
            if isinstance(evidence, dict):
                event_id = str(evidence.get("event_id", "")).strip()
                reasoning = str(evidence.get("reasoning", "")).strip()
                if not event_id or event_id in seen_event_ids:
                    continue
                merged_evidence_list.append({"event_id": event_id, "reasoning": reasoning})
                seen_event_ids.add(event_id)
            elif isinstance(evidence, str):
                event_id = evidence.strip()
                if not event_id or event_id in seen_event_ids:
                    continue
                merged_evidence_list.append({"event_id": event_id, "reasoning": ""})
                seen_event_ids.add(event_id)

    pending_value = f"[矛盾待定] {old_text} vs {new_text}"
    return {
        "value": pending_value,
        "evidence_level": old_level or new_level or "L2",
        "evidences": merged_evidence_list,
    }


def remove_evidences_from_profile(profile_obj: Dict[str, Any]) -> Dict[str, Any]:
    """Build a prompt-safe compact profile while preserving evidence reasoning.

    Historical behavior removed evidences entirely. For incremental profile updates,
    LLM needs evidence reasoning to decide keep/add/override. This helper now keeps
    `evidences` in canonical dict form: {"event_id": "...", "reasoning": "..."}.
    """

    def normalize_evidences(evidences: Any) -> List[Dict[str, str]]:
        if not evidences:
            return []
        if isinstance(evidences, str):
            evidences = [evidences]
        if not isinstance(evidences, list):
            evidences = [evidences]

        result: List[Dict[str, str]] = []
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
                result.append({"event_id": event_id, "reasoning": reasoning})
                index_by_event_id[event_id] = len(result) - 1
            elif reasoning and not result[existing_index].get("reasoning"):
                result[existing_index]["reasoning"] = reasoning

        return result

    def strip_content(content: Any) -> Any:
        if isinstance(content, dict):
            compact: Dict[str, Any] = {}
            for key, value in content.items():
                if key == "evidences":
                    normalized = normalize_evidences(value)
                    if normalized:
                        compact[key] = normalized
                    else:
                        compact[key] = []
                    continue
                compact[key] = strip_content(value)
            return compact
        if isinstance(content, list):
            return [strip_content(item) for item in content]
        return content

    result: Dict[str, Any] = {}
    for key, value in profile_obj.items():
        if key == "evidences":
            result[key] = normalize_evidences(value)
            continue
        result[key] = strip_content(value)
    return result


def accumulate_old_memory_entry(
    memory: BaseMemory, participants_profile_list: List[Dict[str, Any]]
) -> None:
    """Convert legacy BaseMemory objects into prompt-ready dictionaries.

    Uses to_dict() method to preserve all fields including evidence_level and reasoning.
    """
    try:
        if getattr(memory, "memory_type", None) != MemoryType.PROFILE and not hasattr(
            memory, "user_id"
        ):
            return

        # Prefer to_dict() method to get complete data including evidence_level and reasoning
        if hasattr(memory, "to_dict"):
            profile_obj = memory.to_dict()
        elif hasattr(memory, "__dict__"):
            profile_obj = {
                k: v for k, v in memory.__dict__.items() if not k.startswith("_")
            }
        else:
            profile_obj = {"user_id": getattr(memory, "user_id", "")}

        # Ensure user_id exists
        if not profile_obj.get("user_id"):
            return

        # Remove fields not needed for LLM prompt
        fields_to_remove = [
            "memory_type",
            "timestamp",
            "ori_event_id_list",
            "group_id",
            "type",
            "subject",
            "summary",
            "event_id",
            "conversation_id",
            "participants",
            "memcell_event_id_list",
            "extend",
            "vector",
            "vector_model",
        ]
        for field in fields_to_remove:
            profile_obj.pop(field, None)

        # Remove metadata fields
        metadata_fields = [
            "version",
            "created_at",
            "updated_at",
            "memcell_count",
            "last_updated_cluster",
        ]
        for field in metadata_fields:
            profile_obj.pop(field, None)

        if len(profile_obj) > 1:
            participants_profile_list.append(profile_obj)

    except Exception as exc:  # pylint: disable=broad-except
        logger.error("Failed to extract old memory entry: %s", exc)


def profile_payload_to_memory(
    profile_data: Dict[str, Any],
    *,
    group_id: str,
    valid_conversation_ids: Optional[Set[str]] = None,
    conversation_date_map: Optional[Dict[str, str]] = None,
    valid_user_ids: Optional[Set[str]] = None,
    user_id_to_name: Optional[Dict[str, str]] = None,
) -> Optional[ProfileMemory]:
    """Convert LLM payloads into ProfileMemory instances."""
    if not isinstance(profile_data, dict):
        return None

    extracted_user_id = str(profile_data.get("user_id", "")).strip()
    extracted_user_name = (
        profile_data.get("user_name")
        or profile_data.get("display_name")
        or profile_data.get("name")
        or ""
    )
    if not extracted_user_id:
        logger.debug(
            "LLM generated user %s has no user_id, skipping", extracted_user_name
        )
        return None

    if valid_user_ids is not None and extracted_user_id not in valid_user_ids:
        logger.debug(
            "LLM generated user_id %s not in valid user list, skipping",
            extracted_user_id,
        )
        return None

    if user_id_to_name:
        mapped_name = user_id_to_name.get(extracted_user_id)
        if mapped_name:
            extracted_user_name = mapped_name

    output_reasoning_raw = profile_data.get("output_reasoning")
    output_reasoning: Optional[str] = None
    if output_reasoning_raw is not None:
        output_reasoning = str(output_reasoning_raw).strip() or None

    field_aliases = {
        "traits": ["traits"],
        "personality": ["personality"],
        "way_of_decision_making": ["way_of_decision_making", "decision_style"],
        "life_habit_preference": ["life_habit_preference", "life_preferences"],
        "communication_style": ["communication_style"],
        "catchphrase": ["catchphrase", "frequent_phrases"],
        "user_to_friend_catchphrase": ["user_to_friend_catchphrase"],
        "user_to_friend_chat_style_preference": [
            "user_to_friend_chat_style_preference",
            "user_to_friend_chat_style",
            "reply_style_preference",
        ],
        "motivation_system": ["motivation_system", "motivations"],
        "fear_system": ["fear_system", "fears"],
        "value_system": ["value_system", "values"],
        "humor_use": ["humor_use", "humor_style"],
        "interests": ["interests"],
        "occupation": ["occupation"],
        "relationship": ["relationship", "role"],
    }

    single_value_aliases = {
        "age": ["age"],
        "education_level": ["education_level"],
        "intimacy_level": ["intimacy_level"],
        "gender": ["gender"],
    }

    string_aliases = {
        "intermediary_name": ["intermediary_name"],
        "intermediary_context": ["intermediary_context"],
        "risk_level": ["risk_level"],
        "warning_msg": ["warning_msg"],
    }

    def first_present(aliases: List[str]) -> Any:
        for alias in aliases:
            if alias in profile_data and profile_data.get(alias) is not None:
                return profile_data.get(alias)
        return None

    def normalize_list_like(raw: Any) -> Any:
        if isinstance(raw, list):
            normalized: List[Any] = []
            for item in raw:
                if isinstance(item, str):
                    value = item.strip()
                    if value:
                        normalized.append({"value": value, "evidences": []})
                else:
                    normalized.append(item)
            return normalized
        return raw

    def extract(field: str) -> Optional[List[Dict[str, Any]]]:
        raw = first_present(field_aliases.get(field, [field]))
        return extract_values_with_evidence(
            normalize_list_like(raw),
            field_name=field,
            valid_conversation_ids=valid_conversation_ids,
            conversation_date_map=conversation_date_map,
        )

    def extract_single_field(field: str) -> Optional[Dict[str, Any]]:
        raw = first_present(single_value_aliases.get(field, [field]))
        parsed = extract_values_with_evidence(
            raw,
            field_name=field,
            valid_conversation_ids=valid_conversation_ids,
            conversation_date_map=conversation_date_map,
        )
        if not parsed:
            return None
        first = parsed[0]
        if not isinstance(first, dict):
            return None
        value = first.get("value")
        if value is None or not str(value).strip():
            return None
        result: Dict[str, Any] = {
            "value": str(value).strip(),
            "evidences": first.get("evidences", []),
        }
        evidence_level = first.get("evidence_level")
        if evidence_level:
            result["evidence_level"] = evidence_level
        return result

    def extract_string(field: str) -> Optional[str]:
        raw = first_present(string_aliases.get(field, [field]))
        if raw is None:
            return None
        if isinstance(raw, str):
            value = raw.strip()
            return value or None
        if isinstance(raw, dict):
            value = raw.get("value")
            if value is None:
                return None
            value = str(value).strip()
            return value or None
        return str(raw).strip() or None

    def extract_scalar_text(field: str) -> Optional[str]:
        raw = first_present(single_value_aliases.get(field, [field]))
        if raw is None:
            return None
        if isinstance(raw, str):
            value = raw.strip()
            return value or None
        if isinstance(raw, dict):
            value = raw.get("value")
            if value is None:
                return None
            value = str(value).strip()
            return value or None
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict):
                    value = item.get("value")
                    if value is not None and str(value).strip():
                        return str(value).strip()
                elif isinstance(item, str) and item.strip():
                    return item.strip()
        return None

    motivation_values = extract("motivation_system")
    fear_values = extract("fear_system")
    value_system_values = extract("value_system")
    humor_values = extract("humor_use")
    user_to_friend_chat_style_preference_values = extract(
        "user_to_friend_chat_style_preference"
    )
    life_habit_preference_values = extract("life_habit_preference")
    communication_style_values = extract("communication_style")
    catchphrase_values = extract("catchphrase")
    user_to_friend_catchphrase_values = extract("user_to_friend_catchphrase")
    interests_values = extract("interests")
    traits_values = extract("traits")
    personality_values = extract("personality")
    way_of_decision_values = extract("way_of_decision_making")
    occupation_values = extract("occupation")
    relationship_values = extract("relationship")

    gender_value = extract_scalar_text("gender")
    age_value = extract_single_field("age")
    education_level_value = extract_single_field("education_level")
    intimacy_level_value = extract_single_field("intimacy_level")

    intermediary_name_value = extract_string("intermediary_name")
    intermediary_context_value = extract_string("intermediary_context")
    risk_level_value = extract_string("risk_level")
    warning_msg_value = extract_string("warning_msg")

    if not (
        output_reasoning
        or motivation_values
        or fear_values
        or value_system_values
        or humor_values
        or life_habit_preference_values
        or communication_style_values
        or catchphrase_values
        or user_to_friend_catchphrase_values
        or user_to_friend_chat_style_preference_values
        or way_of_decision_values
        or traits_values
        or personality_values
        or occupation_values
        or gender_value
        or age_value
        or education_level_value
        or relationship_values
        or intimacy_level_value
        or intermediary_name_value
        or intermediary_context_value
        or interests_values
        or risk_level_value
        or warning_msg_value
    ):
        logger.info(
            "profile_payload_to_memory returned None: user_id=%s user_name=%s fields_present=%s",
            extracted_user_id,
            extracted_user_name,
            {
                "output_reasoning": bool(output_reasoning),
                "motivation_system": bool(motivation_values),
                "fear_system": bool(fear_values),
                "value_system": bool(value_system_values),
                "humor_use": bool(humor_values),
                "life_habit_preference": bool(life_habit_preference_values),
                "communication_style": bool(communication_style_values),
                "catchphrase": bool(catchphrase_values),
                "user_to_friend_catchphrase": bool(user_to_friend_catchphrase_values),
                "user_to_friend_chat_style_preference": bool(
                    user_to_friend_chat_style_preference_values
                ),
                "way_of_decision_making": bool(way_of_decision_values),
                "traits": bool(traits_values),
                "personality": bool(personality_values),
                "occupation": bool(occupation_values),
                "gender": bool(gender_value),
                "age": bool(age_value),
                "education_level": bool(education_level_value),
                "relationship": bool(relationship_values),
                "intimacy_level": bool(intimacy_level_value),
                "intermediary_name": bool(intermediary_name_value),
                "intermediary_context": bool(intermediary_context_value),
                "interests": bool(interests_values),
                "risk_level": bool(risk_level_value),
                "warning_msg": bool(warning_msg_value),
            },
        )
        return None

    return ProfileMemory(
        memory_type=MemoryType.PROFILE,
        user_id=extracted_user_id,
        timestamp="",
        ori_event_id_list=[],
        group_id=group_id,
        user_name=extracted_user_name,
        output_reasoning=output_reasoning,
        motivation_system=motivation_values or None,
        fear_system=fear_values or None,
        value_system=value_system_values or None,
        humor_use=humor_values or None,
        life_habit_preference=life_habit_preference_values or None,
        communication_style=communication_style_values or None,
        catchphrase=catchphrase_values or None,
        user_to_friend_catchphrase=user_to_friend_catchphrase_values or None,
        user_to_friend_chat_style_preference=user_to_friend_chat_style_preference_values
        or None,
        way_of_decision_making=way_of_decision_values or None,
        traits=traits_values or None,
        personality=personality_values or None,
        occupation=occupation_values or None,
        gender=gender_value,
        age=age_value,
        education_level=education_level_value,
        relationship=relationship_values or None,
        intimacy_level=intimacy_level_value,
        intermediary_name=intermediary_name_value,
        intermediary_context=intermediary_context_value,
        interests=interests_values or None,
        risk_level=risk_level_value,
        warning_msg=warning_msg_value,
        type=RawDataType.CONVERSATION,
    )
def merge_single_profile(
    existing: ProfileMemory, new: ProfileMemory, *, group_id: str
) -> ProfileMemory:
    """Merge two ProfileMemory objects with the same user id."""
    merged_value_fields = _merge_value_fields(
        existing,
        new,
        field_names=(
            "motivation_system",
            "fear_system",
            "value_system",
            "humor_use",
            "life_habit_preference",
            "communication_style",
            "catchphrase",
            "user_to_friend_catchphrase",
            "user_to_friend_chat_style_preference",
            "way_of_decision_making",
            "traits",
            "personality",
            "occupation",
            "relationship",
            "interests",
        ),
    )

    def choose_single_field(
        new_value: Optional[Dict[str, Any]],
        existing_value: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        return _merge_single_field_with_pending_conflict(existing_value, new_value)

    output_reasoning = (
        new.output_reasoning
        if new.output_reasoning is not None
        else existing.output_reasoning
    )

    return ProfileMemory(
        memory_type=MemoryType.PROFILE,
        user_id=existing.user_id,
        timestamp=new.timestamp or existing.timestamp,
        ori_event_id_list=new.ori_event_id_list or existing.ori_event_id_list,
        user_name=new.user_name or existing.user_name,
        group_id=group_id or new.group_id or existing.group_id,
        output_reasoning=output_reasoning,
        motivation_system=merged_value_fields.get("motivation_system"),
        fear_system=merged_value_fields.get("fear_system"),
        value_system=merged_value_fields.get("value_system"),
        humor_use=merged_value_fields.get("humor_use"),
        life_habit_preference=merged_value_fields.get("life_habit_preference"),
        communication_style=merged_value_fields.get("communication_style"),
        catchphrase=merged_value_fields.get("catchphrase"),
        user_to_friend_catchphrase=merged_value_fields.get(
            "user_to_friend_catchphrase"
        ),
        user_to_friend_chat_style_preference=merged_value_fields.get(
            "user_to_friend_chat_style_preference"
        ),
        way_of_decision_making=merged_value_fields.get("way_of_decision_making"),
        traits=merged_value_fields.get("traits"),
        personality=merged_value_fields.get("personality"),
        occupation=merged_value_fields.get("occupation"),
        gender=choose_single_field(new.gender, existing.gender),
        age=choose_single_field(new.age, existing.age),
        education_level=choose_single_field(
            new.education_level, existing.education_level
        ),
        relationship=merged_value_fields.get("relationship"),
        intimacy_level=choose_single_field(new.intimacy_level, existing.intimacy_level),
        intermediary_name=new.intermediary_name or existing.intermediary_name,
        intermediary_context=new.intermediary_context or existing.intermediary_context,
        interests=merged_value_fields.get("interests"),
        risk_level=new.risk_level or existing.risk_level,
        warning_msg=new.warning_msg or existing.warning_msg,
        type=RawDataType.CONVERSATION,
    )
def merge_profiles(
    profile_memories: Iterable[ProfileMemory],
    participants_profile_list: Iterable[Dict[str, Any]],
    *,
    group_id: str,
    valid_conversation_ids: Optional[Set[str]] = None,
    conversation_date_map: Optional[Dict[str, str]] = None,
) -> List[ProfileMemory]:
    """Merge extracted profiles with existing participant profiles."""
    merged_dict: Dict[str, ProfileMemory] = {}

    for participant_profile in participants_profile_list:
        user_id = participant_profile.get("user_id")
        if not user_id:
            continue

        # Support both flat format and nested format (profile_data)
        profile_data = participant_profile.get("profile_data", {})
        flat_profile = {**participant_profile, **profile_data}  # profile_data overrides top-level

        profile_memory = ProfileMemory(
            memory_type=MemoryType.PROFILE,
            user_id=user_id,
            timestamp="",
            ori_event_id_list=[],
            group_id=group_id,
            user_name=flat_profile.get("user_name"),
            motivation_system=flat_profile.get("motivation_system"),
            fear_system=flat_profile.get("fear_system"),
            value_system=flat_profile.get("value_system"),
            humor_use=flat_profile.get("humor_use"),
            life_habit_preference=flat_profile.get("life_habit_preference"),
            communication_style=flat_profile.get("communication_style"),
            catchphrase=flat_profile.get("catchphrase"),
            user_to_friend_catchphrase=flat_profile.get(
                "user_to_friend_catchphrase"
            ),
            user_to_friend_chat_style_preference=flat_profile.get(
                "user_to_friend_chat_style_preference"
            ),
            way_of_decision_making=flat_profile.get("way_of_decision_making"),
            traits=flat_profile.get("traits"),
            personality=flat_profile.get("personality"),
            occupation=flat_profile.get("occupation"),
            gender=flat_profile.get("gender"),
            age=flat_profile.get("age"),
            education_level=flat_profile.get("education_level"),
            relationship=flat_profile.get("relationship"),
            intimacy_level=flat_profile.get("intimacy_level"),
            intermediary_name=flat_profile.get("intermediary_name"),
            intermediary_context=flat_profile.get("intermediary_context"),
            interests=flat_profile.get("interests"),
            risk_level=flat_profile.get("risk_level"),
            warning_msg=flat_profile.get("warning_msg"),
            type=RawDataType.CONVERSATION,
        )
        merged_dict[user_id] = profile_memory

    for new_profile in profile_memories:
        user_id = new_profile.user_id
        if user_id in merged_dict:
            existing_profile = merged_dict[user_id]
            merged_dict[user_id] = merge_single_profile(
                existing_profile, new_profile, group_id=group_id
            )
        else:
            merged_dict[user_id] = new_profile

    return list(merged_dict.values())


def _merge_value_fields(
    existing: ProfileMemory, new: ProfileMemory, *, field_names: Iterable[str]
) -> Dict[str, Optional[List[Dict[str, Any]]]]:
    """Merge multiple value-based fields and return a mapping.

    Uses merge_value_lists_with_evidence_level to preserve evidence_level and reasoning.
    """
    merged: Dict[str, Optional[List[Dict[str, Any]]]] = {}
    for field in field_names:
        merged[field] = merge_value_lists_with_evidence_level(
            getattr(existing, field, None), getattr(new, field, None)
        )
    return merged


__all__ = [
    "remove_evidences_from_profile",
    "accumulate_old_memory_entry",
    "profile_payload_to_memory",
    "merge_single_profile",
    "merge_profiles",
    "merge_value_lists_with_evidence_level",
]




