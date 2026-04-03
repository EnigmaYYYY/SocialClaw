from __future__ import annotations

import json

from social_copilot.visual_monitor.models.vlm_structured import VLMStructuredMessage, VLMStructuredPayload


def parse_vlm_structured_payload(content: str) -> VLMStructuredPayload | None:
    payload_obj = _extract_json_obj(content)
    if payload_obj is None:
        return None
    try:
        return VLMStructuredPayload.model_validate(payload_obj)
    except Exception:
        return None


def parse_vlm_structured_content(content: str) -> tuple[list[VLMStructuredMessage], bool, str | None]:
    payload = parse_vlm_structured_payload(content)
    if payload is None:
        return [], False, None
    title = (payload.conversation_title or "").strip() or None
    if not title and payload.conversation is not None:
        title = (payload.conversation.display_title or "").strip() or None
    return payload.messages, True, title


def _extract_json_obj(raw: str) -> dict | None:
    text = raw.strip()
    if not text:
        return None
    if text.startswith("```"):
        lines = [line for line in text.splitlines() if not line.strip().startswith("```")]
        text = "\n".join(lines).strip()
    try:
        loaded = json.loads(text)
        return loaded if isinstance(loaded, dict) else None
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    candidate = text[start : end + 1]
    try:
        loaded = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    return loaded if isinstance(loaded, dict) else None
