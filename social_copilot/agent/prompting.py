from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

from social_copilot.agent.models import ChatMessage, ChatQuotedMessage

_CJK_EMOJI_TOKEN_RE = re.compile(r"\[[^\[\]\n]{1,8}\]")
_UNICODE_EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF]")
_SPLIT_RE = re.compile(r"[\s,.!?~:;()\[\]\"'/-]+")


def build_social_reply_prompts(
    chat_messages: list[ChatMessage],
    suggestion_count: int = 3,
    max_messages: int = 24,
    user_profile: dict[str, Any] | None = None,
    contact_profile: dict[str, Any] | None = None,
) -> tuple[str, str]:
    if suggestion_count <= 0:
        raise ValueError("suggestion_count must be > 0")

    context_messages = chat_messages[-max_messages:]
    transcript = _format_transcript(context_messages)
    style_summary = _summarize_user_style(context_messages)
    user_profile_summary = _summarize_profile(user_profile)
    contact_profile_summary = _summarize_profile(contact_profile)
    last_sender = _resolve_last_sender(context_messages)

    system_prompt = (
        "你是微信聊天回复建议助手。"
        "你是在替用户本人起草下一条可直接发送的微信消息。"
        "用户画像代表要模仿的我方说话方式。"
        f"基于聊天记录生成 {suggestion_count} 条可直接发送的简短中文回复。"
        "只输出严格 JSON："
        '{"suggestions":[{"reply":"候选回复","reason":"简短中文说明"}]}。'
        f'"suggestions" 必须刚好 {suggestion_count} 条。'
        "reply 要自然、简短、彼此不同；reason 用一句简短中文说明。"
        "优先按聊天记录；画像仅辅助。"
        "不要 Markdown，不要代码块，不要解释。"
    )

    prompt_sections = [
        "当前任务：替用户本人继续这段对话。",
        "对方画像代表聊天对象，不是建议模仿对象。",
        _build_turn_guidance(last_sender),
        f"聊天记录：\n{transcript}",
    ]
    if style_summary:
        prompt_sections.append(f"用户风格：{style_summary}")
    if user_profile_summary:
        prompt_sections.append(f"用户画像：{user_profile_summary}")
    if contact_profile_summary:
        prompt_sections.append(f"对方画像：{contact_profile_summary}")
    prompt_sections.append("请直接返回结果。")

    user_prompt = "\n\n".join(prompt_sections)
    return system_prompt, user_prompt


def _format_transcript(messages: list[ChatMessage]) -> str:
    if not messages:
        return "(no transcript)"

    lines: list[str] = []
    for item in messages:
        text = item.text.strip()
        if not text:
            continue
        text = _format_message_text(text, item.quoted_message)
        if item.sender == "contact":
            speaker = item.contact_name.strip() if item.contact_name else "contact"
            lines.append(f"[contact:{speaker}] {text}")
        elif item.sender == "user":
            lines.append(f"[user] {text}")
        else:
            lines.append(f"[unknown] {text}")
    return "\n".join(lines) if lines else "(no transcript)"


def _format_message_text(text: str, quoted_message: ChatQuotedMessage | None) -> str:
    if quoted_message is None:
        return text
    quoted_text = quoted_message.text.strip()
    if not quoted_text:
        return text
    quoted_sender = (quoted_message.sender_name or "").strip()
    prefix = f"引用[{quoted_sender}]" if quoted_sender else "引用"
    return f"{text} ({prefix}: {quoted_text})"


def _resolve_last_sender(messages: list[ChatMessage]) -> str:
    for item in reversed(messages):
        text = item.text.strip()
        if not text:
            continue
        return item.sender
    return "unknown"


def _build_turn_guidance(last_sender: str) -> str:
    if last_sender == "user":
        return "最后一条消息来自用户本人。默认产出用户下一条还能继续发出的自然跟进；只有明显更合适时才建议先别发。"
    if last_sender == "contact":
        return "最后一条消息来自对方。请直接替用户回复对方。"
    return "最后一条消息发送方不明确，但仍然要站在用户本人这一侧起草下一条。"


