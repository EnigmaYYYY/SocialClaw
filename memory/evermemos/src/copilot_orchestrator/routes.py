"""
Copilot API routes.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api_specs.unified_types import (
    MemorizeRequest,
    ProfileType,
    ReplySuggestionRequest,
    SenderType,
    UnifiedProfile,
    UnifiedMessage,
    generate_conversation_id,
    generate_profile_id,
)
from copilot_orchestrator.chat_workflow import ChatProcessRequest, get_chat_workflow_service
from copilot_orchestrator.orchestrator import get_copilot_orchestrator
from core.observation.logger import get_logger

router = APIRouter(prefix="/api/v1/copilot", tags=["copilot"])
logger = get_logger(__name__)

MANUAL_EVIDENCE_PREFIX = "manual:"
MANUAL_REASONING_TEXT = "用户手动设置"
SINGLE_PROFILE_FIELD_KEYS = (
    "gender",
    "age",
    "education_level",
    "intimacy_level",
)
LIST_PROFILE_FIELD_KEYS = (
    "occupation",
    "relationship",
    "traits",
    "personality",
    "interests",
    "way_of_decision_making",
    "life_habit_preference",
    "communication_style",
    "catchphrase",
    "user_to_friend_catchphrase",
    "user_to_friend_chat_style",
    "motivation_system",
    "fear_system",
    "value_system",
    "humor_use",
)


def _get_profile_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.unified_profile_repository import (
        UnifiedProfileRepository,
    )

    return get_bean("unified_profile_repository") or UnifiedProfileRepository()


def _get_episodic_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.episodic_memory_raw_repository import (
        EpisodicMemoryRawRepository,
    )

    return get_bean("episodic_memory_raw_repository") or EpisodicMemoryRawRepository()


def _get_foresight_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.foresight_record_repository import (
        ForesightRecordRawRepository,
    )

    return get_bean("foresight_record_repository") or ForesightRecordRawRepository()


def _get_memcell_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.memcell_raw_repository import (
        MemCellRawRepository,
    )

    return get_bean("memcell_raw_repository") or MemCellRawRepository()


def _get_conversation_data_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.conversation_data_raw_repository import (
        ConversationDataRepositoryImpl,
    )

    return get_bean("conversation_data_repo") or ConversationDataRepositoryImpl()


def _get_conversation_meta_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.conversation_meta_raw_repository import (
        ConversationMetaRawRepository,
    )

    return get_bean("conversation_meta_raw_repository") or ConversationMetaRawRepository()


def _get_conversation_status_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.conversation_status_raw_repository import (
        ConversationStatusRawRepository,
    )

    return get_bean("conversation_status_raw_repository") or ConversationStatusRawRepository()


def _get_cluster_state_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.cluster_state_raw_repository import (
        ClusterStateRawRepository,
    )

    return get_bean("cluster_state_raw_repository") or ClusterStateRawRepository()


def _get_event_log_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.event_log_record_raw_repository import (
        EventLogRecordRawRepository,
    )

    return get_bean("event_log_record_repository") or EventLogRecordRawRepository()


def _get_group_user_profile_memory_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.group_user_profile_memory_raw_repository import (
        GroupUserProfileMemoryRawRepository,
    )

    return get_bean("group_user_profile_memory_raw_repository") or GroupUserProfileMemoryRawRepository()


def _get_group_profile_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.group_profile_raw_repository import (
        GroupProfileRawRepository,
    )

    return get_bean("group_profile_raw_repository") or GroupProfileRawRepository()


def _get_user_profile_raw_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.user_profile_raw_repository import (
        UserProfileRawRepository,
    )

    return get_bean("user_profile_raw_repository") or UserProfileRawRepository()


def _get_conversation_message_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.conversation_message_repository import (
        ConversationMessageRepository,
    )

    return get_bean("conversation_message_repository") or ConversationMessageRepository()


def _get_friends_repo():
    from core.di import get_bean
    from infra_layer.adapters.out.persistence.repository.user_friends_repository import (
        UserFriendsRepository,
    )

    return get_bean("user_friends_repository") or UserFriendsRepository()


def _bool_to_count(value: bool) -> int:
    return 1 if value else 0


async def _cascade_delete_contact_profile_data(profile: UnifiedProfile) -> Dict[str, int]:
    conversation_id = str(getattr(profile, "conversation_id", "") or "").strip()
    if not conversation_id:
        return {}

    counts: Dict[str, int] = {
        "memcells": await _get_memcell_repo().delete_by_group_id(conversation_id),
        "episodes": await _get_episodic_repo().delete_by_conversation_id(conversation_id),
        "foresights": await _get_foresight_repo().delete_by_conversation_id(conversation_id),
        "event_logs": await _get_event_log_repo().delete_by_conversation_id(conversation_id),
        "conversation_messages": await _get_conversation_message_repo().delete_by_conversation_id(conversation_id),
        "conversation_cache": _bool_to_count(
            await _get_conversation_data_repo().delete_conversation_data(conversation_id)
        ),
        "conversation_meta": _bool_to_count(
            await _get_conversation_meta_repo().delete_by_conversation_id(conversation_id)
        ),
        "conversation_status": _bool_to_count(
            await _get_conversation_status_repo().delete_by_conversation_id(conversation_id)
        ),
        "cluster_state": _bool_to_count(
            await _get_cluster_state_repo().delete_by_conversation_id(conversation_id)
        ),
        "group_user_profile_memories": await _get_group_user_profile_memory_repo().delete_by_group_id(
            conversation_id
        ),
        "group_profiles": _bool_to_count(
            await _get_group_profile_repo().delete_by_group_id(conversation_id)
        ),
        "user_group_profiles": await _get_user_profile_raw_repo().delete_by_group(conversation_id),
    }
    return counts


async def _get_owner_conversation_ids(owner_user_id: str) -> List[str]:
    repo = _get_profile_repo()
    conversation_ids: List[str] = []
    for profile in await repo.list_contact_profiles(owner_user_id, limit=500):
        conversation_id = str(getattr(profile, "conversation_id", "") or "").strip()
        if conversation_id:
            conversation_ids.append(conversation_id)
    return conversation_ids


def _dedupe_records(records: List[Any]) -> List[Any]:
    deduped: List[Any] = []
    seen: set[str] = set()
    for record in records:
        record_id = str(getattr(record, "id", "") or "")
        if record_id and record_id in seen:
            continue
        if record_id:
            seen.add(record_id)
        deduped.append(record)
    return deduped


@router.post("/conversation-runtime/reset")
async def reset_conversation_runtime_state(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Reset volatile per-conversation runtime state used by historical backfill retries."""
    session_key = str(payload.get("session_key", "") or "").strip()
    conversation_id = str(payload.get("conversation_id", "") or "").strip()
    clear_cache = bool(payload.get("clear_cache", False))

    if not conversation_id and session_key:
        conversation_id = generate_conversation_id(session_key)

    if not conversation_id:
        raise HTTPException(status_code=400, detail="conversation_id_or_session_key_required")

    cleared_status = await _get_conversation_status_repo().delete_by_conversation_id(conversation_id)
    cleared_cache = False
    if clear_cache:
        cleared_cache = await _get_conversation_data_repo().delete_conversation_data(conversation_id)

    return {
        "success": True,
        "conversation_id": conversation_id,
        "cleared": {
            "conversation_status": _bool_to_count(cleared_status),
            "conversation_cache": _bool_to_count(cleared_cache),
        },
    }


