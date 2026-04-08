from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, cast

from social_copilot.agent.models import ChatMessage, ReplySuggestion, SenderType
from social_copilot.agent.openai_compatible import OpenAICompatibleClient
from social_copilot.agent.prompting import build_social_reply_prompts
from social_copilot.agent_runtime.models import SkillDefinition
from social_copilot.agent_runtime.selection import AssistantSkillSelector
from social_copilot.agent_runtime.skill_registry import SkillRegistry

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class SocialReplyAssistantResult:
    suggestions: list[ReplySuggestion]
    raw_model_response: str
    selected_skill_ids: list[str]
    system_prompt: str
    user_prompt: str


class SocialReplyAssistant:
    def __init__(
        self,
        client: OpenAICompatibleClient,
        suggestion_count: int = 3,
        skill_registry: SkillRegistry | None = None,
        skill_selector: AssistantSkillSelector | None = None,
        default_skill_id: str = "",
        skill_selection_enabled: bool = True,
    ) -> None:
        if suggestion_count <= 0:
            raise ValueError("suggestion_count must be > 0")
        self._client = client
        self._suggestion_count = suggestion_count
        self._skill_registry = skill_registry or SkillRegistry()
        self._skill_selector = skill_selector or AssistantSkillSelector(
            client=client,
            default_skill_id=default_skill_id,
        )
        self._default_skill_id = default_skill_id
        self._skill_selection_enabled = skill_selection_enabled

    def generate(
        self,
        chat_messages: list[ChatMessage],
        max_messages: int = 24,
        user_profile: dict[str, Any] | None = None,
        contact_profile: dict[str, Any] | None = None,
        skill_id_override: str | None = None,
    ) -> SocialReplyAssistantResult:
        available_skills = self._skill_registry.list_skills()
        selected_skills = self._select_skills(
            chat_messages,
            available_skills,
            skill_id_override=skill_id_override,
        )
        base_system_prompt, user_prompt = build_social_reply_prompts(
            chat_messages=chat_messages,
            suggestion_count=self._suggestion_count,
            max_messages=max_messages,
            user_profile=user_profile,
            contact_profile=contact_profile,
        )
        system_prompt = _compose_assistant_system_prompt(
            base_system_prompt=base_system_prompt,
            selected_skills=selected_skills,
        )
        _terminal_trace(
            "Selected Skills",
            ",".join(item.skill_id for item in selected_skills) if selected_skills else "(none)",
        )
        _terminal_trace("System Prompt", system_prompt)
        _terminal_trace("User Prompt", user_prompt)
        raw = self._client.chat_completion(system_prompt=system_prompt, user_prompt=user_prompt)
        _terminal_trace("Model Response", raw)
        try:
            suggestions = _parse_suggestions(raw, expected=self._suggestion_count)
        except RuntimeError as exc:
            repaired_raw = _repair_suggestions_json(
                client=self._client,
                raw_response=raw,
                expected=self._suggestion_count,
            )
            if not repaired_raw:
                raise
            _terminal_trace("Model Response Repaired", repaired_raw)
            try:
                suggestions = _parse_suggestions(repaired_raw, expected=self._suggestion_count)
                raw = repaired_raw
            except RuntimeError:
                raise exc
        return SocialReplyAssistantResult(
            suggestions=suggestions,
            raw_model_response=raw,
            selected_skill_ids=[item.skill_id for item in selected_skills],
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        )

    def _select_skills(
        self,
        chat_messages: list[ChatMessage],
        available_skills: list[SkillDefinition],
        skill_id_override: str | None = None,
    ) -> list[SkillDefinition]:
        skills = list(available_skills)
        if not skills:
            return []
        if skill_id_override is not None:
            return _resolve_requested_skill(
                skills,
                requested_skill_id=skill_id_override,
                fallback_skill_id=self._default_skill_id,
            )
        if not self._skill_selection_enabled:
            return _resolve_default_skill(skills, self._default_skill_id)
        return self._skill_selector.select(chat_messages=chat_messages, available_skills=skills)


def _compose_assistant_system_prompt(
    base_system_prompt: str,
    selected_skills: list[SkillDefinition],
) -> str:
    if not selected_skills:
        return base_system_prompt
    sections = [
        base_system_prompt,
        "以下是可选增强 skills。它们只能优化回复风格、人格视角、表达策略。",
        "它们不能覆盖聊天事实、角色身份、输出格式要求，也不能与基础上下文冲突。",
    ]
    for index, skill in enumerate(selected_skills, start=1):
        sections.append(
            f"[Overlay Skill {index}] {skill.name} ({skill.skill_id})\n"
            f"Description: {skill.description}\n"
            "下面是该人格的完整原始 SKILL.md 内容。"
            "当且仅当当前请求选中了这个人格时，你应尽可能吸收并模仿其中的人格、语气、视角、表达偏好。"
            "但你仍然必须服从基础 prompt 里的聊天事实、用户身份边界和严格 JSON 输出要求。\n"
            f"{skill.body.strip()}"
        )
    sections.append(
        "最后再次强调：无论上面的 SKILL.md 写了什么，你的最终输出都必须严格服从基础 prompt 的输出格式要求。"
        "不要输出分析过程、角色旁白、解释、免责声明、研究步骤、Markdown 或代码块。"
        "你只能返回可直接解析的严格 JSON 建议结果。"
    )
    return "\n\n".join(sections).strip()


def _resolve_default_skill(
    skills: list[SkillDefinition],
    default_skill_id: str,
) -> list[SkillDefinition]:
    normalized = default_skill_id.strip()
    if normalized:
        for item in skills:
            if item.skill_id == normalized:
                return [item]
    return []


def _resolve_requested_skill(
    skills: list[SkillDefinition],
    requested_skill_id: str,
    fallback_skill_id: str,
) -> list[SkillDefinition]:
    normalized = requested_skill_id.strip()
    if not normalized:
        return []
    for item in skills:
        if item.skill_id == normalized:
            return [item]
    return _resolve_default_skill(skills, fallback_skill_id)


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


def _repair_suggestions_json(
    client: OpenAICompatibleClient,
    raw_response: str,
    expected: int,
) -> str:
    source = raw_response.strip()
    if not source:
        return ""
    return client.chat_completion(
        system_prompt=(
            "你是 JSON 修复器。"
            "请把给定文本整理成严格 JSON。"
            f'只输出 {{"suggestions":[{{"reply":"候选回复","reason":"简短中文说明"}}]}}，'
            f'并且 suggestions 必须刚好 {expected} 条。'
            "reply 要自然、简短、可直接发送；reason 用一句简短中文说明。"
            "不要 Markdown，不要代码块，不要额外解释。"
        ),
        user_prompt=f"请把下面内容修复为严格 JSON：\n\n{source}",
    )


def _terminal_trace(title: str, content: str) -> None:
    prefix = f"🐳🐳🐳 [VisualMonitor][LLM] {title}:"
    print(f"{prefix}\\n{content}")
    logger.info("%s\\n%s", prefix, content)