def _summarize_user_style(messages: list[ChatMessage]) -> str:
    user_texts = [item.text.strip() for item in messages if item.sender == "user" and item.text.strip()]
    if len(user_texts) < 2:
        return ""

    avg_len = int(sum(len(text) for text in user_texts) / len(user_texts))
    punctuation_counter = Counter(ch for text in user_texts for ch in text if ch in ",.!?~")
    punct_text = "、".join(token for token, _ in punctuation_counter.most_common(3))

    emoji_counter = Counter(_extract_emoji_tokens(user_texts))
    emoji_text = " ".join(token for token, _ in emoji_counter.most_common(4))

    phrase_counter: Counter[str] = Counter()
    for text in user_texts:
        parts = [chunk for chunk in _SPLIT_RE.split(text) if 2 <= len(chunk) <= 10]
        for part in parts:
            phrase_counter[part] += 1
    frequent_phrases = [phrase for phrase, count in phrase_counter.most_common(5) if count >= 2][:3]
    style_parts = [f"平均长度约{avg_len}字"]
    if punct_text:
        style_parts.append(f"常用标点 {punct_text}")
    if emoji_text:
        style_parts.append(f"常用表情 {emoji_text}")
    if frequent_phrases:
        style_parts.append(f"常用短语 {'、'.join(frequent_phrases)}")
    return "；".join(style_parts)


def _extract_emoji_tokens(texts: list[str]) -> list[str]:
    tokens: list[str] = []
    for text in texts:
        tokens.extend(_CJK_EMOJI_TOKEN_RE.findall(text))
        tokens.extend(_UNICODE_EMOJI_RE.findall(text))
    return tokens


def _summarize_profile(profile: dict[str, Any] | None) -> str:
    if not profile:
        return ""

    compact = _compact_profile(profile)
    return compact


def _compact_profile(profile: dict[str, Any]) -> str:
    keep: dict[str, Any] = {}
    _copy_if_present(profile, keep, "display_name")
    _copy_if_present(profile, keep, "profile_type")

    # occupation 可能是字符串或 List[ProfileField]
    occupation = profile.get("occupation")
    if occupation:
        keep["occupation"] = _extract_profile_field_values(occupation)

    # 处理 List[ProfileField] 格式的字段
    traits = _extract_profile_field_values(profile.get("traits"))
    interests = _extract_profile_field_values(profile.get("interests"))
    personality = _extract_profile_field_values(profile.get("personality"))
    catchphrase = _extract_profile_field_values(profile.get("catchphrase"))
    communication_style = _extract_profile_field_values(profile.get("communication_style"))
    way_of_decision_making = _extract_profile_field_values(profile.get("way_of_decision_making"))
    life_habit_preference = _extract_profile_field_values(profile.get("life_habit_preference"))
    motivation_system = _extract_profile_field_values(profile.get("motivation_system"))
    fear_system = _extract_profile_field_values(profile.get("fear_system"))
    value_system = _extract_profile_field_values(profile.get("value_system"))
    humor_use = _extract_profile_field_values(profile.get("humor_use"))

    if traits:
        keep["traits"] = traits
    if interests:
        keep["interests"] = interests
    if personality:
        keep["personality"] = personality
    if catchphrase:
        keep["catchphrase"] = catchphrase
    if communication_style:
        keep["communication_style"] = communication_style
    if way_of_decision_making:
        keep["decision_style"] = way_of_decision_making
    if life_habit_preference:
        keep["life_habits"] = life_habit_preference
    if motivation_system:
        keep["motivation"] = motivation_system
    if fear_system:
        keep["fears"] = fear_system
    if value_system:
        keep["values"] = value_system
    if humor_use:
        keep["humor"] = humor_use

    social = profile.get("social_attributes")
    if isinstance(social, dict):
        social_keep: dict[str, Any] = {}
        _copy_if_present(social, social_keep, "role")
        _copy_if_present(social, social_keep, "age_group")
        _copy_if_present(social, social_keep, "intimacy_level")
        _copy_if_present(social, social_keep, "current_status")
        if social_keep:
            keep["social_attributes"] = social_keep

    extend = profile.get("extend")
    if isinstance(extend, dict):
        summary = str(extend.get("chat_history_summary", "")).strip()
        if summary:
            keep["chat_history_summary"] = summary

    if not keep:
        return ""
    return json.dumps(keep, ensure_ascii=False, indent=2)


def _extract_profile_field_values(value: Any) -> list[str]:
    """
    从 ProfileField 格式中提取 value 列表。

    支持两种格式：
    1. 新格式: List[dict] - [{"value": "xxx", "evidence_level": "L1", "evidences": [...]}]
    2. 旧格式: List[str] - ["xxx", "yyy"]
    """
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, dict):
            # 新格式: ProfileField
            v = item.get("value", "")
            if v and isinstance(v, str):
                result.append(v.strip())
        elif isinstance(item, str):
            # 旧格式: 直接字符串
            if item.strip():
                result.append(item.strip())
        if len(result) >= 5:
            break
    return result


def _compact_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = str(item).strip()
        if not text or text in result:
            continue
        result.append(text)
        if len(result) >= 5:
            break
    return result


def _copy_if_present(source: dict[str, Any], target: dict[str, Any], key: str) -> None:
    value = source.get(key)
    if value is None:
        return
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return
    target[key] = value