def _sort_records_by_timestamp(records: List[Any]) -> List[Any]:
    return sorted(
        records,
        key=lambda record: _format_datetime(getattr(record, "timestamp", None)) or "",
        reverse=True,
    )


def _format_datetime(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _serialize_episode(record: Any) -> Dict[str, Any]:
    return {
        "episode_id": str(getattr(record, "id", "") or ""),
        "conversation_id": getattr(record, "conversation_id", None) or getattr(record, "group_id", None),
        "user_id": getattr(record, "user_id", None),
        "user_name": getattr(record, "user_name", None),
        "timestamp": _format_datetime(getattr(record, "timestamp", None)),
        "summary": getattr(record, "summary", "") or "",
        "subject": getattr(record, "subject", None),
        "episode": getattr(record, "episode", "") or "",
        "type": getattr(record, "type", None),
        "participants": list(getattr(record, "participants", None) or []),
        "keywords": list(getattr(record, "keywords", None) or []),
        "linked_entities": list(getattr(record, "linked_entities", None) or []),
        "updated_at": _format_datetime(getattr(record, "updated_at", None)),
    }


def _serialize_foresight(record: Any) -> Dict[str, Any]:
    return {
        "foresight_id": str(getattr(record, "id", "") or ""),
        "conversation_id": getattr(record, "conversation_id", None) or getattr(record, "group_id", None),
        "user_id": getattr(record, "user_id", None),
        "user_name": getattr(record, "user_name", None),
        "content": getattr(record, "content", "") or "",
        "parent_episode_id": getattr(record, "parent_episode_id", None),
        "start_time": _format_datetime(getattr(record, "start_time", None)),
        "end_time": _format_datetime(getattr(record, "end_time", None)),
        "duration_days": getattr(record, "duration_days", None),
        "participants": list(getattr(record, "participants", None) or []),
        "evidence": getattr(record, "evidence", None),
        "updated_at": _format_datetime(getattr(record, "updated_at", None)),
    }


def _serialize_memcell(
    record: Any,
    *,
    foresight_count_override: Optional[int] = None,
) -> Dict[str, Any]:
    foresight_memories = list(getattr(record, "foresight_memories", None) or [])
    original_data = list(getattr(record, "original_data", None) or [])
    legacy_foresight_count = len(foresight_memories)
    resolved_foresight_count = max(
        legacy_foresight_count,
        int(foresight_count_override or 0),
    )

    # Serialize original messages for displaying split conversation
    # Data structure: each item has 'data_type', 'messages' list, and 'meta'
    # Each message has 'content' and 'extend' dict with speaker info
    serialized_messages = []
    for idx, raw_item in enumerate(original_data):
        if isinstance(raw_item, dict):
            messages_list = raw_item.get("messages", [])
            if isinstance(messages_list, list):
                for msg in messages_list:
                    if not isinstance(msg, dict):
                        continue
                    extend = msg.get("extend", {}) or {}
                    if not isinstance(extend, dict):
                        extend = {}
                    speaker_name = extend.get("speaker_name", "") or ""
                    speaker_id = extend.get("speaker_id", "") or ""
                    content = msg.get("content", "") or ""
                    timestamp = _format_datetime(extend.get("timestamp"))
                    serialized_messages.append({
                        "speaker_name": speaker_name,
                        "speaker_id": speaker_id,
                        "content": str(content),
                        "timestamp": timestamp,
                    })
        else:
            # Fallback for non-dict items
            serialized_messages.append({
                "speaker_name": "",
                "speaker_id": "",
                "content": str(raw_item),
                "timestamp": None,
            })
    return {
        "memcell_id": str(getattr(record, "id", "") or ""),
        "conversation_id": getattr(record, "group_id", None),
        "user_id": getattr(record, "user_id", None),
        "timestamp": _format_datetime(getattr(record, "timestamp", None)),
        "summary": getattr(record, "summary", "") or "",
        "subject": getattr(record, "subject", None),
        "type": getattr(getattr(record, "type", None), "value", getattr(record, "type", None)),
        "participants": list(getattr(record, "participants", None) or []),
        "keywords": list(getattr(record, "keywords", None) or []),
        "episode": getattr(record, "episode", None),
        "foresight_count": resolved_foresight_count,
        "original_data_count": len(original_data),
        "original_data": serialized_messages,
        "updated_at": _format_datetime(getattr(record, "updated_at", None)),
    }


async def _build_memcell_foresight_count_map(
    owner_user_id: str,
    conversation_ids: List[str],
    memcell_records: List[Any],
    *,
    base_limit: int,
) -> Dict[str, int]:
    """
    Build a memcell_id -> foresight_count map.

    New foresights are stored in `foresight_records` and linked by:
    foresight.parent_episode_id -> episode.memcell_event_id_list.
    """
    memcell_ids = {
        str(getattr(record, "id", "") or "").strip()
        for record in memcell_records
        if str(getattr(record, "id", "") or "").strip()
    }
    if not memcell_ids:
        return {}

    lookup_limit = max(base_limit * 4, 200)
    episodic_repo = _get_episodic_repo()
    foresight_repo = _get_foresight_repo()

    episodes = list(await episodic_repo.get_by_user_id(owner_user_id, limit=lookup_limit))
    for conversation_id in conversation_ids:
        episodes.extend(
            await episodic_repo.get_by_conversation_id(
                conversation_id,
                limit=lookup_limit,
            )
        )
    episodes = _dedupe_records(episodes)

    episode_to_memcells: Dict[str, List[str]] = {}
    for episode in episodes:
        episode_id = str(getattr(episode, "id", "") or "").strip()
        memcell_event_ids = [
            str(memcell_id).strip()
            for memcell_id in list(getattr(episode, "memcell_event_id_list", None) or [])
            if str(memcell_id).strip()
        ]
        if episode_id and memcell_event_ids:
            episode_to_memcells[episode_id] = memcell_event_ids

    if not episode_to_memcells:
        return {}

    foresights = list(await foresight_repo.get_by_user_id(owner_user_id, limit=lookup_limit))
    for conversation_id in conversation_ids:
        foresights.extend(
            await foresight_repo.get_by_conversation_id(
                conversation_id,
                limit=lookup_limit,
            )
        )
    foresights = _dedupe_records(foresights)

    count_map: Dict[str, int] = {}
    for foresight in foresights:
        parent_episode_id = str(getattr(foresight, "parent_episode_id", "") or "").strip()
        if not parent_episode_id:
            continue
        for memcell_id in episode_to_memcells.get(parent_episode_id, []):
            if memcell_id in memcell_ids:
                count_map[memcell_id] = count_map.get(memcell_id, 0) + 1

    return count_map


def _normalize_profile_payload(payload: Dict[str, Any]) -> UnifiedProfile:
    profile_data = dict(payload)
    profile_type = ProfileType(profile_data.get("profile_type", "contact"))
    owner_user_id = str(profile_data.get("owner_user_id", "")).strip()
    display_name = str(profile_data.get("display_name", "")).strip()

    if not owner_user_id:
        raise HTTPException(status_code=400, detail="owner_user_id is required")
    if not display_name:
        raise HTTPException(status_code=400, detail="display_name is required")

    if not profile_data.get("profile_id"):
        profile_data["profile_id"] = generate_profile_id()

    if profile_type == ProfileType.USER:
        profile_data["profile_type"] = ProfileType.USER.value
        profile_data["target_user_id"] = None
        profile_data["conversation_id"] = None
    else:
        profile_data["profile_type"] = ProfileType.CONTACT.value

    profile_data = _enforce_manual_profile_rules(profile_data)
    return UnifiedProfile.from_dict(profile_data)


def _normalize_evidence_item(evidence: Any) -> Optional[Dict[str, str]]:
    if isinstance(evidence, str):
        event_id = evidence.strip()
        if not event_id:
            return None
        return {"event_id": event_id, "reasoning": ""}

    if isinstance(evidence, dict):
        event_id = str(evidence.get("event_id", "")).strip()
        if not event_id:
            return None
        reasoning = str(evidence.get("reasoning", "")).strip()
        return {"event_id": event_id, "reasoning": reasoning}

    return None


def _normalize_profile_field_with_manual_rule(field_value: Any) -> Any:
    if not isinstance(field_value, dict):
        return field_value

    value = str(field_value.get("value", "")).strip()
    if not value:
        return field_value

    evidences_raw = field_value.get("evidences", [])
    if not isinstance(evidences_raw, list):
        evidences_raw = [evidences_raw]

    normalized_evidences: List[Dict[str, str]] = []
    has_manual_evidence = False

    for raw_item in evidences_raw:
        normalized_item = _normalize_evidence_item(raw_item)
        if not normalized_item:
            continue
        if normalized_item["event_id"].startswith(MANUAL_EVIDENCE_PREFIX):
            has_manual_evidence = True
            normalized_item["reasoning"] = MANUAL_REASONING_TEXT
        normalized_evidences.append(normalized_item)

    patched = dict(field_value)
    patched["evidences"] = normalized_evidences

    if has_manual_evidence:
        patched["evidence_level"] = "L1"

    return patched


def _enforce_manual_profile_rules(profile_data: Dict[str, Any]) -> Dict[str, Any]:
    patched = dict(profile_data)

    for key in SINGLE_PROFILE_FIELD_KEYS:
        if key in patched and patched[key] is not None:
            patched[key] = _normalize_profile_field_with_manual_rule(patched[key])

    for key in LIST_PROFILE_FIELD_KEYS:
        raw_list = patched.get(key)
        if not isinstance(raw_list, list):
            continue
        patched[key] = [_normalize_profile_field_with_manual_rule(item) for item in raw_list]

    return patched


def _normalize_process_chat_message(
    payload: Dict[str, Any],
    *,
    owner_user_id: str,
    session_key: str,
    display_name: str,
) -> UnifiedMessage:
    """
    Normalize message payload to UnifiedMessage.

    Frontend now sends UnifiedMessage format directly, so this function
    only fills in defaults for missing optional fields.
    """
    message_dict = dict(payload)
    conversation_id = generate_conversation_id(session_key) if session_key else message_dict.get("conversation_id", "")

    # Ensure required fields have defaults
    if "conversation_id" not in message_dict or not message_dict["conversation_id"]:
        message_dict["conversation_id"] = conversation_id
    if "sender_id" not in message_dict or not message_dict["sender_id"]:
        sender_type = message_dict.get("sender_type", "unknown")
        message_dict["sender_id"] = owner_user_id if sender_type == "user" else display_name
    if "sender_name" not in message_dict or not message_dict["sender_name"]:
        sender_type = message_dict.get("sender_type", "unknown")
        message_dict["sender_name"] = owner_user_id if sender_type == "user" else display_name
    if "timestamp" not in message_dict or not message_dict["timestamp"]:
        message_dict["timestamp"] = datetime.now().isoformat()
    if "content_type" not in message_dict or not message_dict["content_type"]:
        message_dict["content_type"] = "text"

    # Handle legacy role field (for backward compatibility)
    if "role" in message_dict and "sender_type" not in message_dict:
        role = str(message_dict.pop("role"))
        message_dict["sender_type"] = "contact" if role == "assistant" else role

    return UnifiedMessage.from_dict(message_dict)


@router.post("/reply-suggestion", response_model=Dict[str, Any])
async def get_reply_suggestion(request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        incoming_msg = None
        if request.get("incoming_message"):
            incoming_msg = UnifiedMessage.from_dict(request["incoming_message"])

        reply_request = ReplySuggestionRequest(
            conversation_id=request.get("conversation_id", ""),
            owner_user_id=request.get("owner_user_id", ""),
            target_user_id=request.get("target_user_id"),
            incoming_message=incoming_msg,
            manual_intent=request.get("manual_intent"),
            history_window=request.get("history_window", 20),
        )

        orchestrator = get_copilot_orchestrator()
        response = await orchestrator.get_reply_suggestion(reply_request)
        return {"success": True, "data": response.to_dict()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/conversations/{conversation_id}/context")
async def get_conversation_context(
    conversation_id: str,
    owner_user_id: str,
    target_user_id: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        orchestrator = get_copilot_orchestrator()
        context = await orchestrator.get_context(
            conversation_id=conversation_id,
            owner_user_id=owner_user_id,
            target_user_id=target_user_id,
        )
        return {"success": True, "data": context}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/memorize")
async def memorize_messages(request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        messages = [UnifiedMessage.from_dict(item) for item in request.get("messages", [])]
        memorize_request = MemorizeRequest(
            conversation_id=request.get("conversation_id", ""),
            owner_user_id=request.get("owner_user_id", ""),
            messages=messages,
            options=request.get("options", {}),
        )

        orchestrator = get_copilot_orchestrator()
        return await orchestrator.memorize_messages(memorize_request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/profiles/{profile_id}")
async def get_profile(profile_id: str) -> Dict[str, Any]:
    try:
        repo = _get_profile_repo()
        profile = await repo.get_by_profile_id(profile_id)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        return {"success": True, "data": profile.to_dict()}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/profiles")
async def list_profiles(
    owner_user_id: str,
    profile_type: str = "all",
    limit: int = 200,
) -> Dict[str, Any]:
    try:
        repo = _get_profile_repo()
        normalized_type = profile_type.strip().lower()
        profiles: List[UnifiedProfile] = []

        if normalized_type in ("all", "user"):
            user_profile = await repo.get_user_profile(owner_user_id)
            if user_profile:
                profiles.append(user_profile)

        if normalized_type in ("all", "contact"):
            profiles.extend(await repo.list_contact_profiles(owner_user_id, limit=max(limit, 1)))

        profiles.sort(
            key=lambda profile: (
                getattr(getattr(profile, "metadata", None), "last_updated", "") or "",
                profile.display_name,
            ),
            reverse=True,
        )
        return {"success": True, "data": [profile.to_dict() for profile in profiles]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/episodes")
async def list_episodes(
    owner_user_id: str,
    limit: int = 100,
) -> Dict[str, Any]:
    try:
        repo = _get_episodic_repo()
        records = list(await repo.get_by_user_id(owner_user_id, limit=max(limit, 1)))
        for conversation_id in await _get_owner_conversation_ids(owner_user_id):
            records.extend(await repo.get_by_conversation_id(conversation_id, limit=max(limit, 1)))
        records = _sort_records_by_timestamp(_dedupe_records(records))[: max(limit, 1)]
        return {"success": True, "data": [_serialize_episode(record) for record in records]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/memcells")
async def list_memcells(
    owner_user_id: str,
    limit: int = 120,
) -> Dict[str, Any]:
    try:
        repo = _get_memcell_repo()
        conversation_ids = await _get_owner_conversation_ids(owner_user_id)
        records = list(await repo.find_by_user_id(owner_user_id, limit=max(limit, 1)))
        for conversation_id in conversation_ids:
            records.extend(await repo.find_by_group_id(conversation_id, limit=max(limit, 1)))
        records = _sort_records_by_timestamp(_dedupe_records(records))[: max(limit, 1)]
        foresight_count_map = await _build_memcell_foresight_count_map(
            owner_user_id,
            conversation_ids,
            records,
            base_limit=max(limit, 1),
        )

        return {
            "success": True,
            "data": [
                _serialize_memcell(
                    record,
                    foresight_count_override=foresight_count_map.get(
                        str(getattr(record, "id", "") or "").strip(),
                        0,
                    ),
                )
                for record in records
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/foresights")
async def list_foresights(
    owner_user_id: str,
    limit: int = 100,
) -> Dict[str, Any]:
    try:
        repo = _get_foresight_repo()
        records = list(await repo.get_by_user_id(owner_user_id, limit=max(limit, 1)))
        for conversation_id in await _get_owner_conversation_ids(owner_user_id):
            records.extend(await repo.get_by_conversation_id(conversation_id, limit=max(limit, 1)))
        records = _sort_records_by_timestamp(_dedupe_records(records))[: max(limit, 1)]
        return {"success": True, "data": [_serialize_foresight(record) for record in records]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/profiles/user")
async def create_or_update_user_profile(request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        orchestrator = get_copilot_orchestrator()
        profile = await orchestrator.create_or_update_user_profile(
            owner_user_id=request.get("owner_user_id", ""),
            profile_data=request.get("profile_data", {}),
        )
        return {"success": True, "data": profile.to_dict()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/profiles/contact")
async def create_or_update_contact_profile(request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        orchestrator = get_copilot_orchestrator()
        profile = await orchestrator.create_or_update_contact_profile(
            owner_user_id=request.get("owner_user_id", ""),
            session_key=request.get("session_key", ""),
            display_name=request.get("display_name", "unknown"),
            profile_data=request.get("profile_data", {}),
        )
        return {"success": True, "data": profile.to_dict()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/profiles/{profile_id}")
async def save_profile(profile_id: str, request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        repo = _get_profile_repo()
        profile_payload = request.get("profile")
        if not isinstance(profile_payload, dict):
            raise HTTPException(status_code=400, detail="profile payload is required")

        profile_payload = dict(profile_payload)
        profile_payload["profile_id"] = profile_id
        profile = _normalize_profile_payload(profile_payload)
        saved = await repo.save_profile(profile)
        if not saved:
            raise HTTPException(status_code=500, detail="profile_save_failed")
        refreshed = await repo.get_by_profile_id(profile_id)
        return {"success": True, "data": (refreshed or profile).to_dict()}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str) -> Dict[str, Any]:
    try:
        repo = _get_profile_repo()
        profile = await repo.get_by_profile_id(profile_id)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")

        cascade_counts: Dict[str, int] = {}
        if getattr(profile, "profile_type", None) == ProfileType.CONTACT:
            cascade_counts = await _cascade_delete_contact_profile_data(profile)

        deleted = await repo.delete_by_profile_id(profile_id)
        if not deleted:
            raise HTTPException(status_code=500, detail="profile_delete_failed")

        logger.info(
            "Deleted profile with cascade cleanup: profile_id=%s, conversation_id=%s, target_user_id=%s, cascade=%s",
            profile_id,
            getattr(profile, "conversation_id", None),
            getattr(profile, "target_user_id", None),
            cascade_counts,
        )
        return {
            "success": True,
            "deleted": True,
            "profile_id": profile_id,
            "profile_type": getattr(getattr(profile, "profile_type", None), "value", None),
            "owner_user_id": getattr(profile, "owner_user_id", None),
            "target_user_id": getattr(profile, "target_user_id", None),
            "conversation_id": getattr(profile, "conversation_id", None),
            "display_name": getattr(profile, "display_name", None),
            "aliases": list(getattr(profile, "aliases", None) or []),
            "cascade_counts": cascade_counts,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/feedback")
async def submit_feedback(request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return {"success": True, "message": "Feedback received"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/process-chat", response_model=Dict[str, Any])
async def process_chat(request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        owner_user_id = request.get("owner_user_id", "")
        session_key = request.get("session_key", "")
        display_name = request.get("display_name", "unknown")

        messages = [
            _normalize_process_chat_message(
                dict(message),
                owner_user_id=owner_user_id,
                session_key=session_key,
                display_name=display_name,
            )
            for message in request.get("messages", [])
        ]

        incoming_msg = None
        if request.get("incoming_message"):
            incoming_msg = _normalize_process_chat_message(
                dict(request["incoming_message"]),
                owner_user_id=owner_user_id,
                session_key=session_key,
                display_name=display_name,
            )

        force_memory_backfill = bool(request.get("force_memory_backfill", False))
        allow_memory_replay = bool(request.get("allow_memory_replay", False))
        is_historical_import = bool(request.get("is_historical_import", False))
        logger.info(
            "[process-chat] flags: session_key=%s force_memory_backfill=%s allow_memory_replay=%s is_historical_import=%s message_count=%s",
            session_key,
            force_memory_backfill,
            allow_memory_replay,
            is_historical_import,
            len(messages),
        )

        chat_request = ChatProcessRequest(
            owner_user_id=owner_user_id,
            session_key=session_key,
            display_name=display_name,
            messages=messages,
            incoming_message=incoming_msg,
            manual_intent=request.get("manual_intent"),
            force_profile_update=request.get("force_profile_update", False),
            force_memory_backfill=force_memory_backfill,
            allow_memory_replay=allow_memory_replay,
            is_historical_import=is_historical_import,
        )

        workflow_service = get_chat_workflow_service()
        result = await workflow_service.process_chat(chat_request)
        return result.to_dict()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/process-chat/simple", response_model=Dict[str, Any])
async def process_chat_simple(request: Dict[str, Any]) -> Dict[str, Any]:
    try:
        owner_user_id = request.get("owner_user_id", "user_default")
        friend_name = request.get("friend_name", "friend")
        raw_messages = request.get("messages", [])
        last_message = request.get("last_message")

        messages = []
        for index, content in enumerate(raw_messages):
            is_user = index % 2 == 1
            messages.append(
                UnifiedMessage(
                    message_id=f"msg_{index}",
                    conversation_id=f"chat::{friend_name}",
                    content=content,
                    sender_id=owner_user_id if is_user else friend_name,
                    sender_name=owner_user_id if is_user else friend_name,
                    sender_type=SenderType.USER if is_user else SenderType.CONTACT,
                    timestamp="",
                )
            )

        incoming_msg = None
        if last_message:
            incoming_msg = UnifiedMessage(
                message_id="msg_incoming",
                conversation_id=f"chat::{friend_name}",
                content=last_message,
                sender_id=friend_name,
                sender_name=friend_name,
                sender_type=SenderType.CONTACT,
                timestamp="",
            )

        chat_request = ChatProcessRequest(
            owner_user_id=owner_user_id,
            session_key=f"chat::{friend_name}",
            display_name=friend_name,
            messages=messages,
            incoming_message=incoming_msg,
            manual_intent=None,
            force_profile_update=False,
        )

        workflow_service = get_chat_workflow_service()
        result = await workflow_service.process_chat(chat_request)

        return {
            "success": result.success,
            "reply": result.reply_suggestion.reply_text if result.reply_suggestion else None,
            "profile_created": result.is_new_friend,
            "profile_updated": result.profile_updated,
            "error": result.error,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/profiles/regenerate")
async def regenerate_profiles(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Regenerate all profiles from existing memcells.

    This endpoint:
    1. Extracts friends list from memcells' original_data (speaker_id -> speaker_name)
    2. Saves friends to user_friends table
    3. Deletes all existing profiles for the owner
    4. For each conversation with friends, triggers profile extraction
    5. Generates profiles for owner (self) and all friends (contacts)

    Args:
        request: {
            "owner_user_id": "user_id" (required)
        }

    Returns:
        {
            "success": True,
            "deleted_profiles": int,
            "friends_found": int,
            "scanned_memcells": int,
            "processed_conversations": int,
            "updated_profiles": int,
            "errors": [...]
        }
    """
    from collections import defaultdict
    from api_specs.memory_types import MemCell, RawDataType
    from biz_layer.mem_memorize import _trigger_profile_extraction, DEFAULT_MEMORIZE_CONFIG
    from memory_layer.cluster_manager import ClusterState
    from memory_layer.llm.llm_provider import LLMProvider
    from infra_layer.adapters.out.persistence.document.memory.memcell import DataTypeEnum
    import os

    owner_user_id = request.get("owner_user_id")
    if not owner_user_id:
        raise HTTPException(status_code=400, detail="owner_user_id is required")

    print(f"[Regenerate] Starting profile regeneration for owner: {owner_user_id}")

    try:
        memcell_repo = _get_memcell_repo()
        profile_repo = _get_profile_repo()
        friends_repo = _get_friends_repo()
        cluster_state_repo = _get_cluster_state_repo()
        conversation_meta_repo = _get_conversation_meta_repo()

        # Helper function to check if speaker_name contains 🌟
        def is_star_user(speaker_name: str) -> bool:
            """Check if speaker_name contains 🌟 (should be excluded from profile generation)"""
            return speaker_name and '🌟' in speaker_name

        # Step 1: Fetch all memcells from database
        all_memcells = await memcell_repo.model.find().to_list()
        print(f"[Regenerate] Found {len(all_memcells)} total memcells in database")

        # Step 2: Extract friends from memcells and build conversation mapping
        # 从 original_data 中提取 speaker_id -> speaker_name 映射
        # 以及 group_id -> participants 映射
        friend_ids = set()
        friend_names: Dict[str, str] = {}
        star_user_ids = set()  # Users with 🌟 in their name (to exclude)
        group_to_friends: Dict[str, List[str]] = {}  # group_id -> list of friend_ids in this conversation
        group_to_memcells: Dict[str, List] = defaultdict(list)  # group_id -> memcells

        for m in all_memcells:
            gid = m.group_id
            if not gid:
                continue

            group_to_memcells[gid].append(m)

            # Extract speakers from original_data
            if m.original_data:
                for item in m.original_data:
                    if hasattr(item, 'model_dump'):
                        item = item.model_dump()
                    elif hasattr(item, 'dict'):
                        item = item.dict()

                    if not isinstance(item, dict):
                        continue

                    messages = item.get('messages', [])
                    if messages and isinstance(messages, list):
                        for msg in messages:
                            if not isinstance(msg, dict):
                                continue
                            extend = msg.get('extend', {}) or {}
                            speaker_id = extend.get('speaker_id', '')
                            speaker_name = extend.get('speaker_name', '')

                            if speaker_id and speaker_id != owner_user_id:
                                # 排除 robot/assistant
                                if 'robot' in speaker_id.lower() or 'assistant' in speaker_id.lower():
                                    continue
                                # 排除名字包含 🌟 的用户
                                if is_star_user(speaker_name):
                                    star_user_ids.add(speaker_id)
                                    continue
                                friend_ids.add(speaker_id)
                                if speaker_name:
                                    friend_names[speaker_id] = speaker_name

                                # 记录这个对话中出现的 friends
                                if gid not in group_to_friends:
                                    group_to_friends[gid] = []
                                if speaker_id not in group_to_friends[gid]:
                                    group_to_friends[gid].append(speaker_id)

        print(f"[Regenerate] Extracted {len(friend_ids)} friends from memcells")
        print(f"[Regenerate] Friends: {list(friend_ids)[:10]}...")  # Show first 10
        if star_user_ids:
            print(f"[Regenerate] Excluded {len(star_user_ids)} star users (🌟): {list(star_user_ids)}")

        # Step 3: Save friends to user_friends table
        await friends_repo.upsert_friends(
            owner_user_id=owner_user_id,
            friend_ids=list(friend_ids),
            friend_names=friend_names,
            source="memcell_extraction"
        )
        print(f"[Regenerate] Saved {len(friend_ids)} friends to user_friends table")

        # Step 4: Delete ALL existing profiles for this owner
        print(f"[Regenerate] Deleting existing profiles...")
        deleted_count = await profile_repo.delete_by_owner(owner_user_id)
        print(f"[Regenerate] Deleted {deleted_count} existing profiles")

        # Step 5: Generate profiles for each friend
        result = {
            "success": True,
            "deleted_profiles": deleted_count,
            "friends_found": len(friend_ids),
            "scanned_memcells": len(all_memcells),
            "processed_conversations": 0,
            "updated_profiles": 0,
            "errors": [],
        }

        # 按 group_id 处理，每个对话生成一次 profile
        processed_groups = set()

        for group_id, memcells in group_to_memcells.items():
            friends_in_conv = group_to_friends.get(group_id, [])
            if not friends_in_conv:
                continue

            # 只处理有好友的对话
            try:
                print(f"[Regenerate] Processing conversation: {group_id}, friends: {friends_in_conv}, memcells: {len(memcells)}")

                # Load cluster state
                state_dict = await cluster_state_repo.load_cluster_state(group_id)
                cluster_state = ClusterState.from_dict(state_dict) if state_dict else ClusterState()

                # Create a single cluster_id for all memcells in this conversation
                cluster_id = f"regenerate_{group_id}"
                cluster_state.cluster_counts[cluster_id] = len(memcells)

                # Get scene from conversation_meta
                conv_meta = await conversation_meta_repo.get_by_conversation_id(group_id)
                scene = getattr(conv_meta, "scene", None) or "private"

                # Use the first memcell for profile extraction
                db_memcell = memcells[0]

                # Convert database model to dataclass
                raw_data_type = None
                if db_memcell.type:
                    raw_data_type = RawDataType.CONVERSATION if db_memcell.type == DataTypeEnum.CONVERSATION else None

                # Build user_id_list: owner + friends in this conversation (exclude star users)
                user_id_list = [owner_user_id] + [f for f in friends_in_conv if f not in star_user_ids]

                # Convert original_data to flat list of messages
                # Replace 🌟 speaker_name with empty string to avoid showing in profile
                original_data = []
                if db_memcell.original_data:
                    for item in db_memcell.original_data:
                        if hasattr(item, 'model_dump'):
                            item = item.model_dump()
                        elif hasattr(item, 'dict'):
                            item = item.dict()

                        if not isinstance(item, dict):
                            continue

                        messages = item.get('messages', [])
                        if messages and isinstance(messages, list):
                            for msg in messages:
                                if not isinstance(msg, dict):
                                    continue
                                extend = msg.get('extend', {}) or {}
                                speaker_name = extend.get('speaker_name', '')
                                # Replace 🌟 with empty string or 'owner'
                                if '🌟' in speaker_name:
                                    speaker_name = speaker_name.replace('🌟', '').strip() or 'owner'
                                flat_msg = {
                                    'content': msg.get('content', ''),
                                    'speaker_id': extend.get('speaker_id', ''),
                                    'speaker_name': speaker_name,
                                    'timestamp': extend.get('timestamp', ''),
                                    'referList': extend.get('referList', []),
                                }
                                original_data.append(flat_msg)
                        elif item.get('content'):
                            original_data.append(item)

                memcell = MemCell(
                    event_id=str(db_memcell.id) if db_memcell.id else None,
                    user_id_list=user_id_list,
                    original_data=original_data if original_data else [{"content": "empty"}],
                    timestamp=db_memcell.timestamp,
                    summary=db_memcell.summary,
                    group_id=db_memcell.group_id,
                    group_name=None,
                    participants=user_id_list,  # 包含 owner 和好友
                    type=raw_data_type,
                    episode=db_memcell.episode,
                    subject=db_memcell.subject,
                )

                # Trigger profile extraction with force=True
                await _trigger_profile_extraction(
                    group_id=group_id,
                    cluster_id=cluster_id,
                    cluster_state=cluster_state,
                    memcell=memcell,
                    scene=scene,
                    config=DEFAULT_MEMORIZE_CONFIG,
                    force_profile_extraction=True,
                    owner_user_id=owner_user_id,
                )

                result["processed_conversations"] += 1

            except Exception as conv_error:
                logger.error(f"[Regenerate] Failed to process conversation {group_id}: {conv_error}")
                print(f"[Regenerate] ERROR processing {group_id}: {conv_error}")
                result["errors"].append(f"Conversation {group_id}: {str(conv_error)}")

        # Count updated profiles
        updated_profiles = await profile_repo.list_contact_profiles(owner_user_id)
        user_profile = await profile_repo.get_user_profile(owner_user_id)
        total_updated = len(updated_profiles) + (1 if user_profile else 0)
        result["updated_profiles"] = total_updated

        print(f"[Regenerate] Completed: deleted={deleted_count}, updated={total_updated}")
        return result

    except Exception as exc:
        logger.error(f"[Regenerate] Failed: {exc}")
        print(f"🍃🍃🍃 [Regenerate] FATAL ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/profiles/clear")
async def clear_profiles(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Clear all profile fields, keeping only basic identifiers.

    This resets profiles to minimal stub state, preserving:
    - profile_id, profile_type, owner_user_id, target_user_id, conversation_id
    - display_name

    All other fields (traits, interests, communication_style, etc.) are cleared.

    Args:
        request: {
            "owner_user_id": "user_id" (required)
        }

    Returns:
        {
            "success": True,
            "cleared_profiles": int
        }
    """
    from api_specs.unified_types import ProfileField

    owner_user_id = request.get("owner_user_id")
    if not owner_user_id:
        raise HTTPException(status_code=400, detail="owner_user_id is required")

    print(f"🍃🍃🍃 [Clear] Starting profile clear for owner: {owner_user_id}")

    try:
        profile_repo = _get_profile_repo()

        # Get all profiles for this owner
        all_profiles = []

        # Get user profile
        user_profile = await profile_repo.get_user_profile(owner_user_id)
        if user_profile:
            all_profiles.append(user_profile)

        # Get contact profiles
        contact_profiles = await profile_repo.list_contact_profiles(owner_user_id)
        all_profiles.extend(contact_profiles)

        cleared_count = 0
        for profile in all_profiles:
            # Reset to minimal stub - keep only identifiers
            profile.traits = []
            profile.interests = []
            profile.way_of_decision_making = []
            profile.life_habit_preference = []
            profile.communication_style = []
            profile.catchphrase = []
            profile.user_to_friend_catchphrase = []
            profile.user_to_friend_chat_style = []
            profile.motivation_system = []
            profile.fear_system = []
            profile.value_system = []
            profile.humor_use = []
            profile.occupation = None
            profile.relationship = None
            profile.extend = {}

            # Save
            await profile_repo.upsert_by_owner_target(profile)
            cleared_count += 1

        print(f"🍃🍃🍃 [Clear] Cleared {cleared_count} profiles")
        return {
            "success": True,
            "cleared_profiles": cleared_count
        }

    except Exception as exc:
        logger.error(f"[Clear] Failed: {exc}")
        print(f"🍃🍃🍃 [Clear] FATAL ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ==================== Friends API ====================

@router.get("/friends")
async def list_friends(owner_user_id: str) -> Dict[str, Any]:
    """
    获取用户的好友列表

    Args:
        owner_user_id: 用户ID

    Returns:
        {
            "success": True,
            "data": {
                "owner_user_id": "...",
                "friend_ids": ["friend1", "friend2", ...],
                "friend_names": {"friend1": "张三", "friend2": "李四"},
                "total_friends": 2
            }
        }
    """
    try:
        friends_repo = _get_friends_repo()
        doc = await friends_repo.get_by_owner(owner_user_id)

        if not doc:
            return {
                "success": True,
                "data": {
                    "owner_user_id": owner_user_id,
                    "friend_ids": [],
                    "friend_names": {},
                    "total_friends": 0
                }
            }

        return {
            "success": True,
            "data": {
                "owner_user_id": doc.owner_user_id,
                "friend_ids": doc.friend_ids,
                "friend_names": doc.friend_names,
                "total_friends": doc.total_friends
            }
        }

    except Exception as exc:
        logger.error(f"[Friends] Failed to list friends for {owner_user_id}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/friends/sync")
async def sync_friends_from_profiles(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    从现有 profiles 同步好友列表

    从 unified_profiles 中提取所有 contact 类型的 profile，
    将 target_user_id 作为好友ID，display_name 作为好友名称。

    Args:
        request: {"owner_user_id": "user_id"}

    Returns:
        {
            "success": True,
            "synced_friends": 10
        }
    """
    owner_user_id = request.get("owner_user_id")
    if not owner_user_id:
        raise HTTPException(status_code=400, detail="owner_user_id is required")

    print(f"[Friends] Syncing friends from profiles for: {owner_user_id}")

    try:
        profile_repo = _get_profile_repo()
        friends_repo = _get_friends_repo()

        # 获取所有 contact profiles
        contact_profiles = await profile_repo.list_contact_profiles(owner_user_id, limit=500)

        friend_ids = []
        friend_names = {}

        for profile in contact_profiles:
            target_id = getattr(profile, 'target_user_id', None)
            if target_id:
                friend_ids.append(target_id)
                display_name = getattr(profile, 'display_name', '')
                if display_name:
                    friend_names[target_id] = display_name

        # 去重
        friend_ids = list(set(friend_ids))

        # 保存到好友表
        doc = await friends_repo.upsert_friends(
            owner_user_id=owner_user_id,
            friend_ids=friend_ids,
            friend_names=friend_names,
            source="profile_sync"
        )

        print(f"[Friends] Synced {len(friend_ids)} friends for {owner_user_id}")

        return {
            "success": True,
            "synced_friends": len(friend_ids),
            "data": {
                "owner_user_id": owner_user_id,
                "friend_ids": friend_ids,
                "friend_names": friend_names
            }
        }

    except Exception as exc:
        logger.error(f"[Friends] Failed to sync friends for {owner_user_id}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/friends/add")
async def add_friend(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    添加好友

    Args:
        request: {
            "owner_user_id": "user_id",
            "friend_id": "friend_user_id",
            "friend_name": "好友名称" (optional)
        }

    Returns:
        {"success": True, "added": True}
    """
    owner_user_id = request.get("owner_user_id")
    friend_id = request.get("friend_id")
    friend_name = request.get("friend_name")

    if not owner_user_id or not friend_id:
        raise HTTPException(status_code=400, detail="owner_user_id and friend_id are required")

    try:
        friends_repo = _get_friends_repo()
        success = await friends_repo.add_friend(owner_user_id, friend_id, friend_name)

        return {
            "success": True,
            "added": success
        }

    except Exception as exc:
        logger.error(f"[Friends] Failed to add friend: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/friends/remove")
async def remove_friend(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    移除好友

    Args:
        request: {
            "owner_user_id": "user_id",
            "friend_id": "friend_user_id"
        }

    Returns:
        {"success": True, "removed": True}
    """
    owner_user_id = request.get("owner_user_id")
    friend_id = request.get("friend_id")

    if not owner_user_id or not friend_id:
        raise HTTPException(status_code=400, detail="owner_user_id and friend_id are required")

    try:
        friends_repo = _get_friends_repo()
        success = await friends_repo.remove_friend(owner_user_id, friend_id)

        return {
            "success": True,
            "removed": success
        }

    except Exception as exc:
        logger.error(f"[Friends] Failed to remove friend: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================================================
# LLM Configuration API
# ============================================================================

import os
from pathlib import Path


def _get_env_file_path() -> Path:
    """获取 .env 文件路径"""
    # 尝试多个可能的位置
    possible_paths = [
        Path(__file__).resolve().parents[2] / ".env",  # EverMemOS/.env
        Path(__file__).resolve().parents[3] / ".env",  # SC/EverMemOS/.env
    ]
    for p in possible_paths:
        if p.exists():
            return p
    # 默认返回第一个可能的位置
    return possible_paths[0]


def _mask_api_key(api_key: str) -> str:
    """脱敏显示 API Key"""
    if not api_key or len(api_key) < 8:
        return "****"
    return api_key[:4] + "****" + api_key[-4:]


@router.get("/config/llm")
async def get_llm_config() -> Dict[str, Any]:
    """
    获取 LLM 配置

    Returns:
        {
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-****xxxx",  # 脱敏显示
            "model": "gpt-4",
            "temperature": 0.3,
            "max_tokens": 8192
        }
    """
    try:
        api_key = os.getenv("LLM_API_KEY", "")
        return {
            "success": True,
            "config": {
                "base_url": os.getenv("LLM_BASE_URL", ""),
                "api_key": _mask_api_key(api_key),
                "api_key_full": api_key,  # 完整的 key，前端用于判断是否已设置
                "model": os.getenv("LLM_MODEL", "gpt-4"),
                "temperature": float(os.getenv("LLM_TEMPERATURE", "0.3")),
                "max_tokens": int(os.getenv("LLM_MAX_TOKENS", "8192"))
            }
        }
    except Exception as exc:
        logger.error(f"[Config] Failed to get LLM config: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


def _update_env_config(request: Dict[str, Any], config_mapping: Dict[str, str], config_label: str) -> Dict[str, Any]:
    """共享的 .env 配置更新逻辑"""
    env_path = _get_env_file_path()

    env_lines = []
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            env_lines = f.readlines()

    updated_keys = set()
    for i, line in enumerate(env_lines):
        stripped = line.strip()
        for config_key, env_key in config_mapping.items():
            if stripped.startswith(f"{env_key}="):
                new_value = request.get(config_key)
                if new_value is not None:
                    if config_key == "api_key" and not new_value:
                        continue
                    env_lines[i] = f"{env_key}={new_value}\n"
                    os.environ[env_key] = str(new_value)
                    updated_keys.add(env_key)

    for config_key, env_key in config_mapping.items():
        if env_key not in updated_keys:
            new_value = request.get(config_key)
            if new_value is not None:
                if config_key == "api_key" and not new_value:
                    continue
                env_lines.append(f"{env_key}={new_value}\n")
                os.environ[env_key] = str(new_value)

    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(env_lines)

    logger.info(f"[Config] {config_label} config updated: {list(updated_keys)}")
    return {"success": True, "message": "配置已更新，重启服务后生效"}


@router.put("/config/llm")
async def update_llm_config(request: Dict[str, Any]) -> Dict[str, Any]:
    """更新 LLM 配置到 .env 文件"""
    try:
        config_mapping = {
            "base_url": "LLM_BASE_URL",
            "api_key": "LLM_API_KEY",
            "model": "LLM_MODEL",
            "temperature": "LLM_TEMPERATURE",
            "max_tokens": "LLM_MAX_TOKENS"
        }
        return _update_env_config(request, config_mapping, "LLM")
    except Exception as exc:
        logger.error(f"[Config] Failed to update LLM config: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================================================
# Vectorize Configuration API
# ============================================================================

@router.get("/config/vectorize")
async def get_vectorize_config() -> Dict[str, Any]:
    """获取向量化配置"""
    try:
        api_key = os.getenv("VECTORIZE_API_KEY", "")
        return {
            "success": True,
            "config": {
                "base_url": os.getenv("VECTORIZE_BASE_URL", ""),
                "api_key": _mask_api_key(api_key),
                "api_key_full": api_key,
                "model": os.getenv("VECTORIZE_MODEL", "Qwen/Qwen3-Embedding-4B")
            }
        }
    except Exception as exc:
        logger.error(f"[Config] Failed to get Vectorize config: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/config/vectorize")
async def update_vectorize_config(request: Dict[str, Any]) -> Dict[str, Any]:
    """更新向量化配置到 .env 文件"""
    try:
        config_mapping = {
            "base_url": "VECTORIZE_BASE_URL",
            "api_key": "VECTORIZE_API_KEY",
            "model": "VECTORIZE_MODEL"
        }
        result = _update_env_config(request, config_mapping, "Vectorize")

        # 处理 disabled 开关（bool → "1"/"0"，写 .env 并即时生效）
        if "disabled" in request:
            disabled_val = bool(request["disabled"])
            env_str = "1" if disabled_val else "0"
            os.environ["VECTORIZE_DISABLED"] = env_str
            env_path = _get_env_file_path()
            env_lines: list[str] = []
            if env_path.exists():
                with open(env_path, "r", encoding="utf-8") as f:
                    env_lines = f.readlines()
            found = False
            for i, line in enumerate(env_lines):
                if line.strip().startswith("VECTORIZE_DISABLED="):
                    env_lines[i] = f"VECTORIZE_DISABLED={env_str}\n"
                    found = True
                    break
            if not found:
                env_lines.append(f"VECTORIZE_DISABLED={env_str}\n")
            with open(env_path, "w", encoding="utf-8") as f:
                f.writelines(env_lines)
            from agentic_layer.vectorize_service import set_vectorize_disabled
            set_vectorize_disabled(disabled_val)
            logger.info(f"[Config] Vectorize disabled set to: {disabled_val}")

        return result
    except Exception as exc:
        logger.error(f"[Config] Failed to update Vectorize config: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================================================
# Rerank Configuration API
# ============================================================================

@router.get("/config/rerank")
async def get_rerank_config() -> Dict[str, Any]:
    """获取重排序配置"""
    try:
        api_key = os.getenv("RERANK_API_KEY", "")
        return {
            "success": True,
            "config": {
                "base_url": os.getenv("RERANK_BASE_URL", ""),
                "api_key": _mask_api_key(api_key),
                "api_key_full": api_key,
                "model": os.getenv("RERANK_MODEL", "Qwen/Qwen3-Reranker-4B")
            }
        }
    except Exception as exc:
        logger.error(f"[Config] Failed to get Rerank config: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/config/rerank")
async def update_rerank_config(request: Dict[str, Any]) -> Dict[str, Any]:
    """更新重排序配置到 .env 文件"""
    try:
        config_mapping = {
            "base_url": "RERANK_BASE_URL",
            "api_key": "RERANK_API_KEY",
            "model": "RERANK_MODEL"
        }
        return _update_env_config(request, config_mapping, "Rerank")
    except Exception as exc:
        logger.error(f"[Config] Failed to update Rerank config: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================================================
# Chat History Import API
# ============================================================================

@router.post("/import-chat-history", response_model=Dict[str, Any])
async def import_chat_history(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    导入历史聊天记录

    从CSV文件导入聊天记录，进行处理：
    - 切分成 memcell
    - 生成 foresight 和 episode
    - 更新 profile

    Args:
        request: {
            "owner_user_id": "user_id",      # 必填
            "session_key": "微信::行星芯",    # 必填，用于生成conversation_id
            "display_name": "行星芯",         # 必填，联系人显示名称
            "messages": [UnifiedMessage...], # 必填，消息列表
            "batch_size": 20                 # 可选，批次大小，默认20
        }

    Returns:
        {
            "success": True,
            "imported_count": 100,
            "memcell_count": 5,
            "is_new_friend": True,
            "profile_updated": True,
            "contact_profile": {...},
            "error": null
        }
    """
    try:
        owner_user_id = request.get("owner_user_id", "")
        session_key = request.get("session_key", "")
        display_name = request.get("display_name", "unknown")
        raw_messages = request.get("messages", [])
        batch_size = request.get("batch_size", 20)  # 默认批次大小

        if not owner_user_id:
            raise HTTPException(status_code=400, detail="owner_user_id is required")
        if not session_key:
            raise HTTPException(status_code=400, detail="session_key is required")
        if not raw_messages:
            raise HTTPException(status_code=400, detail="messages is required and cannot be empty")

        logger.info(
            f"[Import] Starting chat history import: owner={owner_user_id}, "
            f"session={session_key}, message_count={len(raw_messages)}, batch_size={batch_size}"
        )

        # 转换为UnifiedMessage
        messages = [
            _normalize_process_chat_message(
                dict(msg),
                owner_user_id=owner_user_id,
                session_key=session_key,
                display_name=display_name,
            )
            for msg in raw_messages
        ]

        # 分批处理
        workflow_service = get_chat_workflow_service()
        total_imported = 0
        memcell_count = 0
        profile_updated = False
        user_profile_updated = False
        contact_profile = None

        for i in range(0, len(messages), batch_size):
            batch = messages[i:i + batch_size]

            # 创建导入请求，设置强制处理标志
            chat_request = ChatProcessRequest(
                owner_user_id=owner_user_id,
                session_key=session_key,
                display_name=display_name,
                messages=batch,
                incoming_message=None,
                manual_intent=None,
                force_profile_update=(i == 0),      # 只在第一批更新画像
                force_memory_backfill=True,         # 强制回填历史消息
                allow_memory_replay=(i == 0),       # 仅首批允许重放并清理缓存
            )

            # 执行处理
            result = await workflow_service.process_chat(chat_request)

            total_imported += len(batch)
            if result.success:
                memcell_count += 1
            if result.profile_updated:
                profile_updated = True
            if result.user_profile_updated:
                user_profile_updated = True
            if result.contact_profile:
                contact_profile = result.contact_profile

            logger.info(
                f"[Import] Batch {i // batch_size + 1} completed: "
                f"batch_size={len(batch)}, memcell_count={memcell_count}"
            )

        logger.info(
            f"[Import] Import completed: success=True, "
            f"imported={total_imported}, memcell_count={memcell_count}, "
            f"profile_updated={profile_updated}"
        )

        return {
            "success": True,
            "imported_count": total_imported,
            "memcell_count": memcell_count,
            "is_new_friend": True,
            "profile_updated": profile_updated,
            "user_profile_updated": user_profile_updated,
            "contact_profile": contact_profile.to_dict() if contact_profile else None,
            "error": None,
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"[Import] Failed to import chat history: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/import-chat-history-stream")
async def import_chat_history_stream(request: Dict[str, Any]) -> StreamingResponse:
    """
    导入历史聊天记录（带进度推送）

    使用 Server-Sent Events (SSE) 推送导入进度。

    Args:
        request: {
            "owner_user_id": "user_id",
            "session_key": "微信::行星芯",
            "display_name": "行星芯",
            "messages": [UnifiedMessage...],
            "batch_size": 20
        }

    Returns:
        StreamingResponse with SSE events:
        - data: {"type": "progress", "current": 20, "total": 100, "percentage": 20.0, "memcell_count": 1}
        - data: {"type": "complete", "imported_count": 100, "memcell_count": 5, ...}
        - data: {"type": "error", "error": "error message"}
    """
    import json

    async def generate_progress():
        nonlocal request
        try:
            owner_user_id = request.get("owner_user_id", "")
            session_key = request.get("session_key", "")
            display_name = request.get("display_name", "unknown")
            raw_messages = request.get("messages", [])
            batch_size = request.get("batch_size", 20)

            if not owner_user_id or not session_key or not raw_messages:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Missing required parameters'})}\n\n"
                return

            # 转换为UnifiedMessage
            messages = [
                _normalize_process_chat_message(
                    dict(msg),
                    owner_user_id=owner_user_id,
                    session_key=session_key,
                    display_name=display_name,
                )
                for msg in raw_messages
            ]

            total_messages = len(messages)
            workflow_service = get_chat_workflow_service()
            total_imported = 0
            memcell_count = 0
            profile_updated = False
            contact_profile = None

            for i in range(0, len(messages), batch_size):
                batch = messages[i:i + batch_size]

                # Only clear Redis on first batch, preserve history for subsequent batches
                is_first_batch = (i == 0)

                chat_request = ChatProcessRequest(
                    owner_user_id=owner_user_id,
                    session_key=session_key,
                    display_name=display_name,
                    messages=batch,
                    incoming_message=None,
                    manual_intent=None,
                    force_profile_update=is_first_batch,
                    force_memory_backfill=is_first_batch,
                    allow_memory_replay=is_first_batch,
                    is_historical_import=True,  # All batches use historical import mode
                )

                result = await workflow_service.process_chat(chat_request)

                total_imported += len(batch)
                if result.success:
                    memcell_count += 1
                if result.profile_updated:
                    profile_updated = True
                if result.contact_profile:
                    contact_profile = result.contact_profile

                # 推送进度
                progress = {
                    "type": "progress",
                    "current": min(i + batch_size, total_messages),
                    "total": total_messages,
                    "percentage": round(total_imported / total_messages * 100, 1),
                    "memcell_count": memcell_count
                }
                yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"

            # 完成推送
            final_result = {
                "type": "complete",
                "success": True,
                "imported_count": total_imported,
                "memcell_count": memcell_count,
                "profile_updated": profile_updated,
                "contact_profile": contact_profile.to_dict() if contact_profile else None
            }
            yield f"data: {json.dumps(final_result, ensure_ascii=False)}\n\n"

        except Exception as exc:
            logger.error(f"[Import Stream] Error: {exc}")
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate_progress(), media_type="text/event-stream")


class DeleteMessagesRequest(BaseModel):
    message_ids: List[str]


@router.delete("/messages")
async def delete_messages(request: DeleteMessagesRequest):
    """Delete specific conversation messages by message_id."""
    if not request.message_ids:
        raise HTTPException(status_code=400, detail="message_ids cannot be empty")
    deleted = await _get_conversation_message_repo().delete_by_message_ids(request.message_ids)
    return {"deleted": deleted}
