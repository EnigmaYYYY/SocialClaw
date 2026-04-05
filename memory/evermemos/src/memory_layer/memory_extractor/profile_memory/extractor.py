"""Profile memory extractor implementation."""

from __future__ import annotations

import asyncio
import ast
import json
import re
from datetime import datetime
from typing import AbstractSet, Any, Dict, List, Optional, Set

from core.observation.logger import get_logger

from memory_layer.llm.llm_provider import LLMProvider
from common_utils.logging_utils import (
    summarize_text,
    dump_llm_artifacts,
    dump_profile_llm_artifacts,
)

from memory_layer.prompts import get_prompt_by
from api_specs.memory_types import MemoryType, MemCell
from memory_layer.memory_extractor.profile_memory.conversation import (
    annotate_relative_dates,
    build_conversation_text,
    build_conversation_text_from_messages,
    build_raw_message_lines,
    build_raw_message_lines_from_messages,
    build_episode_text,
    build_profile_prompt,
    compute_catchphrase_candidates,
    extract_group_important_info,
    extract_user_mapping_from_memcells,
    is_important_to_user,
    merge_group_importance_evidence,
)
from memory_layer.memory_extractor.profile_memory.empty_evidence_completion import complete_missing_evidences
from memory_layer.memory_extractor.profile_memory.data_normalize import (
    accumulate_old_memory_entry,
    merge_profiles,
    profile_payload_to_memory,
    remove_evidences_from_profile,
)
from memory_layer.memory_extractor.profile_memory.evidence_utils import (
    remove_entries_without_evidence,
)
from memory_layer.memory_extractor.profile_memory.merger import convert_important_info_to_evidence
from memory_layer.memory_extractor.profile_memory.types import (
    GroupImportanceEvidence,
    ImportanceEvidence,
    ProfileMemory,
    ProfileMemoryExtractRequest,
)
from memory_layer.memory_extractor.base_memory_extractor import (
    MemoryExtractor,
    MemoryExtractRequest,
)

logger = get_logger(__name__)


