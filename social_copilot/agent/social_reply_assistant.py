from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, cast

from social_copilot.agent.models import ChatMessage, ReplySuggestion, SenderType
from social_copilot.agent.openai_compatible import OpenAICompatibleClient
from social_copilot.agent.prompting import build_social_reply_prompts

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class SocialReplyAssistantResult:
    suggestions: list[ReplySuggestion]
    raw_model_response: str
    system_prompt: str
    user_prompt: str


class SocialReplyAssistant:
    def __init__(self, client: OpenAICompatibleClient, suggestion_count: int = 3) -> None:
        if suggestion_count <= 0:
            raise ValueError("suggestion_count must be > 0")
        self._client = client
        self._suggestion_count = suggestion_count

    def generate(
        self,
        chat_messages: list[ChatMessage],
        max_messages: int = 24,
        user_profile: dict[str, Any] | None = None,
        contact_profile: dict[str, Any] | None = None,
    ) -> SocialReplyAssistantResult:
        system_prompt, user_prompt = build_social_reply_prompts(
            chat_messages=chat_messages,
            suggestion_count=self._suggestion_count,
            max_messages=max_messages,
            user_profile=user_profile,
            contact_profile=contact_profile,
        )
        _terminal_trace("System Prompt", system_prompt)
        _terminal_trace("User Prompt", user_prompt)
        raw = self._client.chat_completion(system_prompt=system_prompt, user_prompt=user_prompt)
        _terminal_trace("Model Response", raw)
        suggestions = _parse_suggestions(raw, expected=self._suggestion_count)
        return SocialReplyAssistantResult(
            suggestions=suggestions,
            raw_model_response=raw,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        )


def extract_chat_messages_from_payload(payload: object) -> list[ChatMessage]:
    if isinstance(payload, dict):
        if isinstance(payload.get("events"), list):
            rows = payload.get("events", [])
        elif isinstance(payload.get("messages"), list):
            rows = payload.get("messages", [])
        else:
            rows = []
    elif isinstance(payload, list):
        rows = payload
    else:
        rows = []

    messages: list[ChatMessage] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        sender = str(row.get("sender", "unknown")).strip().lower()
        if sender not in {"user", "contact", "unknown"}:
            sender = "unknown"
        text = str(row.get("text", "")).strip()
        if not text:
            continue
        contact_name_raw = row.get("contact_name")
        contact_name = str(contact_name_raw).strip() if isinstance(contact_name_raw, str) else None
        timestamp_raw = row.get("timestamp")
        timestamp = str(timestamp_raw).strip() if isinstance(timestamp_raw, str) else None
        messages.append(
            ChatMessage(
                sender=cast(SenderType, sender),
                text=text,
                contact_name=contact_name or None,
                timestamp=timestamp or None,
            )
        )
    return messages


def _parse_suggestions(raw: str, expected: int) -> list[ReplySuggestion]:
    cleaned = raw.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid_json_response:{exc}") from exc

    if isinstance(payload, dict):
        raw_items = payload.get("suggestions", [])
    elif isinstance(payload, list):
        raw_items = payload
    else:
        raw_items = []

    suggestions: list[ReplySuggestion] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        reply_raw = item.get("reply", item.get("content", ""))
        reason_raw = item.get("reason", item.get("why", ""))
        reply = str(reply_raw).strip()
        reason = str(reason_raw).strip()
        if not reply or not reason:
            continue
        suggestions.append(ReplySuggestion(reply=reply, reason=reason))

    if len(suggestions) < expected:
        raise RuntimeError(f"suggestions_not_enough:expected={expected},actual={len(suggestions)}")
    return suggestions[:expected]


def _terminal_trace(title: str, content: str) -> None:
    prefix = f"🐳🐳🐳 [VisualMonitor][LLM] {title}:"
    print(f"{prefix}\\n{content}")
    logger.info("%s\\n%s", prefix, content)
