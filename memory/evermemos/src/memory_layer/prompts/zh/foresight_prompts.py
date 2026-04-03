# -*- coding: utf-8 -*-
"""
前瞻联想预测提示词模板（通用场景）
"""

GROUP_FORESIGHT_GENERATION_PROMPT = """
你是前瞻联想抽取器。请从输入事件中抽取“可验证的未来变化”。

规则：
1. 只做一阶推断：必须由输入事实直接支持，禁止脑补。
2. 输出 1-5 条；质量优先，宁少勿滥；证据不足时输出 1-2 条即可，不要凑数。
3. `content` 必须具体、可验证，不要复述原文，不要泛泛建议。
4. 禁止建议口吻（如“应该/需要”），使用“可能/倾向/预计”等概率表达。
5. `evidence` 必须来自输入原事实（<=30字），不可编造。
6. 时间字段必填：
   - `start_time`: YYYY-MM-DD
   - `end_time`: YYYY-MM-DD 或 null（仅确属长期时）
   - `duration_days`: 与 start/end 一致；仅在 end_time 为 null 时可为 null
7. `parent_episode_id` 必须使用输入事件 id。

输出仅 JSON 数组：
[
  {
    "content": "可验证的未来变化（简洁一句）",
    "evidence": "对应输入事实（<=30字）",
    "start_time": "YYYY-MM-DD",
    "end_time": "YYYY-MM-DD 或 null",
    "duration_days": 7,
    "parent_episode_id": "EVENT_ID"
  }
]
"""

FORESIGHT_GENERATION_PROMPT = GROUP_FORESIGHT_GENERATION_PROMPT


def get_group_foresight_generation_prompt(
    memcell_summary: str, memcell_episode: str, user_ids: list = None
) -> str:
    """
    生成群组/私聊通用的 Foresight 提示词（基于 MemCell）
    """
    user_ids_info = ""
    if user_ids:
        user_ids_info = f"\n用户ID信息：\n{', '.join(user_ids)}\n"

    return f"""{GROUP_FORESIGHT_GENERATION_PROMPT}

输入内容：
- MemCell Summary:
{memcell_summary}

- MemCell Episode:
{memcell_episode}{user_ids_info}
请基于以上内容输出 1-5 条高质量前瞻推断（JSON 数组）。
"""


def get_foresight_generation_prompt(
    episode_memory: str, episode_content: str, user_id: str = None, episode_id: str = None
) -> str:
    """
    生成个人 Foresight 提示词（基于 EpisodeMemory）
    """
    user_id_info = ""
    if user_id:
        user_id_info = f"\n用户ID信息：\n{user_id}\n"

    episode_id_info = ""
    if episode_id:
        episode_id_info = f"\n- Episode ID（用于 parent_episode_id 字段）: {episode_id}"

    return f"""{FORESIGHT_GENERATION_PROMPT}

输入内容：{episode_id_info}
- Episode Summary:
{episode_memory}

- Episode Content:
{episode_content}{user_id_info}
请基于以上内容输出 1-5 条高质量前瞻推断（JSON 数组）。
"""
