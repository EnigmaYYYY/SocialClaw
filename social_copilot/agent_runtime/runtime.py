from __future__ import annotations

import json
from typing import Any

from social_copilot.agent_runtime.models import (
    AgentRuntimeResult,
    RuntimeTrace,
    SkillDefinition,
    ToolCallRequest,
    ToolDefinition,
    ToolExecutionRecord,
)


class AgentRuntime:
    def __init__(
        self,
        client: object,
        max_iterations: int = 4,
        max_tool_calls_per_round: int = 8,
    ) -> None:
        self._client = client
        self._max_iterations = max(1, max_iterations)
        self._max_tool_calls_per_round = max(1, max_tool_calls_per_round)

    def run(
        self,
        skills: list[SkillDefinition],
        user_messages: list[dict[str, Any]],
        tools: list[ToolDefinition] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
    ) -> AgentRuntimeResult:
        if not skills:
            raise RuntimeError("agent_runtime_missing_skills")

        trace = RuntimeTrace()
        conversation: list[dict[str, Any]] = [
            {"role": "system", "content": _build_runtime_system_prompt(skills)}
        ]
        conversation.extend(user_messages)
        tool_map = {item.name: item for item in tools or []}
        openai_tools = [item.to_openai_tool() for item in tools or []]
        final_content = ""

        for _ in range(self._max_iterations):
            response = self._client.chat(
                messages=conversation,
                tools=openai_tools or None,
                tool_choice="auto" if openai_tools else None,
                temperature=temperature,
                max_tokens=max_tokens,
                extra_body=extra_body,
            )
            trace.raw_responses.append(response.raw_response)
            trace.response_headers.append(response.headers)
            trace.roundtrip_ms.append(response.roundtrip_ms)
            if response.tool_calls:
                assistant_message: dict[str, Any] = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": item.id,
                            "type": "function",
                            "function": {
                                "name": item.name,
                                "arguments": item.arguments_text,
                            },
                        }
                        for item in response.tool_calls[: self._max_tool_calls_per_round]
                    ],
                }
                if response.content:
                    assistant_message["content"] = response.content
                conversation.append(assistant_message)
                for item in response.tool_calls[: self._max_tool_calls_per_round]:
                    tool_output, ok = self._execute_tool_call(tool_map, item)
                    trace.tool_executions.append(
                        ToolExecutionRecord(
                            tool_call_id=item.id,
                            name=item.name,
                            arguments=item.arguments,
                            result=tool_output,
                            ok=ok,
                        )
                    )
                    conversation.append(
                        {
                            "role": "tool",
                            "tool_call_id": item.id,
                            "content": json.dumps(tool_output, ensure_ascii=False),
                        }
                    )
                continue
            final_content = response.content.strip()
            break
        else:
            raise RuntimeError("agent_runtime_iterations_exhausted")

        return AgentRuntimeResult(
            final_content=final_content,
            selected_skill_ids=[item.skill_id for item in skills],
            trace=trace,
        )

    def _execute_tool_call(
        self,
        tool_map: dict[str, ToolDefinition],
        tool_call: ToolCallRequest,
    ) -> tuple[Any, bool]:
        tool = tool_map.get(tool_call.name)
        if tool is None:
            return {"ok": False, "error": f"unknown_tool:{tool_call.name}"}, False
        try:
            result = tool.handler(tool_call.arguments)
        except Exception as exc:
            return {"ok": False, "error": f"tool_execution_failed:{tool_call.name}:{exc}"}, False
        return {"ok": True, "result": result}, True


def _build_runtime_system_prompt(skills: list[SkillDefinition]) -> str:
    sections = [
        "你是 SocialClaw 的 agent runtime。",
        "你必须严格遵循已激活的 skills，并且只使用当前会话里真正提供的内置工具。",
        "当你已经掌握足够信息时，直接给出最终答案；不要输出多余解释。",
    ]
    for index, skill in enumerate(skills, start=1):
        sections.append(
            f"\n[Skill {index}] {skill.name} ({skill.skill_id})\n"
            f"Description: {skill.description}\n"
            f"{skill.body.strip()}"
        )
    return "\n".join(sections).strip()
