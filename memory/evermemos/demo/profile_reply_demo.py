"""Profile Reply Demo

Simulate a private chat: use a portion of a conversation as history,
then stream the friend's messages and generate replies using profiles.

Usage:
    uv run python src/bootstrap.py demo/profile_reply_demo.py --input "my_chat\\demo_text_100_p50.json"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import re

from dotenv import load_dotenv
from pymongo import AsyncMongoClient
from beanie import init_beanie

from demo.config import LLMConfig, MongoDBConfig
from memory_layer.llm.llm_provider import LLMProvider

from infra_layer.adapters.out.persistence.document.memory.conversation_meta import (
    ConversationMeta,
)
from infra_layer.adapters.out.persistence.document.memory.user_profile import UserProfile
from infra_layer.adapters.out.persistence.document.memory.user_self_profile import (
    UserSelfProfile,
)


def _load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as fp:
        return json.load(fp)


def _get_user_name(user_details: Dict[str, Any], user_id: str) -> str:
    if not user_id:
        return ""
    detail = user_details.get(user_id) or {}
    return detail.get("full_name") or user_id


def _format_msg(msg: Dict[str, Any], user_details: Dict[str, Any]) -> Tuple[str, str]:
    sender = msg.get("sender") or ""
    sender_name = msg.get("sender_name") or _get_user_name(user_details, sender)
    content = msg.get("content") or ""
    return sender_name, content


def _build_planner_prompt(
    owner_user_id: str,
    owner_name: str,
    friend_user_id: str,
    friend_name: str,
    history_lines: List[str],
    incoming_text: str,
    self_profile: Optional[Dict[str, Any]],
    friend_profile: Optional[Dict[str, Any]],
    reply_willingness: str,
    willingness_reason: str,
    persona_anchors: Optional[Dict[str, Any]] = None,
) -> str:
    parts: List[str] = []
    parts.append(
        "你是对话规划助手（planner）。根据画像与历史对话，判断是否需要回复并给出回复策略。"
        "只输出 JSON，禁止输出多余内容。"
    )
    parts.append(
        "对话双方："
        f"我={owner_name}(user_id={owner_user_id})，"
        f"对方={friend_name}(user_id={friend_user_id})。"
    )
    if self_profile:
        parts.append(
            "我的画像（仅作背景，不要原文引用）："
            + json.dumps(self_profile, ensure_ascii=False)
        )
    if friend_profile:
        parts.append(
            "对方画像（仅作背景，不要原文引用）："
            + json.dumps(friend_profile, ensure_ascii=False)
        )
    if history_lines:
        parts.append("对话历史：\n" + "\n".join(history_lines))

    parts.append(
        f"规则建议的回复意愿：{reply_willingness}（原因：{willingness_reason}）"
    )
    parts.append(f"对方新消息：{incoming_text}")
    parts.append(
        "输出 JSON 结构："
        "{"
        "\"should_reply\": true/false, "
        "\"reply_willingness\": \"low|medium|high\", "
        "\"reason\": \"简要原因\", "
        "\"tone\": \"语气关键词\", "
        "\"style\": \"自然口语|简短直接|轻松调侃|克制冷静\", "
        "\"key_points\": [\"要点1\", \"要点2\"], "
        "\"avoid_phrases\": [\"禁用词1\", \"禁用词2\"], "
        "\"do_not_repeat\": [\"不要复述的旧观点或句式\"], "
        "\"must_add_new_point\": true, "
        "\"question_policy\": \"default_statement|allow_one_question_only_if_necessary\""
        "}"
    )
    parts.append(
        "规划要求：禁止客服口吻；禁止无条件鼓励；禁止复述历史中已经说过的观点；"
        "必须推进对话（至少一个新信息：新判断/新建议/新安排）；"
        "默认用陈述句推进，不要把每轮都变成提问。"
    )
    return "\n\n".join(parts)


def _build_responder_prompt(
    owner_user_id: str,
    owner_name: str,
    friend_user_id: str,
    friend_name: str,
    history_lines: List[str],
    incoming_text: str,
    recent_owner_replies: List[str],
    self_profile: Optional[Dict[str, Any]],
    friend_profile: Optional[Dict[str, Any]],
    planner_result: Dict[str, Any],
    persona_anchors: Optional[Dict[str, Any]] = None,
) -> str:
    parts: List[str] = []
    parts.append(
        "你是对话回复助手（responder），根据画像、历史对话和规划结果生成最终回复。"
        "只输出回复文本，不要输出 JSON，不要解释。"
    )
    parts.append(
        f"对话双方：我={owner_name}(user_id={owner_user_id})，"
        f"对方={friend_name}(user_id={friend_user_id})。"
    )
    if self_profile:
        parts.append(
            "我的画像（仅作背景，不要原文引用）："
            + json.dumps(self_profile, ensure_ascii=False)
        )
    if friend_profile:
        parts.append(
            "对方画像（仅作背景，不要原文引用）："
            + json.dumps(friend_profile, ensure_ascii=False)
        )
    if history_lines:
        parts.append("对话历史：\n" + "\n".join(history_lines))
    if recent_owner_replies:
        parts.append("最近两轮我方回复（禁止复读）：\n" + "\n".join(recent_owner_replies))
    parts.append("规划结果（JSON）：\n" + json.dumps(planner_result, ensure_ascii=False))
    parts.append(f"对方新消息：{incoming_text}")
    parts.append(
        "回复风格硬约束（必须遵守）：\n"
        "1) 用私聊口吻，不要客服口吻，不要官话。\n"
        "2) 禁止虚假积极：不要无条件夸赞、不要空泛鼓励。\n"
        "3) 禁止使用或同义改写这些表达：感谢你的耐心、很高兴为你服务、希望对你有帮助、如有需要请随时联系、完全理解你的感受。\n"
        "4) 不得重复最近两轮我方已表达的观点、句式或结尾。\n"
        "5) 必须推进对话：至少包含一个新元素（新信息/新判断/新建议/新安排）。\n"
        "6) 默认使用陈述句，不主动提问；只有在信息明显不足且确实需要澄清时，最多允许 1 个问题。\n"
        "7) 不允许连续多轮都用提问句结尾。\n"
        "8) 严禁编造新事实：不要新增具体时间、数字、人物、安排、资源、进度、结果。\n"
        "9) 只允许基于输入消息和历史里已出现的信息回复；不确定就直说不确定。\n"
        "10) 长度 1 句为主，最多 2 句；不要解释思路，不要输出标签。"
    )
    parts.append("你的回复：")
    return "\n\n".join(parts)


def _build_single_prompt(
    owner_user_id: str,
    owner_name: str,
    friend_user_id: str,
    friend_name: str,
    history_lines: List[str],
    incoming_text: str,
    self_profile: Optional[Dict[str, Any]],
    friend_profile: Optional[Dict[str, Any]],
    reply_willingness: str,
    willingness_reason: str,
) -> str:
    parts: List[str] = []
    parts.append(
        f"你是 {owner_name}(user_id={owner_user_id})，正在与 {friend_name}(user_id={friend_user_id}) 私聊。"
        "请根据画像与历史对话，自然、简洁地回复（不要原文引用画像）。"
    )
    if self_profile:
        parts.append(
            "我的画像（仅作背景，不要原文引用）："
            + json.dumps(self_profile, ensure_ascii=False)
        )
    if friend_profile:
        parts.append(
            "对方画像（仅作背景，不要原文引用）："
            + json.dumps(friend_profile, ensure_ascii=False)
        )
    if history_lines:
        parts.append("对话历史：\n" + "\n".join(history_lines))

    parts.append(f"回复意愿：{reply_willingness}（原因：{willingness_reason}）")
    parts.append(f"对方新消息：{incoming_text}")
    parts.append(
        "回复风格硬约束（必须遵守）：\n"
        "1) 用私聊口吻，不要客服口吻，不要官话。\n"
        "2) 禁止虚假积极：不要无条件夸赞、不要空泛鼓励。\n"
        "3) 禁止使用或同义改写这些表达：感谢你的耐心、很高兴为你服务、希望对你有帮助、如有需要请随时联系、完全理解你的感受。\n"
        "4) 不得重复最近两轮已表达的观点、句式或结尾。\n"
        "5) 必须推进对话：至少包含一个新元素（新信息/新判断/新问题/新安排）。\n"
        "6) 长度 1-2 句，口语化，不要解释思路，不要输出标签。"
    )
    parts.append("你的回复：")
    return "\n\n".join(parts)


def _ensure_log_dirs() -> Tuple[Path, Path]:
    prompt_dir = Path("logs") / "reply_prompt"
    response_dir = Path("logs") / "reply_response"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    response_dir.mkdir(parents=True, exist_ok=True)
    return prompt_dir, response_dir


def _init_responder_trace() -> Path:
    trace_dir = Path("logs") / "reply_responder_trace"
    trace_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    short_id = uuid.uuid4().hex[:8]
    return trace_dir / f"{ts}_responder_trace_{short_id}.txt"


def _append_responder_trace(
    trace_path: Path,
    turn_index: int,
    planner_message: Dict[str, Any],
    responder_prompt: str,
    response: str,
    self_profile: Optional[Dict[str, Any]] = None,
    friend_profile: Optional[Dict[str, Any]] = None,
) -> None:
    lines: List[str] = []
    lines.append(f"=== TURN {turn_index} ===")
    lines.append("[PLANNER -> RESPONDER]")
    lines.append(json.dumps(planner_message, ensure_ascii=False))
    lines.append("[RESPONDER PROMPT]")
    lines.append(responder_prompt)
    lines.append("[RESPONDER RESPONSE]")
    lines.append(response)
    lines.append("")
    with trace_path.open("a", encoding="utf-8") as fp:
        fp.write("\n".join(lines))
        fp.write("\n")


def _write_prompt_response(
    prompt: str,
    response: str,
    history_lines: Optional[List[str]] = None,
    label: str = "reply",
) -> None:
    prompt_dir, response_dir = _ensure_log_dirs()
    ts = time.strftime("%Y%m%d_%H%M%S")
    short_id = uuid.uuid4().hex[:8]
    prompt_path = prompt_dir / f"{ts}_{label}_prompt_{short_id}.txt"
    response_path = response_dir / f"{ts}_{label}_response_{short_id}.txt"
    if history_lines:
        prompt_text = "=== HISTORY SENT ===\n"
        prompt_text += "\n".join(history_lines) + "\n\n"
        prompt_text += "=== FULL PROMPT ===\n"
        prompt_text += prompt
    else:
        prompt_text = prompt
    prompt_path.write_text(prompt_text, encoding="utf-8")
    response_path.write_text(response, encoding="utf-8")


def _extract_answer_only(text: str) -> str:
    if not text:
        return text
    lower = text.lower()
    if "<answer>" in lower and "</answer>" in lower:
        start = lower.find("<answer>") + len("<answer>")
        end = lower.find("</answer>", start)
        return text[start:end].strip()
    if "</think>" in lower:
        start = lower.find("</think>") + len("</think>")
        return text[start:].strip()
    if "<think>" in lower and "</think>" in lower:
        start = lower.find("</think>") + len("</think>")
        return text[start:].strip()
    return text.strip()


def _extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None
    cleaned = _extract_answer_only(text)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = cleaned[start : end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def _infer_reply_willingness(text: str, owner_name: str) -> Tuple[str, str]:
    """Simple rule-based reply willingness."""
    t = (text or "").strip()
    if not t:
        return "low", "空内容"

    question_mark = "?" in t or "？" in t
    request_keywords = ("帮忙", "请", "麻烦", "能不能", "可以", "能否", "要不要", "行吗")
    request_hit = any(k in t for k in request_keywords)
    mention_hit = owner_name and owner_name in t

    has_content = re.search(r"[A-Za-z0-9\u4e00-\u9fff]", t) is not None
    if not has_content:
        return "low", "仅表情/标点"

    if mention_hit or question_mark or request_hit:
        reason = "被点名/提问/请求"
        return "high", reason

    if len(t) <= 3:
        return "low", "内容过短"

    return "medium", "普通对话"


def _extract_recent_owner_replies(
    history_lines: List[str], owner_name: str, limit: int = 2
) -> List[str]:
    prefix = f"{owner_name}:"
    owner_lines = [line for line in history_lines if line.startswith(prefix)]
    return owner_lines[-limit:]


def _contains_question(text: str) -> bool:
    t = (text or "").strip()
    return ("?" in t) or ("？" in t)


def _recent_question_count(recent_owner_replies: List[str]) -> int:
    return sum(1 for line in recent_owner_replies if _contains_question(line))


def _should_allow_question(
    incoming_text: str,
    reply_willingness: str,
    recent_owner_replies: List[str],
    question_policy: str = "",
) -> bool:
    if question_policy == "ask_one_clarifying_question":
        return True
    if question_policy == "default_statement":
        return False
    incoming_has_question = _contains_question(incoming_text)
    if not incoming_has_question:
        return False
    if _recent_question_count(recent_owner_replies) >= 1:
        return False
    return reply_willingness in {"high", "medium"}


async def _rewrite_to_non_question(
    llm: LLMProvider,
    incoming_text: str,
    response_text: str,
    owner_name: str,
) -> str:
    rewrite_prompt = (
        "你是对话改写助手。把下面回复改写为更像真实私聊的口语化表达。\n"
        "硬约束：\n"
        "1) 必须是陈述句，不允许问号（? 或 ？）。\n"
        "2) 保留原意，不新增事实，不添加新问题。\n"
        "3) 长度 1-2 句。\n"
        "4) 不要客服口吻，不要模板化安慰。\n\n"
        f"对方消息：{incoming_text}\n"
        f"{owner_name}原回复：{response_text}\n\n"
        "改写后回复："
    )
    rewritten = await llm.generate(rewrite_prompt)
    cleaned = _extract_answer_only((rewritten or "").strip())
    cleaned = cleaned.replace("？", "").replace("?", "").strip()
    return cleaned or response_text


def _looks_official_or_aiy(text: str) -> bool:
    if not text:
        return False
    bad_markers = [
        "这边",
        "优先",
        "持续关注",
        "整理了",
        "可以分享",
        "实时数据",
        "节点表",
        "针对性版本",
        "收尾",
        "反馈",
        "推进",
    ]
    return any(marker in text for marker in bad_markers)


def _has_new_concrete_claim(text: str, context_text: str) -> bool:
    if not text:
        return False
    # Concrete signals likely to be hallucinated when absent from context.
    suspicious_tokens = [
        "刚",
        "已经",
        "下周",
        "今天",
        "导师",
        "邮件",
        "院校",
        "名额",
        "系统",
        "数据",
        "项目资料",
        "招生办",
        "清单",
        "模拟面试",
        "线上交流",
    ]
    for token in suspicious_tokens:
        if token in text and token not in context_text:
            return True
    return False


def _fallback_human_reply(
    incoming_text: str,
    recent_owner_replies: List[str],
    allow_question: bool,
    persona_anchors: Optional[Dict[str, Any]] = None,
    planner_message: Optional[Dict[str, Any]] = None,
) -> str:
    incoming = (incoming_text or "").strip()
    if _contains_question(incoming):
        candidates = [
            "我也不太确定，先看看情况。",
            "这个我现在说不准，先稳住准备。",
            "还不好判断，我再留意下。",
        ]
    elif len(incoming) <= 4:
        candidates = [
            "嗯，我知道了。",
            "好，我明白。",
            "行，那先这样。",
        ]
    elif any(k in incoming for k in ["难", "悬", "不大好", "没事", "机会"]):
        candidates = [
            "确实不容易，先把能做的做好。",
            "嗯，先稳住，慢慢来。",
            "是有压力，但还有空间。",
        ]
    else:
        candidates = [
            "嗯，我也是这么想的。",
            "好，我会继续准备。",
            "收到，我先按这个来。",
        ]

    # Avoid repeating recent self replies.
    for c in candidates:
        if c not in recent_owner_replies:
            return c
    return candidates[0]


def _sanitize_reply_text(text: str, max_chars: int = 28) -> str:
    t = (text or "").strip()
    # Remove decorative emoji to reduce AI-like style drift.
    t = re.sub(r"[\U0001F300-\U0001FAFF]", "", t)
    t = re.sub(r"\s+", "", t)
    if len(t) > max_chars:
        t = t[:max_chars]
    return t


def _compact_profile_for_prompt(
    profile: Optional[Dict[str, Any]],
    user_id: str,
    user_name: str,
    role: str = "self",
) -> Dict[str, Any]:
    if not profile:
        return {"role": role, "user_id": user_id, "user_name": user_name}
    profile_data = profile.get("profile_data") if isinstance(profile, dict) else None
    if not isinstance(profile_data, dict):
        profile_data = profile if isinstance(profile, dict) else {}
    compact: Dict[str, Any] = {
        "role": role,
        "user_id": user_id,
        "user_name": user_name,
    }
    for key in (
        "basic_info",
        "personality",
        "communication_style",
        "catchphrase",
        "humor_use",
        "relationship",
        "interaction_style",
        "emotional_pattern",
        "preferences",
        "occupation",
        "gender",
    ):
        value = profile_data.get(key)
        if value not in (None, "", [], {}):
            compact[key] = value
    return compact


def _build_persona_anchors(profile: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    profile_data = profile.get("profile_data") if isinstance(profile, dict) else None
    if not isinstance(profile_data, dict):
        profile_data = profile if isinstance(profile, dict) else {}
    anchors: Dict[str, Any] = {}
    for key in ("communication_style", "catchphrase", "humor_use"):
        value = profile_data.get(key)
        if value not in (None, "", [], {}):
            anchors[key] = value
    interaction_style = profile_data.get("interaction_style")
    if isinstance(interaction_style, dict):
        target_length = interaction_style.get("target_length")
        if target_length:
            anchors["target_length"] = target_length
    elif profile_data.get("target_length"):
        anchors["target_length"] = profile_data.get("target_length")
    return anchors


def _build_planner_to_responder_message(
    *,
    planner_json: Dict[str, Any],
    incoming_text: str,
    rule_willingness: str,
    rule_reason: str,
    self_profile_compact: Dict[str, Any],
    friend_profile_compact: Dict[str, Any],
    persona_anchors: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "decision": planner_json,
        "context": {
            "incoming_text": incoming_text,
            "rule_reply_willingness": rule_willingness,
            "rule_reason": rule_reason,
        },
        "self_profile": self_profile_compact,
        "friend_profile": friend_profile_compact,
        "persona_anchors": persona_anchors,
    }


def _build_default_runtime_message(
    *,
    incoming_text: str,
    reply_willingness: str,
) -> Dict[str, Any]:
    return {
        "decision": {
            "should_reply": reply_willingness != "low",
            "reply_willingness": reply_willingness,
            "reason": "runtime fallback",
            "tone": "natural",
            "style": "????",
            "key_points": [incoming_text[:20]],
            "avoid_phrases": [],
            "do_not_repeat": [],
            "must_add_new_point": False,
            "question_policy": "default_statement",
        }
    }


def _is_repetitive_reply(text: str, recent_owner_replies: List[str]) -> bool:
    normalized = re.sub(r"\s+", "", (text or ""))
    if not normalized:
        return False
    return any(normalized == re.sub(r"\s+", "", x or "") for x in recent_owner_replies[-2:])


def _is_off_topic(text: str, incoming_text: str) -> bool:
    if not text or not incoming_text:
        return False
    incoming_tokens = set(re.findall(r"[\u4e00-\u9fff]{1,4}|[a-zA-Z]{2,}", incoming_text))
    reply_tokens = set(re.findall(r"[\u4e00-\u9fff]{1,4}|[a-zA-Z]{2,}", text))
    if not incoming_tokens or not reply_tokens:
        return False
    overlap = incoming_tokens & reply_tokens
    return len(overlap) == 0 and len(reply_tokens) >= 3


def _violates_runtime_policy(
    text: str,
    planner_message: Dict[str, Any],
    context_text: str,
) -> bool:
    decision = planner_message.get("decision") or {}
    avoid_phrases = decision.get("avoid_phrases") or []
    if any(p and p in (text or "") for p in avoid_phrases):
        return True
    if decision.get("question_policy") == "default_statement" and _contains_question(text):
        return True
    return _has_new_concrete_claim(text, context_text)


async def _rewrite_grounded_casual(
    *,
    llm: LLMProvider,
    incoming_text: str,
    recent_history: List[str],
    recent_owner_replies: List[str],
    response_text: str,
    owner_name: str,
    planner_message: Dict[str, Any],
) -> str:
    prompt = (
        "?????????????????????????????\n"
        "?????????????????????????????\n\n"
        f"?????\n{chr(10).join(recent_history[-8:])}\n\n"
        f"???????\n{chr(10).join(recent_owner_replies[-3:])}\n\n"
        f"??????{incoming_text}\n"
        f"?????{response_text}\n"
        f"?????{json.dumps(planner_message, ensure_ascii=False)}\n\n"
        f"{owner_name}???????"
    )
    rewritten = await llm.generate(prompt)
    return _extract_answer_only((rewritten or "").strip())


def _write_split_files(
    input_path: Path,
    meta: Dict[str, Any],
    history_msgs: List[Dict[str, Any]],
    stream_msgs: List[Dict[str, Any]],
    history_out: Optional[Path],
    stream_out: Optional[Path],
) -> Tuple[Path, Path]:
    history_path = history_out or input_path.with_name(
        f"{input_path.stem}_history.json"
    )
    stream_path = stream_out or input_path.with_name(f"{input_path.stem}_stream.json")

    history_payload = {
        "version": meta.get("version", "1.0.0"),
        "conversation_meta": meta,
        "conversation_list": history_msgs,
    }
    stream_payload = {
        "version": meta.get("version", "1.0.0"),
        "conversation_meta": meta,
        "conversation_list": stream_msgs,
    }

    history_path.write_text(
        json.dumps(history_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    stream_path.write_text(
        json.dumps(stream_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return history_path, stream_path


async def _init_beanie() -> None:
    mongo_config = MongoDBConfig()
    os.environ["MONGODB_URI"] = mongo_config.uri

    client = AsyncMongoClient(mongo_config.uri)
    await client.admin.command("ping")

    await init_beanie(
        database=client[mongo_config.database],
        document_models=[ConversationMeta, UserProfile, UserSelfProfile],
    )


async def _fetch_profiles(
    group_id: str, owner_user_id: str, friend_user_id: str
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    self_profile = None
    friend_profile = None

    if owner_user_id:
        self_doc = await UserSelfProfile.find_one(
            UserSelfProfile.user_id == owner_user_id
        )
        if self_doc:
            self_profile = self_doc.profile_data

    if friend_user_id:
        friend_doc = await UserProfile.find_one(
            UserProfile.user_id == friend_user_id, UserProfile.group_id == group_id
        )
        if friend_doc:
            friend_profile = friend_doc.profile_data

    return self_profile, friend_profile


async def main() -> None:
    parser = argparse.ArgumentParser(description="Profile reply demo")
    parser.add_argument("--input", required=True, help="Input conversation JSON file")
    parser.add_argument(
        "--history-count",
        type=int,
        default=30,
        help="Number of messages to use as history (default: 30)",
    )
    parser.add_argument(
        "--history-window",
        type=int,
        default=20,
        help="How many recent history lines to include per turn (default: 20)",
    )
    parser.add_argument(
        "--stream-limit",
        type=int,
        default=20,
        help="Max number of friend messages to replay (default: 20)",
    )
    parser.add_argument(
        "--owner-user-id",
        default="",
        help="Override owner_user_id (optional)",
    )
    parser.add_argument(
        "--friend-user-id",
        default="",
        help="Override friend_user_id (optional)",
    )
    parser.add_argument(
        "--mode",
        choices=("dual", "single"),
        default="dual",
        help="Reply mode: dual(planner+responder) or single (default: dual)",
    )
    parser.add_argument(
        "--export-splits",
        action="store_true",
        help="Export history/stream split files and continue (default: false)",
    )
    parser.add_argument(
        "--export-only",
        action="store_true",
        help="Export history/stream split files and exit (default: false)",
    )
    parser.add_argument(
        "--history-output",
        default="",
        help="Path to write history split JSON (optional)",
    )
    parser.add_argument(
        "--stream-output",
        default="",
        help="Path to write stream split JSON (optional)",
    )
    args = parser.parse_args()

    load_dotenv()

    input_path = Path(args.input)
    data = _load_json(input_path)
    meta = data.get("conversation_meta", {})
    group_id = meta.get("group_id") or ""
    user_details = meta.get("user_details") or {}

    owner_user_id = args.owner_user_id or (meta.get("scene_desc") or {}).get(
        "owner_user_id", ""
    )
    if not owner_user_id and user_details:
        owner_user_id = list(user_details.keys())[0]

    friend_user_id = args.friend_user_id
    if not friend_user_id and user_details:
        friend_candidates = [uid for uid in user_details.keys() if uid != owner_user_id]
        friend_user_id = friend_candidates[0] if friend_candidates else ""

    owner_name = _get_user_name(user_details, owner_user_id)
    friend_name = _get_user_name(user_details, friend_user_id)

    conversation_list = data.get("conversation_list") or []
    text_messages = [
        m
        for m in conversation_list
        if (m.get("type") == "text" or m.get("type") is None)
        and (m.get("content") is not None)
    ]

    history_count = max(0, min(args.history_count, len(text_messages)))
    history_msgs = text_messages[:history_count]
    stream_msgs = text_messages[history_count:]

    if args.export_splits or args.export_only:
        history_out = Path(args.history_output) if args.history_output else None
        stream_out = Path(args.stream_output) if args.stream_output else None
        history_path, stream_path = _write_split_files(
            input_path,
            meta,
            history_msgs,
            stream_msgs,
            history_out,
            stream_out,
        )
        print(f"[Export] history -> {history_path}")
        print(f"[Export] stream  -> {stream_path}")
        if args.export_only:
            return

    await _init_beanie()
    self_profile, friend_profile = await _fetch_profiles(
        group_id, owner_user_id, friend_user_id
    )

    llm_config = LLMConfig()
    llm = LLMProvider(
        llm_config.provider,
        model=llm_config.model,
        api_key=llm_config.api_key,
        base_url=llm_config.base_url,
        temperature=llm_config.temperature,
        max_tokens=llm_config.max_tokens,
    )

    history_lines: List[str] = []
    for msg in history_msgs:
        name, content = _format_msg(msg, user_details)
        if content:
            history_lines.append(f"{name}: {content}")

    print(f"[Info] group_id={group_id}")
    print(f"[Info] owner={owner_name} ({owner_user_id})")
    print(f"[Info] friend={friend_name} ({friend_user_id})")
    print(f"[Info] history messages={len(history_msgs)}")
    print(f"[Info] stream candidate messages={len(stream_msgs)}")
    print(f"[Info] mode={args.mode}")
    print()

    replied = 0
    responder_trace_path = _init_responder_trace()
    for msg in stream_msgs:
        if replied >= args.stream_limit:
            break
        if msg.get("sender") != friend_user_id:
            continue

        _, incoming_text = _format_msg(msg, user_details)
        if not incoming_text:
            continue

        history_lines.append(f"{friend_name}: {incoming_text}")
        recent_history = history_lines[-args.history_window :]

        reply_willingness, willingness_reason = _infer_reply_willingness(
            incoming_text, owner_name
        )
        print(f"[Info] 回复意愿={reply_willingness}，原因：{willingness_reason}")

        if args.mode == "single":
            recent_owner_replies = _extract_recent_owner_replies(
                recent_history, owner_name, limit=2
            )
            prompt = _build_single_prompt(
                owner_user_id=owner_user_id,
                owner_name=owner_name,
                friend_user_id=friend_user_id,
                friend_name=friend_name,
                history_lines=recent_history,
                incoming_text=incoming_text,
                self_profile=self_profile,
                friend_profile=friend_profile,
                reply_willingness=reply_willingness,
                willingness_reason=willingness_reason,
            )
            print("🐣🐣🐣 已发送给 LLM，等待回复…")
            response = await llm.generate(prompt)
            response = response.strip()
            logged_response = _extract_answer_only(response)
            allow_question = _should_allow_question(
                incoming_text=incoming_text,
                reply_willingness=reply_willingness,
                recent_owner_replies=recent_owner_replies,
            )
            context_text = "\n".join(recent_history) + "\n" + incoming_text
            force_fallback = False
            if _looks_official_or_aiy(logged_response):
                force_fallback = True
            if _has_new_concrete_claim(logged_response, context_text):
                force_fallback = True
            if len((logged_response or "").strip()) > 36:
                force_fallback = True
            if force_fallback:
                logged_response = _fallback_human_reply(
                    incoming_text=incoming_text,
                    recent_owner_replies=recent_owner_replies,
                    allow_question=allow_question,
                )
            logged_response = _sanitize_reply_text(logged_response, max_chars=28)
            if _contains_question(logged_response) and not allow_question:
                logged_response = (
                    logged_response.replace("？", "").replace("?", "").strip()
                )
            if not logged_response:
                logged_response = _fallback_human_reply(
                    incoming_text=incoming_text,
                    recent_owner_replies=recent_owner_replies,
                    allow_question=allow_question,
                )
            print("👩‍🍳👩‍🍳👩‍🍳 已收到回复并处理完毕")
            _write_prompt_response(prompt, logged_response, recent_history, label="single")

            print(f"{friend_name}: {incoming_text}")
            print(f"{owner_name}: {logged_response}")
            print("-" * 60)

            history_lines.append(f"{owner_name}: {logged_response}")
            replied += 1
            continue

        planner_prompt = _build_planner_prompt(
            owner_user_id=owner_user_id,
            owner_name=owner_name,
            friend_user_id=friend_user_id,
            friend_name=friend_name,
            history_lines=recent_history,
            incoming_text=incoming_text,
            self_profile=self_profile,
            friend_profile=friend_profile,
            reply_willingness=reply_willingness,
            willingness_reason=willingness_reason,
        )
        print("🐣🐣🐣 已发送给 Planner，等待回复…")
        planner_resp = await llm.generate(planner_prompt)
        planner_resp = planner_resp.strip()
        planner_logged = _extract_answer_only(planner_resp)
        print("👩‍🍳👩‍🍳👩‍🍳 Planner 已完成")
        _write_prompt_response(
            planner_prompt, planner_logged, recent_history, label="planner"
        )

        planner_json = _extract_json_object(planner_logged) or {}
        should_reply = planner_json.get("should_reply")
        if should_reply is None:
            should_reply = reply_willingness != "low"

        if not should_reply:
            print(f"{friend_name}: {incoming_text}")
            print(f"{owner_name}: （不回复）")
            print("-" * 60)
            replied += 1
            continue

        recent_owner_replies = _extract_recent_owner_replies(
            recent_history, owner_name, limit=2
        )

        responder_prompt = _build_responder_prompt(
            owner_user_id=owner_user_id,
            owner_name=owner_name,
            friend_user_id=friend_user_id,
            friend_name=friend_name,
            history_lines=recent_history,
            incoming_text=incoming_text,
            recent_owner_replies=recent_owner_replies,
            self_profile=self_profile,
            friend_profile=friend_profile,
            planner_result=planner_json,
        )
        print("🐣🐣🐣 已发送给 Responder，等待回复…")
        response = await llm.generate(responder_prompt)
        response = response.strip()
        logged_response = _extract_answer_only(response)
        allow_question = _should_allow_question(
            incoming_text=incoming_text,
            reply_willingness=reply_willingness,
            recent_owner_replies=recent_owner_replies,
        )
        if _contains_question(logged_response) and not allow_question:
            logged_response = await _rewrite_to_non_question(
                llm=llm,
                incoming_text=incoming_text,
                response_text=logged_response,
                owner_name=owner_name,
            )

        context_text = "\n".join(recent_history) + "\n" + incoming_text
        force_fallback = False
        if _looks_official_or_aiy(logged_response):
            force_fallback = True
        if _has_new_concrete_claim(logged_response, context_text):
            force_fallback = True
        if len((logged_response or "").strip()) > 36:
            force_fallback = True

        if force_fallback:
            logged_response = _fallback_human_reply(
                incoming_text=incoming_text,
                recent_owner_replies=recent_owner_replies,
                allow_question=allow_question,
            )

        logged_response = _sanitize_reply_text(logged_response, max_chars=28)
        if _contains_question(logged_response) and not allow_question:
            logged_response = logged_response.replace("？", "").replace("?", "").strip()
        if not logged_response:
            logged_response = _fallback_human_reply(
                incoming_text=incoming_text,
                recent_owner_replies=recent_owner_replies,
                allow_question=allow_question,
            )
        print("👩‍🍳👩‍🍳👩‍🍳 已收到回复并处理完毕")
        _write_prompt_response(
            responder_prompt, logged_response, recent_history, label="responder"
        )
        _append_responder_trace(
            responder_trace_path,
            replied + 1,
            planner_json,
            responder_prompt,
            logged_response,
        )

        print(f"{friend_name}: {incoming_text}")
        print(f"{owner_name}: {logged_response}")
        print("-" * 60)

        history_lines.append(f"{owner_name}: {logged_response}")
        replied += 1


if __name__ == "__main__":
    asyncio.run(main())
