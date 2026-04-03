"""Shared reply template extraction utilities."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional


def _contains_question(text: str) -> bool:
    t = (text or "").strip()
    return ("?" in t) or ("？" in t)


def _detect_emotion(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return "neutral"
    negative_words = ("难", "急", "不好", "焦虑", "压力", "不确定", "不大好", "没机会", "挺难")
    positive_words = ("好", "可以", "不错", "稳", "有机会", "太好了")
    if any(w in t for w in negative_words):
        return "slightly_negative"
    if any(w in t for w in positive_words):
        return "positive"
    return "neutral"


def _classify_template_intent(incoming_text: str, reply_text: str) -> str:
    incoming = (incoming_text or "").strip()
    reply = (reply_text or "").strip()
    if _contains_question(reply):
        return "clarify"
    if _contains_question(incoming):
        return "answer"
    if any(k in incoming for k in ("难", "焦虑", "不确定", "急", "不好", "压力")):
        return "support"
    if any(k in reply for k in ("建议", "可以先", "先", "最好", "不如")):
        return "suggestion"
    if len(incoming) <= 5:
        return "confirm"
    return "statement"


def _extract_template_risk_flags(reply_text: str) -> List[str]:
    text = (reply_text or "").strip()
    flags: List[str] = []
    if any(
        k in text
        for k in ("晚点", "回头", "第一时间", "有消息", "同步", "告诉你", "通知你", "发你")
    ):
        flags.append("future_promise")
    if any(k in text for k in ("冲", "走起", "哈哈", "互相伤害", "!", "！")):
        flags.append("over_excited")
    return flags


def _normalize_template_key(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(r"[，。！？,.!?\s]+", "", t)
    return t


def _parse_msg_time(msg: Dict[str, Any]) -> datetime:
    value = (
        msg.get("timestamp")
        or msg.get("createTime")
        or msg.get("create_time")
        or msg.get("updateTime")
        or msg.get("update_time")
    )
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.utcnow()


def _get_sender_id(msg: Dict[str, Any]) -> str:
    return str(
        msg.get("speaker_id")
        or msg.get("createBy")
        or msg.get("sender")
        or msg.get("user_id")
        or ""
    ).strip()


def _get_sender_name(msg: Dict[str, Any], user_id_to_name: Optional[Dict[str, str]]) -> str:
    name = str(
        msg.get("speaker_name")
        or msg.get("fullName")
        or msg.get("sender_name")
        or ""
    ).strip()
    if name:
        return name
    uid = _get_sender_id(msg)
    if uid and user_id_to_name:
        return str(user_id_to_name.get(uid) or uid)
    return uid


def _get_message_id(msg: Dict[str, Any]) -> str:
    for key in ("_id", "message_id", "data_id", "id", "original_id"):
        value = msg.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _is_text_message(msg: Dict[str, Any]) -> bool:
    msg_type = msg.get("msgType")
    if msg_type is None:
        return True
    try:
        return int(msg_type) == 1
    except (TypeError, ValueError):
        return False


def extract_reply_templates_from_messages(
    messages: List[Dict[str, Any]],
    *,
    owner_user_id: str,
    scene: str,
    group_id: str,
    source_event_id: Optional[str] = None,
    user_id_to_name: Optional[Dict[str, str]] = None,
    relation_type: str = "general",
) -> List[Dict[str, Any]]:
    """
    Extract adjacent (incoming -> owner reply) templates from messages.
    """
    owner = (owner_user_id or "").strip()
    if not owner:
        return []

    filtered: List[Dict[str, Any]] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        if not _is_text_message(msg):
            continue
        content = (msg.get("content") or "").strip()
        if not content:
            continue
        filtered.append(msg)

    if len(filtered) < 2:
        return []

    templates: List[Dict[str, Any]] = []
    seen = set()
    for i in range(len(filtered) - 1):
        m1 = filtered[i]
        m2 = filtered[i + 1]
        s1 = _get_sender_id(m1)
        s2 = _get_sender_id(m2)
        if not s1 or not s2:
            continue
        if s1 == owner or s2 != owner:
            continue

        incoming_text = (m1.get("content") or "").strip()
        reply_text = (m2.get("content") or "").strip()
        if not incoming_text or not reply_text:
            continue

        key = _normalize_template_key(f"{incoming_text}||{reply_text}")
        dedupe_key = f"{s1}|{key}"
        if not key or dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        message_ids = [_get_message_id(m1), _get_message_id(m2)]
        source_message_ids = [x for x in message_ids if x]
        now = _parse_msg_time(m2)

        templates.append(
            {
                "owner_user_id": owner,
                "peer_user_id": s1,
                "group_id": group_id,
                "scene": scene,
                "template_key": key,
                "incoming_text": incoming_text,
                "reply_text": reply_text,
                "intent_type": _classify_template_intent(incoming_text, reply_text),
                "emotion_in": _detect_emotion(incoming_text),
                "from_user_id": s1,
                "to_user_id": s2,
                "from_user_name": _get_sender_name(m1, user_id_to_name),
                "to_user_name": _get_sender_name(m2, user_id_to_name),
                "source_message_ids": source_message_ids,
                "source_event_ids": [source_event_id] if source_event_id else [],
                "risk_flags": _extract_template_risk_flags(reply_text),
                "style_tags": {
                    "is_question": _contains_question(reply_text),
                    "length": len(reply_text),
                    "relation_type": relation_type,
                },
                "first_seen_at": now,
                "last_seen_at": now,
            }
        )

    return templates

