"""Interactive dual-agent reply demo with manual reply intent input.

Usage:
    uv run python src/bootstrap.py demo/profile_reply_interactive_manual_intent_demo.py --input "my_chat\\xxx.json"
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv

from demo.config import LLMConfig
from demo.profile_reply_demo import (
    _build_persona_anchors,
    _compact_profile_for_prompt,
    _fetch_profiles,
    _format_msg,
    _get_user_name,
    _init_beanie,
    _init_responder_trace,
    _load_json,
)
from demo.profile_reply_interactive_demo import _generate_dual_reply
from memory_layer.llm.llm_provider import LLMProvider


def _resolve_manual_intent(
    *,
    raw_input: str,
    default_intent: str,
) -> Tuple[Optional[str], Optional[str]]:
    text = (raw_input or "").strip()
    lowered = text.lower()
    if lowered in {"auto", "/auto"}:
        return None, None
    if text:
        return text, "manual turn input"

    if not text:
        if default_intent != "auto":
            return default_intent, "manual default"
        return None, None

    return None, None


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interactive dual-agent reply demo (manual intent)"
    )
    parser.add_argument("--input", required=True, help="Input conversation JSON file")
    parser.add_argument(
        "--history-count",
        type=int,
        default=30,
        help="Number of messages to use as initial history (default: 30)",
    )
    parser.add_argument(
        "--history-window",
        type=int,
        default=20,
        help="How many recent lines to include in each turn (default: 20)",
    )
    parser.add_argument("--owner-user-id", default="", help="Override owner_user_id")
    parser.add_argument("--friend-user-id", default="", help="Override friend_user_id")
    parser.add_argument(
        "--intent-default",
        default="auto",
        help="Default free-text intent when you press Enter; use auto for automatic planning (default: auto)",
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

    await _init_beanie()
    self_profile, friend_profile = await _fetch_profiles(
        group_id, owner_user_id, friend_user_id
    )
    self_profile_compact = _compact_profile_for_prompt(
        self_profile, owner_user_id, owner_name, role="self"
    )
    friend_profile_compact = _compact_profile_for_prompt(
        friend_profile, friend_user_id, friend_name, role="friend"
    )
    persona_anchors = _build_persona_anchors(self_profile)

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
    print(f"[Info] initial history={len(history_lines)}")
    print(
        f"[Info] persona anchors={json.dumps(persona_anchors, ensure_ascii=False) if persona_anchors else '{}'}"
    )
    print("[Info] 初始历史对话如下：")
    for idx, line in enumerate(history_lines, start=1):
        print(f"{idx:02d}. {line}")
    print("[Info] 输入好友消息开始模拟；输入 /exit 结束，输入 /history 查看最近历史。")
    print(
        "[Info] 每轮输入你的自然语言回复意图（例如：我想委婉拒绝、我想先问清楚再答应），输入 auto 走自动。"
    )
    print("-" * 60)

    turn = 0
    responder_trace_path = _init_responder_trace()

    while True:
        user_input = input(f"{friend_name}: ").strip()
        if not user_input:
            continue
        if user_input.lower() in {"/exit", "exit", "quit"}:
            print("[Info] 已结束模拟。")
            break
        if user_input.lower() == "/history":
            print("\n".join(history_lines[-args.history_window:]))
            print("-" * 60)
            continue

        intent_input = input(
            "[Manual] 本轮回复意图（自然语言，或输入 auto 自动判定）： "
        ).strip()
        manual_intent, manual_intent_reason = _resolve_manual_intent(
            raw_input=intent_input,
            default_intent=args.intent_default,
        )

        turn += 1
        history_lines.append(f"{friend_name}: {user_input}")
        recent_history = history_lines[-args.history_window :]

        replied, response_text = await _generate_dual_reply(
            llm=llm,
            owner_user_id=owner_user_id,
            owner_name=owner_name,
            friend_user_id=friend_user_id,
            friend_name=friend_name,
            incoming_text=user_input,
            recent_history=recent_history,
            persona_anchors=persona_anchors,
            self_profile_compact=self_profile_compact,
            friend_profile_compact=friend_profile_compact,
            responder_trace_path=responder_trace_path,
            turn_index=turn,
            manual_reply_intent=manual_intent,
            manual_intent_reason=manual_intent_reason,
        )

        print(f"{friend_name}: {user_input}")
        print(f"{owner_name}: {response_text}")
        print("-" * 60)

        if replied and response_text and response_text != "（不回复）":
            history_lines.append(f"{owner_name}: {response_text}")


if __name__ == "__main__":
    asyncio.run(main())
