from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class VLMConversation(BaseModel):
    display_title: str | None = None
    title_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    title_source: str | None = None


class VLMVisibleTimeMarker(BaseModel):
    value: str
    source: str
    position_hint: str | None = None


class VLMTimeAnchor(BaseModel):
    value: str | None = None
    source: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class VLMSelectedSessionTimeHint(BaseModel):
    value: str | None = None
    source: str


class VLMWindowTimeContext(BaseModel):
    visible_time_markers: list[VLMVisibleTimeMarker] = Field(default_factory=list)
    selected_session_time_hint: VLMSelectedSessionTimeHint | None = None


class VLMQuotedMessage(BaseModel):
    text: str
    sender_name: str | None = None


class VLMStructuredMessage(BaseModel):
    sender: Literal["user", "contact", "unknown"] = "unknown"
    contact_name: str | None = None
    text: str = ""
    content_type: Literal["text", "emoji", "sticker", "image", "mixed", "unknown"] = "text"
    non_text_description: str | None = None
    non_text_signature_parts: list[str] | None = None
    quoted_message: VLMQuotedMessage | None = None
    time_anchor: VLMTimeAnchor | None = None
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_content_fields(self) -> "VLMStructuredMessage":
        has_text = bool(self.text.strip())
        has_non_text = bool((self.non_text_description or "").strip())
        if not has_text and not has_non_text:
            raise ValueError("Either text or non_text_description must be provided.")
        return self


class VLMStructuredPayload(BaseModel):
    schema_version: str | None = None
    app_name: str | None = None
    capture_time: str | None = None
    conversation: VLMConversation | None = None
    conversation_title: str | None = None
    window_time_context: VLMWindowTimeContext | None = None
    messages: list[VLMStructuredMessage] = Field(default_factory=list)
    extraction_meta: dict[str, object] | None = None