class ProfileMemoryExtractor(MemoryExtractor):
    """Extractor for user profile information from conversations."""

    _conversation_date_map: Dict[str, str] = {}

    def __init__(self, llm_provider: LLMProvider | None = None):
        super().__init__(MemoryType.PROFILE)
        self.llm_provider = llm_provider

    async def extract_memory(
        self, request: ProfileMemoryExtractRequest
    ) -> Optional[List[ProfileMemory]]:
        """Extract profile memories from conversation memcells."""
        if not request.memcell_list:
            return None

        self.__class__._conversation_date_map = {}

        # Determine raw message source: prefer raw_messages, fallback to memcell extraction
        all_raw_messages: List[Dict[str, Any]] = []
        if request.raw_messages:
            # Use directly provided raw messages
            all_raw_messages = request.raw_messages
        else:
            # Fallback: extract from memcells
            for memcell in request.memcell_list:
                original_data = getattr(memcell, "original_data", []) or []
                all_raw_messages.extend(original_data)

        # Extract complete user_id to user_name mapping
        if request.raw_messages:
            # Extract from raw messages
            user_id_to_name = {}
            for msg in all_raw_messages:
                speaker_id = str(msg.get("speaker_id", "")).strip()
                speaker_name = msg.get("speaker_name", "")
                if speaker_id and speaker_name and speaker_id not in user_id_to_name:
                    user_id_to_name[speaker_id] = speaker_name
        else:
            # Extract from memcells (legacy)
            user_id_to_name = extract_user_mapping_from_memcells(
                request.memcell_list, old_memory_list=request.old_memory_list
            )

        # Build compact conversation lines from the aggregated raw message stream so
        # conversation_id / participants headers are declared only once.
        raw_message_lines: List[str] = []
        all_conversation_text: List[str] = []

        # Build conversation text once (prefer raw_messages if available)
        if all_raw_messages:
            raw_message_lines = build_raw_message_lines_from_messages(
                all_raw_messages, user_id_to_name
            )
            conversation_text = build_conversation_text_from_messages(
                all_raw_messages, user_id_to_name
            )
            if conversation_text:
                all_conversation_text.append(conversation_text)
        else:
            # No raw_messages, extract from memcells
            for memcell in request.memcell_list:
                raw_message_lines.extend(
                    build_raw_message_lines(memcell, user_id_to_name)
                )
                conversation_text, _ = build_conversation_text(memcell, user_id_to_name)
                if conversation_text:
                    all_conversation_text.append(conversation_text)

        conversation_date_map = self.__class__._conversation_date_map
        all_episode_text: List[str] = []
        valid_conversation_ids: Set[str] = set()
        conversation_participants_map: Dict[str, Optional[AbstractSet[str]]] = {}

        # Extract metadata from memcells (conversation_text already added above)
        if not request.raw_messages:
            for memcell in request.memcell_list:
                # Get conversation_id from memcell
                conversation_id = getattr(memcell, "group_id", None) or getattr(memcell, "event_id", None)

                # episode_text, episode_id = build_episode_text(memcell, user_id_to_name)
                # all_episode_text.append(episode_text)

                timestamp_value = getattr(memcell, "timestamp", None)
                dt_value = self._parse_timestamp(timestamp_value)
                if dt_value is None:
                    msg_timestamp = self._extract_first_message_timestamp(memcell)
                    if msg_timestamp is not None:
                        dt_value = self._parse_timestamp(msg_timestamp)
                date_str: Optional[str] = None
                if dt_value:
                    date_str = dt_value.date().isoformat()

                event_id_raw = getattr(memcell, "event_id", None)
                event_id_str = str(event_id_raw) if event_id_raw is not None else None
                participants_raw = getattr(memcell, "participants", None)
                participants_set: Optional[AbstractSet[str]] = None
                if participants_raw:
                    normalized_participants = {
                        str(participant).strip()
                        for participant in participants_raw
                        if str(participant).strip()
                    }
                    if normalized_participants:
                        participants_set = frozenset(normalized_participants)

                if event_id_str is not None:
                    conversation_participants_map[event_id_str] = participants_set

                if conversation_id:
                    valid_conversation_ids.add(conversation_id)
                    if date_str:
                        conversation_date_map.setdefault(conversation_id, date_str)
                    # Also map by conversation_id (group_id) for evidence validation
                    if participants_set is not None and conversation_id not in conversation_participants_map:
                        conversation_participants_map[conversation_id] = participants_set
                if event_id_str:
                    valid_conversation_ids.add(event_id_str)
                    if date_str:
                        conversation_date_map.setdefault(event_id_str, date_str)
        else:
            # Extract metadata from raw messages
            for msg in all_raw_messages:
                conversation_id = msg.get("conversation_id")
                if conversation_id:
                    conversation_id_str = str(conversation_id)
                    valid_conversation_ids.add(conversation_id_str)

                    # Extract date from timestamp
                    timestamp = msg.get("timestamp")
                    if timestamp:
                        dt_value = self._parse_timestamp(timestamp)
                        if dt_value:
                            date_str = dt_value.date().isoformat()
                            conversation_date_map.setdefault(conversation_id_str, date_str)

                    # Collect participants for this conversation_id
                    speaker_id = msg.get("speaker_id")
                    if speaker_id:
                        speaker_id_str = str(speaker_id).strip()
                        if speaker_id_str:
                            if conversation_id_str not in conversation_participants_map:
                                conversation_participants_map[conversation_id_str] = set()
                            conversation_participants_map[conversation_id_str].add(speaker_id_str)

        # Debug: log valid_conversation_ids and conversation_date_map
        logger.debug(
            "Profile extraction metadata: valid_conversation_ids=%s, conversation_date_map_keys=%s, raw_messages_count=%d",
            list(valid_conversation_ids) if valid_conversation_ids else [],
            list(conversation_date_map.keys()) if conversation_date_map else [],
            len(all_raw_messages),
        )

        resolved_group_id = request.group_id
        if not resolved_group_id:
            for memcell in request.memcell_list:
                candidate_group_id = getattr(memcell, "group_id", None)
                if candidate_group_id:
                    resolved_group_id = candidate_group_id
                    break
        resolved_group_id = resolved_group_id or ""

        participants_profile_list: List[Dict[str, Any]] = []
        participants_profile_list_for_prompt: List[Dict[str, Any]] = []
        participants_base_memory_map: Dict[str, Dict[str, Any]] = {}

        if request.old_memory_list:
            for mem in request.old_memory_list:
                # Allow raw dict payloads from storage
                if isinstance(mem, dict):
                    mem_type = mem.get("memory_type")
                    if mem_type in (MemoryType.PROFILE, MemoryType.PROFILE.value) or mem.get("user_id"):
                        participants_profile_list.append(mem)
                        participants_profile_list_for_prompt.append(
                            remove_evidences_from_profile(mem)
                        )
                    elif mem_type in (MemoryType.BASE_MEMORY, MemoryType.BASE_MEMORY.value):
                        base_memory_obj: Dict[str, Any] = {"user_id": mem.get("user_id")}
                        if mem.get("base_location"):
                            base_memory_obj["base_location"] = mem.get("base_location")
                        if base_memory_obj.get("user_id") and len(base_memory_obj) > 1:
                            participants_base_memory_map[base_memory_obj["user_id"]] = base_memory_obj
                    continue

                if mem.memory_type == MemoryType.PROFILE:
                    accumulate_old_memory_entry(mem, participants_profile_list)
                    if participants_profile_list:
                        profile_obj_for_prompt = remove_evidences_from_profile(
                            participants_profile_list[-1]
                        )
                        participants_profile_list_for_prompt.append(
                            profile_obj_for_prompt
                        )
                elif mem.memory_type == MemoryType.BASE_MEMORY:
                    base_memory_obj: Dict[str, Any] = {"user_id": mem.user_id}

                    if getattr(mem, "base_location", None):
                        base_memory_obj["base_location"] = getattr(
                            mem, "base_location", None
                        )

                    if len(base_memory_obj) > 1:
                        participants_base_memory_map[mem.user_id] = base_memory_obj

        participants_payload: List[Dict[str, Any]] = []
        seen_participants: Set[str] = set()
        participant_source = request.user_id_list or list(user_id_to_name.keys())
        for raw_id in participant_source:
            user_id = str(raw_id).strip()
            if not user_id or user_id in seen_participants:
                continue
            seen_participants.add(user_id)
            participants_payload.append(
                {
                    "user_id": user_id,
                    "user_name": user_id_to_name.get(user_id, ""),
                }
            )
        if request.owner_user_id and request.owner_user_id not in seen_participants:
            participants_payload.append(
                {
                    "user_id": request.owner_user_id,
                    "user_name": user_id_to_name.get(request.owner_user_id, ""),
                }
            )

        def build_participants_current_profiles_payload() -> List[Dict[str, Any]]:
            """Normalize existing profiles to the prompt contract:
            [{"user_id": "...", "profile_data": {...}}, ...]
            """
            def normalize_prompt_profile_data(
                profile_data: Dict[str, Any], user_name: str
            ) -> Dict[str, Any]:
                default_profile_data: Dict[str, Any] = {
                    "user_name": user_name,
                    "social_role": "unknown",
                    "gender": None,
                    "age": None,
                    "education_level": None,
                    "intimacy_level": {
                        "value": "stranger",
                        "evidence_level": "L2",
                        "evidences": [],
                    },
                    "occupation": [],
                    "relationship": [],
                    "personality": [],
                    "traits": [],
                    "interests": [],
                    "way_of_decision_making": [],
                    "life_habit_preference": [],
                    "communication_style": [],
                    "catchphrase": [],
                    "user_to_friend_catchphrase": [],
                    "user_to_friend_chat_style": [],
                    "motivation_system": [],
                    "fear_system": [],
                    "value_system": [],
                    "humor_use": [],
                    "intermediary_name": "",
                    "intermediary_context": "",
                    "risk_level": "",
                    "warning_msg": "",
                }

                normalized = dict(default_profile_data)
                normalized.update(profile_data or {})
                if not normalized.get("user_name"):
                    normalized["user_name"] = user_name

                # Keep backward compatibility for legacy field naming.
                if (
                    not normalized.get("user_to_friend_chat_style")
                    and normalized.get("user_to_friend_chat_style_preference")
                ):
                    normalized["user_to_friend_chat_style"] = normalized.get(
                        "user_to_friend_chat_style_preference"
                    )

                intimacy_level = normalized.get("intimacy_level")
                if isinstance(intimacy_level, dict):
                    intimacy_level.setdefault("value", "stranger")
                    intimacy_level.setdefault("evidence_level", "L2")
                    intimacy_level.setdefault("evidences", [])
                elif not intimacy_level:
                    normalized["intimacy_level"] = {
                        "value": "stranger",
                        "evidence_level": "L2",
                        "evidences": [],
                    }

                return normalized

            excluded_meta_fields = {
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
                "version",
                "created_at",
                "updated_at",
                "memcell_count",
                "last_updated_cluster",
                "metadata",
                "retrieval",
                "profile_id",
                "profile_type",
                "owner_user_id",
                "target_user_id",
                "aliases",
            }
            by_user_id: Dict[str, Dict[str, Any]] = {}

            for raw_profile in participants_profile_list_for_prompt:
                if not isinstance(raw_profile, dict):
                    continue
                profile_user_id = str(raw_profile.get("user_id", "")).strip()
                if not profile_user_id:
                    continue

                # Build a complete business profile_data by merging top-level fields
                # and nested profile_data, while dropping meta/system fields.
                profile_data = {
                    key: value
                    for key, value in raw_profile.items()
                    if key not in excluded_meta_fields and key not in {"user_id", "profile_data"}
                }
                nested_profile_data = raw_profile.get("profile_data")
                if isinstance(nested_profile_data, dict):
                    for key, value in nested_profile_data.items():
                        if key in excluded_meta_fields:
                            continue
                        profile_data[key] = value

                if not profile_data.get("user_name"):
                    profile_data["user_name"] = user_id_to_name.get(
                        profile_user_id, ""
                    )

                by_user_id[profile_user_id] = {
                    "user_id": profile_user_id,
                    "profile_data": normalize_prompt_profile_data(
                        profile_data,
                        user_id_to_name.get(profile_user_id, ""),
                    ),
                }

            for participant in participants_payload:
                participant_user_id = str(participant.get("user_id", "")).strip()
                if not participant_user_id:
                    continue

                if participant_user_id not in by_user_id:
                    by_user_id[participant_user_id] = {
                        "user_id": participant_user_id,
                        "profile_data": normalize_prompt_profile_data(
                            {},
                            participant.get("user_name", ""),
                        ),
                    }

                profile_data = by_user_id[participant_user_id].setdefault(
                    "profile_data", {}
                )
                by_user_id[participant_user_id][
                    "profile_data"
                ] = normalize_prompt_profile_data(
                    profile_data,
                    participant.get("user_name", ""),
                )

            return list(by_user_id.values())

        participants_current_profiles_payload = (
            build_participants_current_profiles_payload()
        )

        # Build profile prompt (get via PromptManager)
        prompt_part1 = build_profile_prompt(
            get_prompt_by("CONVERSATION_PROFILE_PART1_EXTRACTION_PROMPT"),
            all_conversation_text,
            participants_current_profiles_payload,
            participants_base_memory_map,
            request,
            participants=participants_payload,
        )
        # Compute catchphrase candidates from raw messages
        catchphrase_candidates = compute_catchphrase_candidates(all_raw_messages)
        if catchphrase_candidates:
            candidate_lines = []
            for uid, candidates in catchphrase_candidates.items():
                uname = user_id_to_name.get(uid, uid)
                items = ", ".join(f'"{p}"({c}次)' for p, c in candidates)
                candidate_lines.append(f"{uname}(user_id:{uid}): {items}")
            prompt_part1 += (
                "\n\n### CATCHPHRASE_CANDIDATES (频次预统计)\n"
                "以下是各用户高频短语的统计结果（频次降序）。"
                "请从中判断哪些具有个性特征（真正的口头禅），排除普通词汇（如'好的'、'嗯'、'是'、'哈哈'等通用词）。\n"
                "- 对于好友（user_id != owner_user_id）的 profile：将好友的口头禅填入 catchphrase 字段，将 owner 的口头禅填入 owner_catchphrase 字段\n"
                "- 对于 owner 自己的 profile：将 owner 的口头禅填入 catchphrase 字段\n"
                "不要直接照搬全部候选，仅填入确认为真正口头禅的项。\n"
                + "\n".join(candidate_lines)
            )

        def build_repair_prompt(raw_response: str) -> str:
            old_profiles_json = json.dumps(
                participants_current_profiles_payload, ensure_ascii=False
            )
            participants_json = json.dumps(participants_payload, ensure_ascii=False)
            return (
                "You are repairing a malformed profile extraction response.\n"
                "Rewrite the NEW_PROFILE_RESPONSE into a single valid fenced JSON block matching the target schema.\n"
                "Preserve only information supported by the new response or the existing profiles below.\n"
                "Do not invent new participants. Keep only users listed in PARTICIPANTS.\n"
                "Use EXISTING_PROFILES to normalize field names and keep prior stable values when needed.\n"
                "Output exactly one ```json ... ``` block and no extra text.\n\n"
                f"PARTICIPANTS:\n{participants_json}\n\n"
                f"EXISTING_PROFILES:\n{old_profiles_json}\n\n"
                f"NEW_PROFILE_RESPONSE:\n{raw_response}"
            )

        # Define async LLM invocation function
        async def invoke_llm(
            prompt: str, part_label: str
        ) -> Optional[List[Dict[str, Any]]]:
            extraction_attempts = 2
            response: Optional[str] = None
            parsed_profiles: Optional[List[Dict[str, Any]]] = None
            last_valid_response: Optional[str] = None  # Track last non-None response for repair

            if self.llm_provider is None:
                logger.warning(
                    "Skip %s profile extraction because llm_provider is unavailable",
                    part_label,
                )
                return None

            for attempt in range(extraction_attempts):
                try:
                    logger.info(
                        f"Starting {attempt+1} time {part_label} profile extraction"
                    )
                    print(f"🌸🌸🌸 [Profile] {part_label} prompt (attempt {attempt+1}):\n{prompt}")
                    response = await self.llm_provider.generate(prompt, temperature=0.3)
                    print(f"🌸🌸🌸 [Profile] {part_label} response (attempt {attempt+1}):\n{response}")
                    dump_profile_llm_artifacts(
                        f"profile_{part_label.replace(' ', '_')}",
                        prompt=prompt,
                        response=response,
                        meta={"attempt": attempt + 1},
                    )
                    # Cannot batch convert relative dates anymore, because offline processing handles more than one day's data at once
                    annotated_response = response
                    parsed_profiles = self._extract_user_profiles_from_response(
                        annotated_response, part_label, prompt=prompt
                    )
                    logger.info(
                        "[Profile] profile.parse_success part=%s attempt=%s",
                        part_label,
                        attempt + 1,
                    )
                    break
                except Exception as exc:
                    logger.warning(
                        "[Profile] profile.parse_failure part=%s attempt=%s/%s error=%s",
                        part_label,
                        attempt + 1,
                        extraction_attempts,
                        exc,
                    )
                    logger.warning(
                        "%s context (attempt %s): prompt_len=%s response_len=%s",
                        part_label,
                        attempt + 1,
                        len(prompt) if prompt else 0,
                        len(response) if response else 0,
                    )
                    if prompt:
                        logger.warning(
                            "%s prompt preview (attempt %s): %s",
                            part_label,
                            attempt + 1,
                            summarize_text(prompt, 800),
                        )
                    if response:
                        logger.warning(
                            "%s response preview (attempt %s): %s",
                            part_label,
                            attempt + 1,
                            summarize_text(response, 800),
                        )

                    if attempt < extraction_attempts - 1:
                        # Keep last_response for repair even if we reset for retry
                        if response is not None:
                            last_valid_response = response
                        response = None
                        parsed_profiles = None
                        continue

                    # Use the most recent non-None response for repair.
                    # If we never got any LLM output, skip repair entirely.
                    repair_input = response or last_valid_response
                    if not repair_input:
                        logger.warning(
                            "%s no LLM response available for repair, skipping repair",
                            part_label,
                        )
                        return None

                    repair_prompt = build_repair_prompt(repair_input)

                    try:
                        logger.info(
                            "[Profile] profile.repair_start part=%s repair_input_len=%s",
                            part_label,
                            len(repair_input),
                        )
                        print(f"🌸🌸🌸 [Profile] {part_label} repair prompt:\n{repair_prompt}")
                        response = await self.llm_provider.generate(
                            repair_prompt, temperature=0
                        )
                        print(f"🌸🌸🌸 [Profile] {part_label} repair response:\n{response}")
                        dump_profile_llm_artifacts(
                            f"profile_{part_label.replace(' ', '_')}_repair",
                            prompt=repair_prompt,
                            response=response,
                            meta={"attempt": attempt + 1},
                        )
                        # Cannot batch convert relative dates anymore, because offline processing handles more than one day's data at once
                        annotated_response = response
                        parsed_profiles = self._extract_user_profiles_from_response(
                            annotated_response, part_label, prompt=prompt
                        )
                        logger.info(
                            "[Profile] profile.repair_success part=%s",
                            part_label,
                        )
                    except Exception as repair_exc:
                        logger.error(
                            "[Profile] profile.repair_failure part=%s error=%s",
                            part_label,
                            repair_exc,
                        )
                        logger.error(
                            "[Profile] profile.repair_failure context: prompt_len=%s response_len=%s",
                            len(repair_prompt),
                            len(response) if response else 0,
                        )
                        if response:
                            logger.error(
                                "%s repair response preview: %s",
                                part_label,
                                summarize_text(response, 800),
                            )
                        return None

                    break

            return parsed_profiles

        # Invoke profile extraction
        profiles_part1 = await invoke_llm(prompt_part1, "profile part")

        # Merge results
        if not profiles_part1:
            logger.warning("Profile extraction returned no profiles")
            return None

        def _normalize_profile_payload(profile_obj: Dict[str, Any]) -> Dict[str, Any]:
            list_fields = [
                "traits",
                "personality",  # Keep for backward compatibility
                "way_of_decision_making",
                "interests",
                "life_habit_preference",
                "communication_style",
                "catchphrase",
                "user_to_friend_catchphrase",
                "motivation_system",
                "fear_system",
                "value_system",
                "humor_use",
                "user_to_friend_chat_style",
                "user_to_friend_chat_style_preference",  # Keep for backward compatibility
                "personality",
                "occupation",  # Changed to list field
                "relationship",  # Changed to list field
            ]
            scalar_fields = [
                "gender",
                "age",
                "education_level",
                "intimacy_level",
            ]
            string_fields = [
                "intermediary_name",
                "intermediary_context",
                "risk_level",
                "warning_msg",
            ]
            if "output_reasoning" not in profile_obj or profile_obj.get("output_reasoning") is None:
                profile_obj["output_reasoning"] = ""
            for field in list_fields:
                value = profile_obj.get(field)
                if value is None:
                    profile_obj[field] = []
            for field in scalar_fields:
                value = profile_obj.get(field)
                if value is None:
                    profile_obj[field] = ""
            for field in string_fields:
                if field not in profile_obj:
                    profile_obj[field] = ""
            return profile_obj

        # Use pre-extracted user_id_to_name mapping for validation
        participant_user_ids: Set[str] = set(user_id_to_name.keys())
        if request.user_id_list:
            participant_user_ids.update(
                {str(uid).strip() for uid in request.user_id_list if str(uid).strip()}
            )
        # Ensure owner_user_id is included in participant_user_ids
        if request.owner_user_id:
            participant_user_ids.add(str(request.owner_user_id).strip())
        participants_by_id: Dict[str, Dict[str, Any]] = {
            p["user_id"]: p for p in participants_payload if p.get("user_id")
        }

        if profiles_part1 and participants_payload and len(profiles_part1) == len(participants_payload):
            for idx, profile in enumerate(profiles_part1):
                if not isinstance(profile, dict):
                    continue
                target = participants_payload[idx]
                profile["user_id"] = target.get("user_id", profile.get("user_id", ""))
                if target.get("user_name"):
                    profile["user_name"] = target.get("user_name")

        part1_map: Dict[str, Dict[str, Any]] = {}
        name_to_user_ids: Dict[str, Set[str]] = {}
        for uid, uname in user_id_to_name.items():
            if not uname:
                continue
            name_to_user_ids.setdefault(uname, set()).add(uid)
        owner_name = user_id_to_name.get(request.owner_user_id, "") if request.owner_user_id else ""
        if profiles_part1:
            for profile in profiles_part1:
                if not isinstance(profile, dict):
                    continue
                profile = _normalize_profile_payload(profile)
                user_id = str(profile.get("user_id", "")).strip()
                user_name = str(profile.get("user_name", "")).strip()

                # If user_id is missing or invalid, try to recover from user_name
                if not user_id or (participant_user_ids and user_id not in participant_user_ids):
                    recovered_id = None
                    if owner_name and user_name and user_name == owner_name:
                        recovered_id = request.owner_user_id
                    elif user_name:
                        candidates = name_to_user_ids.get(user_name, set())
                        if len(candidates) == 1:
                            recovered_id = next(iter(candidates))
                    if recovered_id:
                        user_id = recovered_id
                        profile["user_id"] = recovered_id
                    else:
                        logger.info(
                            "LLM returned invalid user_id '%s' (name='%s') in part1; skipping profile",
                            profile.get("user_id"),
                            user_name,
                        )
                        continue

                # Validate user_id against participants_profile_list
                if participant_user_ids and user_id not in participant_user_ids:
                    logger.debug(
                        "LLM returned user_id %s not found in participants_profile_list; skipping profile",
                        user_id,
                    )
                    continue
                part1_map[user_id] = profile

        if participants_by_id:
            for user_id, meta in participants_by_id.items():
                if participant_user_ids and user_id not in participant_user_ids:
                    continue
                if user_id not in part1_map:
                    part1_map[user_id] = _normalize_profile_payload(
                        {
                            "user_id": user_id,
                            "user_name": meta.get("user_name", ""),
                            "output_reasoning": "",
                        }
                    )
                elif meta.get("user_name") and not part1_map[user_id].get("user_name"):
                    part1_map[user_id]["user_name"] = meta.get("user_name")

        combined_user_ids = set(participants_by_id) if participants_by_id else set(part1_map)
        if not combined_user_ids:
            logger.warning("No valid user_ids found in combined results")
            return None

        user_profiles_data: List[Dict[str, Any]] = []
        for user_id in combined_user_ids:
            combined_profile: Dict[str, Any] = {"user_id": user_id}
            user_name = ""
            if user_id in part1_map and part1_map[user_id].get("user_name"):
                user_name = str(part1_map[user_id].get("user_name", "")).strip()
            elif user_id in participants_by_id and participants_by_id[user_id].get("user_name"):
                user_name = str(participants_by_id[user_id].get("user_name", "")).strip()
            elif user_id_to_name.get(user_id):
                user_name = str(user_id_to_name.get(user_id, "")).strip()
            if user_name:
                combined_profile["user_name"] = user_name

            # Merge part1 data (personal attributes: opinion_tendency, personality, way_of_decision_making)
            if user_id in part1_map:
                part1_profile = part1_map[user_id]
                for key, value in part1_profile.items():
                    if key != "user_id":
                        combined_profile[key] = value

            combined_profile = _normalize_profile_payload(combined_profile)

            user_profiles_data.append(combined_profile)

        # Filter out profiles with all key fields empty
        filtered_profiles_data: List[Dict[str, Any]] = []
        key_fields = [
            "output_reasoning",
            "motivation_system",
            "fear_system",
            "value_system",
            "humor_use",
            "life_habit_preference",
            "communication_style",
            "catchphrase",
            "user_to_friend_catchphrase",
            "user_to_friend_chat_style",
            "way_of_decision_making",
            "traits",
            "personality",
            "occupation",
            "gender",
            "age",
            "education_level",
            "relationship",
            "intimacy_level",
            "intermediary_name",
            "intermediary_context",
            "interests",
            "risk_level",
            "warning_msg",
        ]

        if participants_by_id:
            filtered_profiles_data = list(user_profiles_data)
        else:
            for profile_data in user_profiles_data:
                # Check if at least one key field has non-empty value
                has_valid_data = False
                for field in key_fields:
                    value = profile_data.get(field)
                    if value:  # Non-empty list/string/dict
                        has_valid_data = True
                        break

                if has_valid_data:
                    filtered_profiles_data.append(profile_data)
                else:
                    logger.debug(
                        "Filtering out profile for user %s: all key fields are empty",
                        profile_data.get("user_id"),
                    )

        await complete_missing_evidences(
            filtered_profiles_data,
            conversation_lines=all_conversation_text,
            valid_conversation_ids=valid_conversation_ids,
            conversation_participants_map=conversation_participants_map,
            conversation_date_map=conversation_date_map,
            llm_provider=self.llm_provider,
            parse_payload=self._parse_profile_response_payload,
        )
        for profile_data in filtered_profiles_data:
            remove_entries_without_evidence(profile_data)

        profile_memories: List[ProfileMemory] = []
        for profile_data in filtered_profiles_data:
            if not isinstance(profile_data, dict):
                continue

            profile_memory = profile_payload_to_memory(
                profile_data,
                group_id=resolved_group_id,
                valid_conversation_ids=valid_conversation_ids,
                conversation_date_map=conversation_date_map,
                valid_user_ids=participant_user_ids,
                user_id_to_name=user_id_to_name,
            )
            if profile_memory:
                profile_memories.append(profile_memory)

        merged_profiles = merge_profiles(
            profile_memories,
            participants_profile_list,
            group_id=resolved_group_id,
            valid_conversation_ids=valid_conversation_ids,
            conversation_date_map=conversation_date_map,
        )

        important_info = extract_group_important_info(
            request.memcell_list, request.group_id
        )
        new_evidence_list = convert_important_info_to_evidence(important_info)
        for profile in merged_profiles:
            old_evidence: Optional[GroupImportanceEvidence] = (
                profile.group_importance_evidence
            )
            new_evidence = merge_group_importance_evidence(
                old_evidence, new_evidence_list, user_id=profile.user_id
            )
            if new_evidence:
                new_evidence.is_important = is_important_to_user(
                    new_evidence.evidence_list
                )
                profile.group_importance_evidence = new_evidence

        return merged_profiles

    def _extract_user_profiles_from_response(
        self,
        response: str,
        part_label: str,
        *,
        prompt: Optional[str] = None,
    ) -> Optional[List[Dict[str, Any]]]:
        """Extract user profiles from LLM response."""
        try:
            data = self._parse_profile_response_payload(response)
            user_profiles = data.get("user_profiles", [])
            if not user_profiles:
                logger.info(f"No user profiles found in {part_label}")
                return None
            return user_profiles
        except Exception as exc:
            logger.error(f"Failed to parse {part_label} llm response: {exc}")
            if response:
                logger.error(
                    "%s llm response preview: %s",
                    part_label,
                    summarize_text(response, 800),
                )
            artifact_path = dump_llm_artifacts(
                f"profile_{part_label}",
                prompt=prompt,
                response=response,
                meta={"error": str(exc)},
            )
            if artifact_path:
                logger.error(
                    "%s llm parse artifact saved: %s", part_label, artifact_path
                )
            return None

    @staticmethod
    def _parse_timestamp(timestamp: Any) -> Optional[datetime]:
        if isinstance(timestamp, datetime):
            return timestamp
        if isinstance(timestamp, (int, float)):
            return datetime.fromtimestamp(timestamp)
        if isinstance(timestamp, str):
            ts_value = timestamp.strip()
            iso_timestamp = (
                ts_value.replace("Z", "+00:00") if ts_value.endswith("Z") else ts_value
            )
            try:
                return datetime.fromisoformat(iso_timestamp)
            except ValueError:
                return None
        return None

    @staticmethod
    def _extract_first_message_timestamp(memcell: MemCell) -> Optional[Any]:
        """Return the first available timestamp from a memcell's original data."""
        for message in getattr(memcell, "original_data", []) or []:
            if hasattr(message, "content"):
                ts_value = message.content.get("timestamp")
            else:
                ts_value = message.get("timestamp")
            if ts_value:
                return ts_value
        return None

    @staticmethod
    def _parse_profile_response_payload(response: str) -> Dict[str, Any]:
        """Best-effort JSON extraction from LLM responses with optional markdown fences."""
        if not response:
            raise ValueError("empty response")

        json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", response, re.DOTALL)
        if json_match:
            return json.loads(json_match.group(1))

        parsed = ast.literal_eval(response)
        if isinstance(parsed, dict):
            return parsed
        elif isinstance(parsed, list):
            return {"user_profiles": parsed}
        return json.loads(parsed)

    async def extract_profile_companion(
        self, request: ProfileMemoryExtractRequest
    ) -> Optional[List[ProfileMemory]]:
        """Extract companion profile memories using Part3 prompts (90 personality dimensions).

        This function analyzes conversation memcells to extract comprehensive personality profiles
        based on 90 dimensions including psychological traits, AI alignment preferences,
        and content platform interests.

        Args:
            request: ProfileMemoryExtractRequest containing memcells and optional old memories

        Returns:
            Optional[List[ProfileMemory]]: List of extracted profile memories with 90-dimension analysis,
                                           or None if extraction failed
        """
        if not request.memcell_list:
            logger.warning(
                "[ProfileMemoryExtractor] No memcells provided for companion extraction"
            )
            print(f"[ProfileExtractor] ❌ memcell_list is empty")
            return None

        print(f"[ProfileExtractor] Received {len(request.memcell_list)} MemCells")
        print(f"[ProfileExtractor] request.user_id_list: {request.user_id_list}")
        print(f"[ProfileExtractor] request.group_id: {request.group_id}")

        # Extract user mapping from memcells and build conversation text
        user_id_to_name = extract_user_mapping_from_memcells(request.memcell_list)
        print(
            f"[ProfileExtractor] user_id_to_name (extracted from original_data): {user_id_to_name}"
        )

        # 🔧 If user_id_to_name is empty, extract from participants field
        if not user_id_to_name:
            print(
                f"[ProfileExtractor] user_id_to_name is empty, attempting to extract from participants"
            )
            for memcell in request.memcell_list:
                participants = getattr(memcell, "participants", None)
                if participants and isinstance(participants, list):
                    for user_id in participants:
                        if user_id and user_id not in user_id_to_name:
                            user_id_to_name[user_id] = (
                                user_id  # Use user_id as default name
                            )
                    print(
                        f"[ProfileExtractor] Extracted from participants: {list(participants)}"
                    )

        # 🔧 If still empty, use request.user_id_list
        if not user_id_to_name and request.user_id_list:
            print(f"[ProfileExtractor] Still empty, using request.user_id_list")
            for user_id in request.user_id_list:
                user_id_to_name[user_id] = user_id

        print(f"[ProfileExtractor] Final user_id_to_name: {user_id_to_name}")
        # Build conversation text from all memcells
        conversation_lines: List[str] = []
        user_profiles: Dict[str, Dict[str, Any]] = (
            {}
        )  # user_id -> {name, message_count}

        # Build evidence maps (date per conversation/event id) for evidences binding
        conversation_date_map: Dict[str, str] = {}
        valid_conversation_ids: Set[str] = set()
        default_date: Optional[str] = None

        for memcell in request.memcell_list:
            # 🔧 Directly use episode, because original_data is often empty
            episode_text, event_id = build_episode_text(memcell, user_id_to_name)

            if episode_text:
                conversation_lines.append(episode_text)
                print(f"[ProfileExtractor] Using episode_text: {episode_text[:200]}...")
                conversation_id = event_id
            else:
                print(
                    f"[ProfileExtractor] ⚠️  episode is empty, trying conversation_text fallback"
                )
                # Fallback: try conversation_text
                conversation_text, conversation_id = build_conversation_text(
                    memcell, user_id_to_name
                )
                if conversation_text and conversation_text.strip():
                    conversation_lines.append(conversation_text)
                    print(
                        f"[ProfileExtractor] Using conversation_text: {conversation_text[:200]}..."
                    )
                else:
                    print(
                        f"[ProfileExtractor] ❌ Both episode and conversation_text are empty!"
                    )

            # Collect user statistics
            # 🔧 Only count users in request.user_id_list (already filtered robot/assistant)
            target_user_ids = (
                set(request.user_id_list)
                if request.user_id_list
                else set(user_id_to_name.keys())
            )
            for user_id in user_id_to_name.keys():
                # 🔧 Only process users in the target user list
                if user_id not in target_user_ids:
                    continue

                if user_id not in user_profiles:
                    user_profiles[user_id] = {
                        "user_id": user_id,
                        "user_name": user_id_to_name.get(user_id, "Unknown"),
                        "message_count": 0,
                    }
                user_profiles[user_id]["message_count"] += 1

            # Evidence date mapping
            timestamp_value = getattr(memcell, "timestamp", None)
            dt_value = self._parse_timestamp(timestamp_value)
            if dt_value is None:
                msg_timestamp = self._extract_first_message_timestamp(memcell)
                if msg_timestamp is not None:
                    dt_value = self._parse_timestamp(msg_timestamp)
            date_str: Optional[str] = None
            if dt_value:
                date_str = dt_value.date().isoformat()
                default_date = date_str

            if conversation_id:
                valid_conversation_ids.add(conversation_id)
                if date_str:
                    conversation_date_map.setdefault(conversation_id, date_str)
            event_id = getattr(memcell, "event_id", None)
            if event_id:
                event_id_str = str(event_id)
                valid_conversation_ids.add(event_id_str)
                if date_str:
                    conversation_date_map.setdefault(event_id_str, date_str)

        if not conversation_lines:
            logger.warning(
                "[ProfileMemoryExtractor] No conversation text to analyze for companion profiles"
            )
            print(f"[ProfileExtractor] ❌ conversation_lines is empty")
            return None

        conversation_text = "\n".join(conversation_lines)
        print(
            f"[ProfileExtractor] conversation_text length: {len(conversation_text)} characters"
        )
        print(f"[ProfileExtractor] user_profiles: {user_profiles}")
        logger.info(
            f"[ProfileMemoryExtractor] Built companion conversation with {len(conversation_lines)} segments"
        )
        logger.info(
            f"[ProfileMemoryExtractor] Found {len(user_profiles)} unique users for companion analysis"
        )

        # Retrieve old profile information if available
        old_profiles_map: Dict[str, ProfileMemory] = {}
        if request.old_memory_list:
            for mem in request.old_memory_list:
                if mem.memory_type == MemoryType.PROFILE and hasattr(mem, 'user_id'):
                    old_profiles_map[mem.user_id] = mem

        # Extract Part3 profiles for each user (🚀 parallelize LLM calls)
        companion_profiles: List[ProfileMemory] = []

        # Define single-user extraction function
        async def extract_single_user_companion_profile(
            user_id: str, user_info: Dict[str, Any]
        ) -> List[ProfileMemory]:
            """Extract companion profile for a single user (parallelized)"""
            if self.llm_provider is None:
                logger.warning(
                    "Skip companion profile extraction for %s because llm_provider is unavailable",
                    user_info.get("user_name", user_id),
                )
                return []
            print(
                f"[ProfileExtractor] Starting to extract Profile for user {user_info['user_name']} (user_id={user_id})"
            )
            logger.info(
                f"[ProfileMemoryExtractor] Analyzing companion profile for: {user_info['user_name']} "
                f"({user_info['message_count']} messages)"
            )

            # Build Part3 prompt（通过 PromptManager 获取）
            prompt = get_prompt_by("CONVERSATION_PROFILE_PART3_EXTRACTION_PROMPT")
            prompt += f"\n\n**Existing User Profile:**\n"
            prompt += f"User ID: {user_id}\n"
            prompt += f"User Name: {user_info['user_name']}\n"

            # Add old profile information if available
            if user_id in old_profiles_map:
                old_profile = old_profiles_map[user_id]
                prompt += f"\n**Previous Profile Summary:**\n"
                if hasattr(old_profile, 'personality') and old_profile.personality:
                    prompt += f"Personality: {old_profile.personality}\n"

            prompt += f"\n**New Conversation:**\n{conversation_text}\n"
            # Ask for structured JSON for companion fields (aligned with normalization schema)
            prompt += (
                f"\n**Task:** For user {user_info['user_name']}, extract ONLY these fields as JSON: "
                "gender, age, education_level, intimacy_level, intermediary_name, intermediary_context, "
                "personality, traits, occupation, relationship, interests, way_of_decision_making, life_habit_preference, communication_style, "
                "catchphrase, motivation_system, fear_system, value_system, humor_use, output_reasoning. "
                "Also extract how the owner talks to this friend: "
                "user_to_friend_catchphrase, user_to_friend_chat_style. "
                "If user_id == owner_user_id, keep relationship, intimacy_level, intermediary fields and the two user_to_friend_* fields empty. "
                "For list-type fields, each item must be an object: {\\\"value\\\": string, \\\"evidence_level\\\": \\\"L1\\\"|\\\"L2\\\", \\\"evidences\\\": [string]}. "
                "For single-value fields (gender, age, education_level, intimacy_level), use format: {\\\"value\\\": string, \\\"evidence_level\\\": \\\"L1\\\"|\\\"L2\\\", \\\"evidences\\\": [string]}. "
                "intermediary_name and intermediary_context are strings (fill only if there's an intermediary who introduced the contact). "
                "intimacy_level options: stranger, formal, close, intimate. "
                "evidence_level: L1 for explicit statements, L2 for strong implications. "
                "Use evidences referencing conversation ids when possible (e.g., [conversation_id:EVENT_ID] or EVENT_ID). "
                "Include user_id and user_name. Use ASCII quotes only. Return one fenced JSON block, no extra text.\n"
                "For risk detection: If user_id != owner_user_id and you detect suspicious behavior (e.g., asking for money, passwords, verification codes, suspicious links), add risk_level (low/medium/high) and warning_msg describing the suspicious pattern.\n"
                "Exact response template:\n"
                "```json\n"
                "{\n"
                "  \"user_profiles\": [\n"
                "    {\n"
                "      \"user_id\": \"USER_ID\",\n"
                "      \"user_name\": \"USER_NAME\",\n"
                "      \"gender\": {\"value\": \"\", \"evidence_level\": \"L1\", \"evidences\": []},\n"
                "      \"age\": {\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []},\n"
                "      \"education_level\": {\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []},\n"
                "      \"intimacy_level\": {\"value\": \"stranger\", \"evidence_level\": \"L2\", \"evidences\": []},\n"
                "      \"intermediary_name\": \"\",\n"
                "      \"intermediary_context\": \"\",\n"
                "      \"personality\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"traits\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"occupation\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"relationship\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"interests\": [{\"value\": \"\", \"evidence_level\": \"L1\", \"evidences\": []}],\n"
                "      \"way_of_decision_making\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"life_habit_preference\": [{\"value\": \"\", \"evidence_level\": \"L1\", \"evidences\": []}],\n"
                "      \"communication_style\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"catchphrase\": [{\"value\": \"\", \"evidence_level\": \"L1\", \"evidences\": []}],\n"
                "      \"motivation_system\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"fear_system\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"value_system\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"humor_use\": [{\"value\": \"\", \"evidence_level\": \"L1\", \"evidences\": []}],\n"
                "      \"user_to_friend_catchphrase\": [{\"value\": \"\", \"evidence_level\": \"L1\", \"evidences\": []}],\n"
                "      \"user_to_friend_chat_style\": [{\"value\": \"\", \"evidence_level\": \"L2\", \"evidences\": []}],\n"
                "      \"risk_level\": \"\",\n"
                "      \"warning_msg\": \"\",\n"
                "      \"output_reasoning\": \"\"\n"
                "    }\n"
                "  ]\n"
                "}\n"
                "```\n"
            )

            # Call LLM for analysis
            try:
                print(
                    f"[ProfileExtractor] Calling LLM to extract Profile for {user_info['user_name']}..."
                )
                print(f"🌸🌸🌸 [Profile] companion profile prompt for {user_info['user_name']}:\n{prompt}")
                response_text = await self.llm_provider.generate(
                    prompt, temperature=0.3
                )
                print(f"🌸🌸🌸 [Profile] companion profile response for {user_info['user_name']}:\n{response_text}")
                dump_profile_llm_artifacts(
                    "profile_part3",
                    prompt=prompt,
                    response=response_text,
                    meta={
                        "user_id": user_id,
                        "user_name": user_info.get("user_name"),
                    },
                )
                print(f"[ProfileExtractor] LLM returned: {response_text[:200]}...")
                logger.info(
                    f"[ProfileMemoryExtractor] ✅ Successfully extracted companion profile for {user_info['user_name']}"
                )

                # First try: structured JSON path compatible with existing normalization
                structured_profiles: Optional[List[Dict[str, Any]]] = None
                try:
                    # annotated = self._annotate_relative_dates(response_text)
                    annotated = response_text
                    structured_profiles = self._extract_user_profiles_from_response(
                        annotated, "companion profile"
                    )
                except Exception:
                    structured_profiles = None

                user_profiles_result: List[ProfileMemory] = []

                if structured_profiles:
                    print(
                        f"[ProfileExtractor] Parsed {len(structured_profiles)} structured Profiles"
                    )
                    # Ensure user_id/user_name present and add fallback evidences when missing
                    # Also route through profile_payload_to_memory for unified normalization
                    fallback_evidences: List[str] = []
                    # Prefer event_ids for fallback evidences
                    batch_event_ids: List[str] = [
                        str(mc.event_id)
                        for mc in request.memcell_list
                        if hasattr(mc, 'event_id') and mc.event_id
                    ]
                    for ev in batch_event_ids:
                        ev_date = conversation_date_map.get(ev) or default_date
                        fallback_evidences.append(f"{ev_date}|{ev}" if ev_date else ev)

                    for p in structured_profiles:
                        if not isinstance(p, dict):
                            continue
                        if not p.get("user_id"):
                            p["user_id"] = user_id
                        if not p.get("user_name"):
                            p["user_name"] = user_info["user_name"]

                        for field in (
                            "personality",
                            "way_of_decision_making",
                            "interests",
                            "life_habit_preference",
                            "communication_style",
                            "catchphrase",
                            "user_to_friend_catchphrase",
                            "user_to_friend_chat_style_preference",
                        ):
                            items = p.get(field)
                            if isinstance(items, list):
                                for it in items:
                                    if not isinstance(it, dict):
                                        continue
                                    raw_evidences = it.get("evidences")
                                    normalized_evs: List[str] = []
                                    if isinstance(raw_evidences, list):
                                        for ev in raw_evidences:
                                            try:
                                                s = str(ev).strip()
                                            except Exception:
                                                s = ""
                                            if not s:
                                                continue
                                            # Try to extract conversation id from forms like "[conversation_id:ID]" or raw ID
                                            conv_id: Optional[str] = None
                                            if "conversation_id:" in s:
                                                conv_id = s.split("conversation_id:")[
                                                    -1
                                                ].strip("[]() ,.\t\n")
                                            else:
                                                conv_id = s
                                            if (
                                                conv_id
                                                and conv_id in valid_conversation_ids
                                            ):
                                                ev_date = (
                                                    conversation_date_map.get(conv_id)
                                                    or default_date
                                                )
                                                normalized_evs.append(
                                                    f"{ev_date}|{conv_id}"
                                                    if ev_date
                                                    else conv_id
                                                )
                                    # If after normalization nothing remains, fallback to batch evidences
                                    if not normalized_evs:
                                        normalized_evs = list(fallback_evidences)
                                    it["evidences"] = normalized_evs

                        mem = profile_payload_to_memory(
                            p,
                            group_id=request.group_id or "",
                            valid_conversation_ids=valid_conversation_ids,
                            # default_date=default_date,
                            conversation_date_map=conversation_date_map,
                            valid_user_ids=participant_user_ids,
                            user_id_to_name=user_id_to_name,
                        )
                        if mem:
                            user_profiles_result.append(mem)
                            print(
                                f"[ProfileExtractor] ✅ Successfully converted Profile: user_id={mem.user_id}"
                            )
                        else:
                            print(
                                f"[ProfileExtractor] ⚠️  profile_payload_to_memory returned None"
                            )
                else:
                    print(
                        f"[ProfileExtractor] Failed to parse structured Profile, using fallback"
                    )
                    # Fallback: free-text analysis stored under personality with evidences bound
                    from datetime import datetime as _dt

                    fallback_evidences: List[str] = []
                    batch_event_ids: List[str] = [
                        str(mc.event_id)
                        for mc in request.memcell_list
                        if hasattr(mc, 'event_id') and mc.event_id
                    ]
                    for ev in batch_event_ids:
                        ev_date = conversation_date_map.get(ev) or default_date
                        fallback_evidences.append(f"{ev_date}|{ev}" if ev_date else ev)

                    profile_memory = ProfileMemory(
                        memory_type=MemoryType.PROFILE,
                        user_id=user_id,
                        timestamp=_dt.now(),
                        ori_event_id_list=[
                            mc.event_id
                            for mc in request.memcell_list
                            if hasattr(mc, 'event_id')
                        ],
                        group_id=request.group_id or "",
                        personality=[
                            {
                                "value": "90-dimension-analysis",
                                "evidences": fallback_evidences,
                                "analysis": response_text,
                            }
                        ],
                        life_habit_preference=None,
                        communication_style=None,
                        catchphrase=None,
                        user_to_friend_catchphrase=None,
                        way_of_decision_making=None,
                        group_importance_evidence=None,
                    )
                    user_profiles_result.append(profile_memory)
                    print(
                        f"[ProfileExtractor] ✅ Using fallback Profile: user_id={user_id}"
                    )

                print(
                    f"[ProfileExtractor] Final result returns {len(user_profiles_result)} Profiles"
                )
                return user_profiles_result

            except Exception as exc:
                logger.error(
                    f"[ProfileMemoryExtractor] ❌ Failed to extract companion profile for "
                    f"{user_info['user_name']}: {exc}"
                )
                print(f"[ProfileExtractor] ❌ Extraction failed: {exc}")
                import traceback

                print(traceback.format_exc())
                return []

        # 🚀 Parallel execution of Profile extraction for all users
        logger.info(
            f"[ProfileMemoryExtractor] 🚀 Starting parallel extraction of companion profiles for {len(user_profiles)} users"
        )
        print(
            f"[ProfileExtractor] 🚀 Starting parallel extraction of companion profiles for {len(user_profiles)} users"
        )

        tasks = [
            extract_single_user_companion_profile(user_id, user_info)
            for user_id, user_info in user_profiles.items()
        ]

        print(f"[ProfileExtractor] Created {len(tasks)} extraction tasks")

        results = await asyncio.gather(*tasks, return_exceptions=True)

        print(
            f"[ProfileExtractor] Parallel extraction completed, received {len(results)} results"
        )

        # Collect all successful profiles
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(
                    f"[ProfileMemoryExtractor] Profile extraction task failed: {result}"
                )
                print(f"[ProfileExtractor] Task {i+1} failed: {result}")
                continue
            if isinstance(result, list):
                companion_profiles.extend(result)
                print(
                    f"[ProfileExtractor] Task {i+1} succeeded, returned {len(result)} Profiles"
                )

        if not companion_profiles:
            logger.warning(
                "[ProfileMemoryExtractor] No companion profiles were successfully extracted"
            )
            print(f"[ProfileExtractor] ❌ Final companion_profiles is empty")
            return None

        logger.info(
            f"[ProfileMemoryExtractor] Successfully extracted {len(companion_profiles)} companion profiles"
        )
        print(
            f"[ProfileExtractor] ✅ Finally successfully extracted {len(companion_profiles)} companion profiles"
        )
        return companion_profiles
