from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from social_copilot.agent.models import ChatMessage, ChatQuotedMessage
from social_copilot.agent.openai_compatible import OpenAICompatibleClient, OpenAICompatibleConfig
from social_copilot.agent.social_reply_assistant import SocialReplyAssistant

router = APIRouter(prefix="/assistant", tags=["assistant"])


class AssistantQuotedMessage(BaseModel):
    text: str
    sender_name: str | None = None


class AssistantInputMessage(BaseModel):
    sender: Literal["user", "contact", "unknown"] = "unknown"
    text: str
    contact_name: str | None = None
    timestamp: str | None = None
    quoted_message: AssistantQuotedMessage | None = None


class AssistantSuggestionRequest(BaseModel):
    messages: list[AssistantInputMessage] = Field(default_factory=list)
    suggestion_count: int | None = Field(default=None, ge=1, le=6)
    max_messages: int | None = Field(default=None, ge=4, le=120)
    user_profile: dict[str, object] | None = None
    contact_profile: dict[str, object] | None = None
    owner_user_id: str | None = None
    session_key: str | None = None


def _to_evermemos_msg(msg: AssistantInputMessage) -> dict[str, object]:
    """Convert an AssistantInputMessage to EverMemOS UnifiedMessage dict format.

    Maps Visual Monitor's lightweight format to the full UnifiedMessage schema
    that EverMemOS expects, including required fields like message_id and
    conversation_id.
    """
    now_ts = datetime.now(tz=timezone.utc).isoformat()
    return {
        "message_id": str(uuid.uuid4()),
        "conversation_id": "",
        "sender_id": msg.sender,
        "sender_name": msg.contact_name or msg.sender,
        "sender_type": msg.sender,
        "content": msg.text,
        "timestamp": msg.timestamp or now_ts,
        "content_type": "text",
    }


async def _try_evermemos_suggestion(
    payload: AssistantSuggestionRequest,
) -> dict[str, object] | None:
    """Try EverMemOS reply-suggestion API (memory-enhanced).

    Returns a suggestion dict if EverMemOS returns a valid reply, else None.
    The EverMemOS URL is read from EVERMEMOS_REPLY_URL env var.
    """
    evermemos_url = os.getenv("EVERMEMOS_REPLY_URL", "").strip()
    if not evermemos_url or not payload.owner_user_id:
        return None

    last_msg = payload.messages[-1] if payload.messages else None
    if not last_msg:
        return None

    # Use session_key as conversation_id for EverMemOS to look up profiles/episodes
    conversation_id = payload.session_key or ""

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                evermemos_url,
                json={
                    "conversation_id": conversation_id,
                    "owner_user_id": payload.owner_user_id,
                    "incoming_message": _to_evermemos_msg(last_msg),
                    "messages": [_to_evermemos_msg(m) for m in payload.messages],
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                reply_text = data.get("reply_text") or data.get("reply")
                if reply_text:
                    return {
                        "count": 1,
                        "suggestions": [
                            {
                                "reply": reply_text,
                                "content": reply_text,
                                "reason": "EverMemOS memory-enhanced suggestion",
                            }
                        ],
                        "meta": {
                            "source": "evermemos",
                            "model": "evermemos-reply-generator",
                        },
                    }
    except Exception:
        pass
    return None


@router.post("/suggestions")
async def assistant_suggestions(
    payload: AssistantSuggestionRequest,
    request: Request,
) -> dict[str, object]:
    cfg = request.app.state.monitor_service.get_config()
    assistant_cfg = cfg.monitor.assistant
    if not assistant_cfg.enabled:
        raise HTTPException(status_code=400, detail="assistant_disabled")

    if not payload.messages:
        raise HTTPException(status_code=400, detail="messages_required")

    # ── 优先尝试 EverMemOS 记忆增强建议 ──
    evermemos_result = await _try_evermemos_suggestion(payload)
    if evermemos_result:
        return evermemos_result

    # ── Fallback: 本地 SocialReplyAssistant ──
    chat_messages = [
        ChatMessage(
            sender=item.sender,
            text=item.text,
            contact_name=item.contact_name,
            timestamp=item.timestamp,
            quoted_message=(
                None
                if item.quoted_message is None
                else ChatQuotedMessage(
                    text=item.quoted_message.text,
                    sender_name=item.quoted_message.sender_name,
                )
            ),
        )
        for item in payload.messages
        if item.text.strip()
    ]
    if not chat_messages:
        raise HTTPException(status_code=400, detail="messages_required")

    suggestion_count = payload.suggestion_count or assistant_cfg.suggestion_count
    max_messages = payload.max_messages or assistant_cfg.max_messages

    client = OpenAICompatibleClient(
        OpenAICompatibleConfig(
            base_url=assistant_cfg.base_url,
            model=assistant_cfg.model,
            api_key=assistant_cfg.api_key,
            api_key_env=assistant_cfg.api_key_env,
            timeout_ms=assistant_cfg.timeout_ms,
            temperature=assistant_cfg.temperature,
            max_tokens=assistant_cfg.max_tokens,
        )
    )
    assistant = SocialReplyAssistant(client=client, suggestion_count=suggestion_count)

    try:
        result = assistant.generate(
            chat_messages=chat_messages,
            max_messages=max_messages,
            user_profile=payload.user_profile,
            contact_profile=payload.contact_profile,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"assistant_generation_failed:{exc}") from exc

    suggestions = [
        {
            "reply": item.reply,
            "content": item.reply,
            "reason": item.reason,
        }
        for item in result.suggestions
    ]
    return {
        "count": len(suggestions),
        "suggestions": suggestions,
        "meta": {
            "source": "local_assistant",
            "messages_used": min(len(chat_messages), max_messages),
            "suggestion_count": suggestion_count,
            "model": assistant_cfg.model,
        },
    }
