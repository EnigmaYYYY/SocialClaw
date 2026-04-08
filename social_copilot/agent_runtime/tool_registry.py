from __future__ import annotations

from typing import Any

from social_copilot.agent.prompting import (
    format_chat_transcript,
    resolve_last_sender,
    summarize_profile,
    summarize_user_style,
)
from social_copilot.agent_runtime.models import AssistantToolContext, ToolDefinition, VLMToolContext


class ToolRegistry:
    def build_assistant_tools(self, context: AssistantToolContext) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="get_assistant_context",
                description="Read the full assistant generation context including messages, profiles, and constraints.",
                input_schema=_object_schema(),
                handler=lambda _: context.to_payload(),
            ),
            ToolDefinition(
                name="get_chat_transcript",
                description="Read the chat transcript in a readable text format.",
                input_schema=_limit_schema(default=context.max_messages),
                handler=lambda args: {
                    "transcript": format_chat_transcript(context.chat_messages[-_bounded_limit(args, context.max_messages) :])
                },
            ),
            ToolDefinition(
                name="get_recent_messages",
                description="Read recent chat messages as structured JSON rows.",
                input_schema=_limit_schema(default=context.max_messages),
                handler=lambda args: {
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
                        for item in context.chat_messages[-_bounded_limit(args, context.max_messages) :]
                    ]
                },
            ),
            ToolDefinition(
                name="get_user_profile",
                description="Read the current user profile summary.",
                input_schema=_object_schema(),
                handler=lambda _: {"user_profile": summarize_profile(context.user_profile)},
            ),
            ToolDefinition(
                name="get_contact_profile",
                description="Read the current contact profile summary.",
                input_schema=_object_schema(),
                handler=lambda _: {"contact_profile": summarize_profile(context.contact_profile)},
            ),
            ToolDefinition(
                name="get_style_summary",
                description="Read the user's observed chat style summary from recent messages.",
                input_schema=_object_schema(),
                handler=lambda _: {"style_summary": summarize_user_style(context.chat_messages)},
            ),
            ToolDefinition(
                name="get_generation_constraints",
                description="Read the reply generation constraints including count and turn guidance.",
                input_schema=_object_schema(),
                handler=lambda _: {
                    "suggestion_count": context.suggestion_count,
                    "max_messages": context.max_messages,
                    "last_sender": resolve_last_sender(context.chat_messages),
                    "must_return_json": True,
                    "language": "zh-CN",
                },
            ),
        ]

    def build_vlm_tools(self, context: VLMToolContext) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name="get_visual_task_context",
                description="Read the current visual extraction task context.",
                input_schema=_object_schema(),
                handler=lambda _: context.to_payload(),
            ),
            ToolDefinition(
                name="get_expected_conversation_title",
                description="Read the last confirmed conversation title hint for the current window.",
                input_schema=_object_schema(),
                handler=lambda _: {
                    "expected_conversation_title": context.expected_conversation_title,
                    "extraction_mode": context.extraction_mode,
                },
            ),
            ToolDefinition(
                name="get_output_schema",
                description="Read the required JSON output schema for structured WeChat extraction.",
                input_schema=_object_schema(),
                handler=lambda _: {"output_schema": context.output_schema},
            ),
        ]


def _object_schema() -> dict[str, Any]:
    return {"type": "object", "properties": {}, "additionalProperties": False}


def _limit_schema(default: int) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "minimum": 1, "maximum": max(1, default)},
        },
        "additionalProperties": False,
    }


def _bounded_limit(arguments: dict[str, Any], fallback: int) -> int:
    value = arguments.get("limit", fallback)
    try:
        parsed = int(value)
    except Exception:
        return fallback
    return max(1, min(parsed, fallback))
