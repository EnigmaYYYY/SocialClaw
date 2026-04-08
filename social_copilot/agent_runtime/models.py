from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from social_copilot.agent.models import ChatMessage

ToolHandler = Callable[[dict[str, Any]], Any]


@dataclass(slots=True)
class SkillDefinition:
    skill_id: str
    name: str
    description: str
    body: str
    path: Path


@dataclass(slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: ToolHandler

    def to_openai_tool(self) -> dict[str, object]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }


@dataclass(slots=True)
class ToolCallRequest:
    id: str
    name: str
    arguments_text: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class ToolExecutionRecord:
    tool_call_id: str
    name: str
    arguments: dict[str, Any]
    result: Any
    ok: bool


@dataclass(slots=True)
class RuntimeTrace:
    raw_responses: list[str] = field(default_factory=list)
    response_headers: list[dict[str, str]] = field(default_factory=list)
    roundtrip_ms: list[float] = field(default_factory=list)
    tool_executions: list[ToolExecutionRecord] = field(default_factory=list)

    def total_roundtrip_ms(self) -> float:
        return sum(self.roundtrip_ms)

    def last_headers(self) -> dict[str, str]:
        if not self.response_headers:
            return {}
        return self.response_headers[-1]


@dataclass(slots=True)
class AgentRuntimeResult:
    final_content: str
    selected_skill_ids: list[str]
    trace: RuntimeTrace

    @property
    def raw_response(self) -> str:
        if not self.trace.raw_responses:
            return ""
        return self.trace.raw_responses[-1]


@dataclass(slots=True)
class AssistantToolContext:
    chat_messages: list[ChatMessage]
    suggestion_count: int
    max_messages: int
    user_profile: dict[str, Any] | None = None
    contact_profile: dict[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "suggestion_count": self.suggestion_count,
            "max_messages": self.max_messages,
            "user_profile": self.user_profile or {},
            "contact_profile": self.contact_profile or {},
            "messages": [
                {
                    "sender": item.sender,
                    "text": item.text,
                    "contact_name": item.contact_name,
                    "timestamp": item.timestamp,
                    "quoted_message": (
                        None
                        if item.quoted_message is None
                        else {
                            "text": item.quoted_message.text,
                            "sender_name": item.quoted_message.sender_name,
                        }
                    ),
                }
                for item in self.chat_messages
            ],
        }


@dataclass(slots=True)
class VLMToolContext:
    expected_conversation_title: str | None
    extraction_mode: Literal["snapshot", "incremental"]
    image_count: int
    output_schema: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "expected_conversation_title": self.expected_conversation_title,
            "extraction_mode": self.extraction_mode,
            "image_count": self.image_count,
            "output_schema": json.loads(json.dumps(self.output_schema)),
        }
