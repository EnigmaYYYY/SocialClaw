"""Extract reply templates from historical chat only.

Usage:
    uv run python src/bootstrap.py demo/history_template_extractor_demo.py \
      --input "my_chat\\xxx.json" \
      --history-count 120 \
      --output "logs\\reply_template\\xxx_templates.jsonl"
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


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


def _contains_question(text: str) -> bool:
    t = (text or "").strip()
    return ("?" in t) or ("？" in t)


def _detect_emotion(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return "neutral"
    negative_words = ("难", "悬", "不好", "焦虑", "压力", "不确定", "不大好", "没机会", "挺难")
    positive_words = ("好", "可以", "不错", "稳", "有机会", "太好了")
    if any(w in t for w in negative_words):
        return "slightly_negative"
    if any(w in t for w in positive_words):
        return "positive"
    return "neutral"


def _classify_intent(incoming_text: str, reply_text: str) -> str:
    incoming = (incoming_text or "").strip()
    reply = (reply_text or "").strip()
    if _contains_question(reply):
        return "clarify"
    if _contains_question(incoming):
        return "answer"
    if any(k in incoming for k in ("难", "焦虑", "不确定", "悬", "不好", "压力")):
        return "support"
    if any(k in reply for k in ("建议", "可以先", "先", "最好", "不如")):
        return "suggestion"
    if len(incoming) <= 5:
        return "confirm"
    return "statement"


def _classify_relation_type(friend_profile: Optional[Dict[str, Any]]) -> str:
    if not friend_profile:
        return "general"
    relation = str(friend_profile.get("relationship") or "").strip()
    if not relation:
        return "general"
    intimate_keywords = ("朋友", "好友", "闺蜜", "兄弟", "家人", "恋人", "情侣")
    formal_keywords = ("同事", "导师", "老师", "上级", "客户", "合作方")
    if any(k in relation for k in intimate_keywords):
        return "intimate"
    if any(k in relation for k in formal_keywords):
        return "formal"
    return "general"


def _extract_risk_flags(reply_text: str) -> List[str]:
    text = (reply_text or "").strip()
    flags: List[str] = []
    if any(
        k in text
        for k in ("晚点", "回头", "第一时间", "有消息", "同步你", "告诉你", "通知你", "发你")
    ):
        flags.append("future_promise")
    if any(k in text for k in ("冲", "走起", "哈哈", "互相伤害", "!", "！")):
        flags.append("over_excited")
    return flags


def _normalize_text(text: str) -> str:
    t = (text or "").strip()
    for c in "，。！？,.!? \t\r\n":
        t = t.replace(c, "")
    return t


def _extract_templates(
    history_lines: List[str],
    owner_name: str,
    friend_name: str,
    relation_type: str,
) -> List[Dict[str, Any]]:
    templates: List[Dict[str, Any]] = []
    seen = set()

    def parse_line(line: str) -> Tuple[str, str]:
        if ":" not in line:
            return "", (line or "").strip()
        n, c = line.split(":", 1)
        return n.strip(), c.strip()

    for i in range(len(history_lines) - 1):
        n1, c1 = parse_line(history_lines[i])
        n2, c2 = parse_line(history_lines[i + 1])
        if n1 != friend_name or n2 != owner_name:
            continue
        if not c1 or not c2:
            continue
        if len(c2) <= 1:
            continue
        key = _normalize_text(c1 + "||" + c2)
        if not key or key in seen:
            continue
        seen.add(key)

        templates.append(
            {
                "template_id": f"tpl_{len(templates)+1:04d}",
                "incoming_text": c1,
                "reply_text": c2,
                "intent_type": _classify_intent(c1, c2),
                "emotion_in": _detect_emotion(c1),
                "relation_type": relation_type,
                "style_tags": {
                    "is_question": _contains_question(c2),
                    "length": len(c2),
                },
                "risk_flags": _extract_risk_flags(c2),
            }
        )

    return templates


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract history reply templates")
    parser.add_argument("--input", required=True, help="Input conversation JSON file")
    parser.add_argument(
        "--history-count",
        type=int,
        default=120,
        help="How many text messages used as history for extraction",
    )
    parser.add_argument("--owner-user-id", default="", help="Override owner user id")
    parser.add_argument("--friend-user-id", default="", help="Override friend user id")
    parser.add_argument("--relation-type", default="", choices=["", "intimate", "formal", "general"])
    parser.add_argument("--output", default="", help="Output jsonl path")
    args = parser.parse_args()

    input_path = Path(args.input)
    data = _load_json(input_path)
    meta = data.get("conversation_meta", {}) or {}
    user_details = meta.get("user_details", {}) or {}

    owner_user_id = args.owner_user_id or (meta.get("scene_desc") or {}).get("owner_user_id", "")
    if not owner_user_id and user_details:
        owner_user_id = list(user_details.keys())[0]
    friend_user_id = args.friend_user_id
    if not friend_user_id and user_details:
        candidates = [uid for uid in user_details.keys() if uid != owner_user_id]
        friend_user_id = candidates[0] if candidates else ""

    owner_name = _get_user_name(user_details, owner_user_id)
    friend_name = _get_user_name(user_details, friend_user_id)

    raw_list = data.get("conversation_list") or []
    text_messages = [
        m
        for m in raw_list
        if (m.get("type") == "text" or m.get("type") is None) and (m.get("content") is not None)
    ]
    history_count = max(0, min(args.history_count, len(text_messages)))
    history_msgs = text_messages[:history_count]

    history_lines: List[str] = []
    for msg in history_msgs:
        name, content = _format_msg(msg, user_details)
        if content:
            history_lines.append(f"{name}: {content}")

    relation_type = args.relation_type or "general"
    templates = _extract_templates(
        history_lines=history_lines,
        owner_name=owner_name,
        friend_name=friend_name,
        relation_type=relation_type,
    )

    out_path = Path(args.output) if args.output else Path("logs") / "reply_template" / f"{time.strftime('%Y%m%d_%H%M%S')}_templates.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fp:
        for t in templates:
            fp.write(json.dumps(t, ensure_ascii=False) + "\n")

    print(f"[Info] owner={owner_name} ({owner_user_id})")
    print(f"[Info] friend={friend_name} ({friend_user_id})")
    print(f"[Info] history_lines={len(history_lines)}")
    print(f"[Info] relation_type={relation_type}")
    print(f"[Info] extracted_templates={len(templates)}")
    print(f"[Info] output={out_path}")


if __name__ == "__main__":
    main()
