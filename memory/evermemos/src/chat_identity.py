"""Pure helpers for resolving chat-level and speaker-level identities."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, OrderedDict, Tuple

from api_specs.unified_types import SenderType, UnifiedMessage, generate_target_user_id


@dataclass(frozen=True)
class ResolvedContactTarget:
    target_user_id: str
    display_name: str


@dataclass(frozen=True)
class ResolvedChatIdentity:
    is_group_chat: bool
    primary_target_user_id: str
    contact_targets: List[ResolvedContactTarget]


def resolve_chat_identity(
    messages: Iterable[UnifiedMessage],
    *,
    owner_user_id: str,
    session_key: str,
) -> ResolvedChatIdentity:
    """Resolve whether a conversation is one-to-one or group chat.

    Rules:
    - One contact speaker -> keep the legacy session-level target user id.
    - More than one contact speaker -> treat each speaker as an independent contact target.
    """

    speaker_order: "OrderedDict[str, str]" = OrderedDict()
    for message in messages:
        if message.sender_type == SenderType.USER:
            continue
        speaker_id = (message.sender_id or "").strip()
        if not speaker_id or speaker_id == owner_user_id:
            continue
        if speaker_id not in speaker_order:
            speaker_order[speaker_id] = _normalize_display_name(message.sender_name, speaker_id)

    if len(speaker_order) <= 1:
        primary_target_user_id = generate_target_user_id(session_key, owner_user_id)
        display_name = next(iter(speaker_order.values()), "")
        if not display_name:
            display_name = session_key.split("::", 1)[-1] if "::" in session_key else session_key
        return ResolvedChatIdentity(
            is_group_chat=False,
            primary_target_user_id=primary_target_user_id,
            contact_targets=[
                ResolvedContactTarget(
                    target_user_id=primary_target_user_id,
                    display_name=display_name,
                )
            ],
        )

    contact_targets = [
        ResolvedContactTarget(target_user_id=speaker_id, display_name=speaker_name)
        for speaker_id, speaker_name in speaker_order.items()
    ]
    return ResolvedChatIdentity(
        is_group_chat=True,
        primary_target_user_id=contact_targets[0].target_user_id,
        contact_targets=contact_targets,
    )


def _normalize_display_name(display_name: str, fallback: str) -> str:
    normalized = (display_name or "").strip()
    return normalized or fallback
