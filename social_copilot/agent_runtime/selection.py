from __future__ import annotations

import json

from social_copilot.agent.models import ChatMessage
from social_copilot.agent.prompting import format_chat_transcript
from social_copilot.agent_runtime.models import SkillDefinition


class AssistantSkillSelector:
    def __init__(self, client: object, default_skill_id: str = "") -> None:
        self._client = client
        self._default_skill_id = default_skill_id

    def select(
        self,
        chat_messages: list[ChatMessage],
        available_skills: list[SkillDefinition],
    ) -> list[SkillDefinition]:
        if not available_skills:
            return []
        if len(available_skills) == 1:
            return [available_skills[0]]

        default_skill = _resolve_default_skill(available_skills, self._default_skill_id)
        skill_catalog = "\n".join(
            f'- skill_id="{item.skill_id}" name="{item.name}" description="{item.description}"'
            for item in available_skills
        )
        transcript = format_chat_transcript(chat_messages[-8:])
        raw = self._client.chat_completion(
            system_prompt=(
                "你是 SocialClaw assistant skill 选择器。"
                "请根据聊天任务，从可用 skills 中选择最适合当前回复生成任务的一个主 skill。"
                '只输出严格 JSON：{"primary_skill_id":"skill-id","supporting_skill_ids":["skill-id"]}。'
            ),
            user_prompt=(
                f"可用 skills:\n{skill_catalog}\n\n"
                f"最近聊天预览:\n{transcript}\n\n"
                f"默认 skill: {default_skill.skill_id}"
            ),
        )
        chosen_ids = _parse_selected_skill_ids(raw)
        resolved = [item for item in available_skills if item.skill_id in chosen_ids]
        if resolved:
            return resolved
        return [default_skill]


def _resolve_default_skill(
    available_skills: list[SkillDefinition],
    default_skill_id: str,
) -> SkillDefinition:
    normalized = default_skill_id.strip()
    if normalized:
        for item in available_skills:
            if item.skill_id == normalized:
                return item
    return available_skills[0]


def _parse_selected_skill_ids(raw: str) -> list[str]:
    text = raw.strip()
    if text.startswith("```"):
        lines = [line for line in text.splitlines() if not line.strip().startswith("```")]
        text = "\n".join(lines).strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []
    primary = str(payload.get("primary_skill_id", "")).strip()
    supporting_raw = payload.get("supporting_skill_ids", [])
    supporting = []
    if isinstance(supporting_raw, list):
        supporting = [str(item).strip() for item in supporting_raw if str(item).strip()]
    ordered = [item for item in [primary, *supporting] if item]
    deduped: list[str] = []
    for item in ordered:
        if item not in deduped:
            deduped.append(item)
    return deduped
