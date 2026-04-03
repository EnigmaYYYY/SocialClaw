from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


SenderType = Literal["user", "contact", "unknown"]


@dataclass(slots=True)
class ChatQuotedMessage:
    text: str
    sender_name: str | None = None


@dataclass(slots=True)
class ChatMessage:
    sender: SenderType
    text: str
    contact_name: str | None = None
    timestamp: str | None = None
    quoted_message: ChatQuotedMessage | None = None


@dataclass(slots=True)
class ReplySuggestion:
    reply: str
    reason: str
