from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class QuotedMessage(BaseModel):
    text: str
    sender_name: str | None = None


class FrameEvent(BaseModel):
    frame_id: str
    ts_capture: datetime
    roi_id: str
    window_id: str
    session_id: str
    dpi_scale: float = Field(default=1.0, gt=0)
    frame_hash: str
    image: bytes | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ParsedMessage(BaseModel):
    sender: Literal["user", "contact", "unknown"]
    text: str
    box: list[int]
    confidence: float = Field(ge=0, le=1)
    source_frame: str
    contact_name: str | None = None
    contact_name_explicit: bool = False
    content_type: str | None = None
    non_text_description: str | None = None
    non_text_signature: str | None = None
    quoted_message: QuotedMessage | None = None
    time_anchor: str | None = None


class MessageEvent(BaseModel):
    event_id: str
    timestamp: datetime
    session_id: str
    session_key: str
    window_id: str
    roi: dict[str, int]
    frame_id: str

    sender: Literal["user", "contact", "unknown"]
    text: str
    contact_name: str | None = None
    conversation_title: str | None = None
    content_type: str | None = None
    non_text_description: str | None = None
    non_text_signature: str | None = None
    quoted_message: QuotedMessage | None = None
    time_anchor: str | None = None

    box: list[int]
    extraction_confidence: float = Field(ge=0, le=1)
    extraction_engine: str

    frame_hash: str
    similarity_score: float = Field(ge=0, le=1)
    dedup_reason: str

    monitor_profile: str
