"""Evidence utilities shared across profile normalization helpers."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Set

from core.observation.logger import get_logger

logger = get_logger(__name__)

ALLOWED_OPINION_TENDENCY_TYPES = {
    "stance",
    "suggestion",
    "his own opinion",
}


def ensure_str_list(value: Any) -> List[str]:
    """Convert arbitrary values into a deduplicated list of stripped strings.

    Supports both old format (string list) and new format (dict list with reasoning).
    Returns only event_id strings for backward compatibility.
    """
    if not value:
        return []
    if isinstance(value, list):
        result: List[str] = []
        for item in value:
            if item is None:
                continue
            if isinstance(item, dict):
                event_id = item.get("event_id", "")
                if event_id:
                    text = (
                        event_id.strip()
                        if isinstance(event_id, str)
                        else str(event_id).strip()
                    )
                    if text and text not in result:
                        result.append(text)
            elif isinstance(item, str):
                text = item.strip()
                if text and text not in result:
                    result.append(text)
            else:
                text = str(item).strip()
                if text and text not in result:
                    result.append(text)
        return result
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, dict):
        event_id = value.get("event_id", "")
        if event_id:
            text = (
                event_id.strip()
                if isinstance(event_id, str)
                else str(event_id).strip()
            )
            return [text] if text else []
    text = str(value).strip()
    return [text] if text else []


def ensure_evidence_dict_list(value: Any) -> List[Dict[str, str]]:
    """Convert arbitrary evidence values into canonical dict evidences.

    Canonical evidence format:
    [{"event_id": "...", "reasoning": "..."}]
    """
    if not value:
        return []

    if isinstance(value, list):
        result: List[Dict[str, str]] = []
        index_by_event_id: Dict[str, int] = {}
        for item in value:
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

    if isinstance(value, str):
        text = value.strip()
        return [{"event_id": text, "reasoning": ""}] if text else []

    if isinstance(value, dict):
        event_id = value.get("event_id", "")
        reasoning = value.get("reasoning", "")
        if event_id:
            event_id_str = (
                event_id.strip() if isinstance(event_id, str) else str(event_id).strip()
            )
            if event_id_str:
                return [
                    {
                        "event_id": event_id_str,
                        "reasoning": (
                            reasoning.strip()
                            if isinstance(reasoning, str)
                            else str(reasoning).strip()
                        )
                        if reasoning
                        else "",
                    }
                ]

    return []


def filter_opinion_tendency_by_type(entries: Any) -> Any:
    """Filter opinion_tendency items, keeping only allowed type values."""
    if not isinstance(entries, list) or not entries:
        return entries

    filtered: List[Dict[str, Any]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        raw_type = item.get("type")
        if raw_type is None:
            continue
        normalized_type = str(raw_type).strip().lower()
        if normalized_type in ALLOWED_OPINION_TENDENCY_TYPES:
            filtered.append(item)
        else:
            logger.info(
                "Removing opinion_tendency item type %s, content=%s, evidences=%s",
                raw_type,
                item.get("value"),
                item.get("evidences"),
            )
    return filtered


def format_evidence_entry(
    value: Any,
    *,
    conversation_date_map: Optional[Dict[str, str]],
) -> Optional[str]:
    """Format evidence entries to include the appropriate date prefix."""
    if value is None:
        return None
    item_str = value.strip() if isinstance(value, str) else str(value).strip()
    if not item_str:
        return None
    if "|" in item_str:
        return item_str

    conversation_id = conversation_id_from_evidence(item_str)
    if conversation_id:
        normalized_key = conversation_id
    elif "conversation_id" in item_str:
        normalized_key = item_str.split("conversation_id:")[-1].strip("[] ") or item_str
    else:
        normalized_key = item_str

    evidence_date: Optional[str] = None
    if conversation_id and conversation_date_map:
        evidence_date = conversation_date_map.get(conversation_id)
    if evidence_date:
        return f"{evidence_date}|{normalized_key}"
    return normalized_key


def conversation_id_from_evidence(evidence: Any) -> Optional[str]:
    """Extract the conversation identifier from a formatted evidence entry."""
    if isinstance(evidence, dict):
        evidence = evidence.get("event_id")
    if not isinstance(evidence, str):
        return None
    entry = evidence.strip()
    if not entry:
        return None
    if "|" in entry:
        entry = entry.split("|")[-1].strip()
    if "conversation_id:" in entry:
        entry = entry.split("conversation_id:")[-1]
    return entry.strip("[] ") or None


def _strip_evidences_for_identifier(value: Any) -> Any:
    """Remove evidences recursively for comparison purposes."""
    if isinstance(value, dict):
        return {
            key: _strip_evidences_for_identifier(val)
            for key, val in value.items()
            if key != "evidences"
        }
    if isinstance(value, list):
        return [_strip_evidences_for_identifier(item) for item in value]
    return value


def _build_item_identifier(item: Dict[str, Any]) -> Optional[str]:
    """Generate a structural signature for matching list entries."""
    if not isinstance(item, dict):
        return None
    stripped = _strip_evidences_for_identifier(item)
    if not stripped:
        return None
    try:
        return json.dumps(stripped, sort_keys=True, ensure_ascii=False)
    except TypeError:
        return None


def _find_matching_item(
    items: List[Any],
    completed_item: Any,
) -> Optional[Any]:
    """Locate the list item corresponding to the completed entry."""
    if not isinstance(completed_item, dict):
        return None

    identifier = _build_item_identifier(completed_item)
    if identifier:
        for candidate in items:
            if isinstance(candidate, dict) and _build_item_identifier(candidate) == identifier:
                return candidate

    value_keys = (
        "value",
        "skill",
        "project_id",
        "project_name",
        "user_id",
        "name",
        "title",
    )
    for key in value_keys:
        candidate_value = completed_item.get(key)
        if candidate_value is None or candidate_value == "":
            continue
        normalized_candidate = str(candidate_value).strip()
        if not normalized_candidate:
            continue
        for candidate in items:
            if not isinstance(candidate, dict):
                continue
            existing_value = candidate.get(key)
            if existing_value is None or existing_value == "":
                continue
            if str(existing_value).strip() == normalized_candidate:
                return candidate

    return None


def _format_and_validate_evidences(
    evidences: Any,
    *,
    valid_conversation_ids: Optional[Set[str]],
    conversation_date_map: Optional[Dict[str, str]],
) -> List[Dict[str, str]]:
    """Format evidences into canonical dict format and validate conversation IDs."""
    formatted: List[Dict[str, str]] = []
    index_by_event_id: Dict[str, int] = {}

    for evidence in ensure_evidence_dict_list(evidences):
        event_id = evidence.get("event_id", "").strip()
        if not event_id:
            continue

        conversation_id = conversation_id_from_evidence(event_id) or event_id
        if (
            valid_conversation_ids is not None
            and conversation_id
            and conversation_id not in valid_conversation_ids
        ):
            logger.warning(
                "Evidence completion produced unknown conversation ID %s",
                conversation_id,
            )
            continue

        formatted_entry = format_evidence_entry(
            conversation_id,
            conversation_date_map=conversation_date_map,
        )
        if not formatted_entry:
            continue

        existing_index = index_by_event_id.get(formatted_entry)
        reasoning = evidence.get("reasoning", "").strip()
        if existing_index is None:
            formatted.append({"event_id": formatted_entry, "reasoning": reasoning})
            index_by_event_id[formatted_entry] = len(formatted) - 1
        elif reasoning and not formatted[existing_index].get("reasoning"):
            formatted[existing_index]["reasoning"] = reasoning

    return formatted


def merge_evidences_recursive(
    original: Any,
    completed: Any,
    *,
    valid_conversation_ids: Optional[Set[str]],
    conversation_date_map: Optional[Dict[str, str]],
    path: str = "user_profile",
) -> None:
    """Recursively merge evidences from the completed payload into the original."""
    if isinstance(original, dict) and isinstance(completed, dict):
        if "evidences" in completed and isinstance(completed["evidences"], list):
            formatted = _format_and_validate_evidences(
                completed["evidences"],
                valid_conversation_ids=valid_conversation_ids,
                conversation_date_map=conversation_date_map,
            )
            if formatted:
                original["evidences"] = formatted
                logger.info(
                    "Added %d evidence(s) to path: %s",
                    len(formatted),
                    path,
                )
        for key, value in completed.items():
            if key == "evidences":
                continue
            if key in original:
                merge_evidences_recursive(
                    original[key],
                    value,
                    valid_conversation_ids=valid_conversation_ids,
                    conversation_date_map=conversation_date_map,
                    path=f"{path}.{key}",
                )
        return

    if isinstance(original, list) and isinstance(completed, list):
        for completed_item in completed:
            target_item = _find_matching_item(original, completed_item)
            if target_item is None:
                continue
            target_idx = original.index(target_item)
            merge_evidences_recursive(
                target_item,
                completed_item,
                valid_conversation_ids=valid_conversation_ids,
                conversation_date_map=conversation_date_map,
                path=f"{path}[{target_idx}]",
            )


def remove_entries_without_evidence(payload: Any, *, path: str = "user_profile") -> Any:
    """Recursively remove entries that lack evidences after completion."""
    if isinstance(payload, dict):
        for key in list(payload.keys()):
            if key == "evidences":
                continue
            cleaned = remove_entries_without_evidence(
                payload[key], path=f"{path}.{key}"
            )
            if cleaned is None:
                payload.pop(key, None)
            else:
                payload[key] = cleaned

        if "evidences" in payload:
            normalized = ensure_evidence_dict_list(payload["evidences"])
            if not normalized:
                logger.debug("Removing entry at %s due to empty evidences", path)
                return None
            payload["evidences"] = normalized

        if not payload:
            return None
        return payload

    if isinstance(payload, list):
        sanitized: List[Any] = []
        for index, item in enumerate(payload):
            cleaned = remove_entries_without_evidence(item, path=f"{path}[{index}]")
            if cleaned is None:
                continue
            sanitized.append(cleaned)
        return sanitized

    return payload


__all__ = [
    "ensure_str_list",
    "ensure_evidence_dict_list",
    "filter_opinion_tendency_by_type",
    "format_evidence_entry",
    "conversation_id_from_evidence",
    "merge_evidences_recursive",
    "remove_entries_without_evidence",
]
