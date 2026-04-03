"""Interactive profile reply demo (manual friend input).

Usage:
    uv run python src/bootstrap.py demo/profile_reply_interactive_demo.py --input "my_chat\\xxx.json"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

from dotenv import load_dotenv

from demo.config import LLMConfig
from memory_layer.llm.llm_provider import LLMProvider

from demo.profile_reply_demo import (
    _append_responder_trace,
    _build_default_runtime_message,
    _build_persona_anchors,
    _build_planner_prompt,
    _build_planner_to_responder_message,
    _build_responder_prompt,
    _compact_profile_for_prompt,
    _contains_question,
    _extract_answer_only,
    _extract_json_object,
    _extract_recent_owner_replies,
    _fallback_human_reply,
    _fetch_profiles,
    _format_msg,
    _get_user_name,
    _has_new_concrete_claim,
    _infer_reply_willingness,
    _init_beanie,
    _init_responder_trace,
    _is_off_topic,
    _is_repetitive_reply,
    _load_json,
    _looks_official_or_aiy,
    _rewrite_grounded_casual,
    _rewrite_to_non_question,
    _sanitize_reply_text,
    _should_allow_question,
    _violates_runtime_policy,
    _write_prompt_response,
)


async def _rewrite_to_match_manual_intent(
    *,
    llm: LLMProvider,
    incoming_text: str,
    response_text: str,
    manual_intent_text: str,
    owner_name: str,
) -> str:
    prompt = (
        "你是私聊回复改写器。请根据“用户手动回复意图”改写回复。\n"
        "要求：\n"
        "1) 必须严格符合手动意图（自然语言理解，不做枚举映射）。\n"
        "2) 只输出最终一句话，不解释。\n"
        "3) 不新增事实，不编造承诺，不跑题。\n"
        "4) 尽量保留意图中的关键措辞（如“尽量/先问清楚/委婉拒绝”等），避免被改成泛化套话。\n"
        "5) 保持口语、简短（<=40字）。\n\n"
        f"来消息：{incoming_text}\n"
        f"手动回复意图：{manual_intent_text}\n"
        f"{owner_name}当前回复：{response_text}\n\n"
        "改写后："
    )
    rewritten = await llm.generate(prompt)
    return _extract_answer_only((rewritten or "").strip())


def _intent_semantics_missing(manual_intent_text: str, response_text: str) -> bool:
    intent = (manual_intent_text or "").lower()
    response = (response_text or "").lower()
    if not intent or not response:
        return False

    tokens = re.findall(r"[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}", intent)
    stopwords = {
        "我想",
        "希望",
        "本轮",
        "回复",
        "语气",
        "自然",
        "一点",
        "manual",
        "input",
        "intent",
    }
    keywords = [t for t in tokens if t not in stopwords][:3]
    if not keywords:
        return False
    return not any(k in response for k in keywords)


async def _generate_dual_reply(
    *,
    llm: LLMProvider,
    owner_user_id: str,
    owner_name: str,
    friend_user_id: str,
    friend_name: str,
    incoming_text: str,
    recent_history: List[str],
    persona_anchors: Dict[str, Any],
    self_profile_compact: Dict[str, Any],
    friend_profile_compact: Dict[str, Any],
    responder_trace_path: Path,
    turn_index: int,
    manual_reply_willingness: str | None = None,
    manual_willingness_reason: str | None = None,
    manual_reply_intent: str | None = None,
    manual_intent_reason: str | None = None,
) -> Tuple[bool, str]:
    normalized_manual = (manual_reply_willingness or "").strip().lower()
    if normalized_manual in {"high", "medium", "low"}:
        reply_willingness = normalized_manual
        willingness_reason = (
            (manual_willingness_reason or "").strip() or "manual input"
        )
        print(
            f"[Info] 回复意愿={reply_willingness}，原因：{willingness_reason} (manual)"
        )
    else:
        reply_willingness, willingness_reason = _infer_reply_willingness(
            incoming_text, owner_name
        )
        print(f"[Info] 回复意愿={reply_willingness}，原因：{willingness_reason}")

    planner_prompt = _build_planner_prompt(
        owner_user_id=owner_user_id,
        owner_name=owner_name,
        friend_user_id=friend_user_id,
        friend_name=friend_name,
        history_lines=recent_history,
        incoming_text=incoming_text,
        persona_anchors=persona_anchors,
        self_profile=self_profile_compact,
        friend_profile=friend_profile_compact,
        reply_willingness=reply_willingness,
        willingness_reason=willingness_reason,
    )
    manual_intent_text = (manual_reply_intent or "").strip()
    if manual_intent_text:
        intent_reason = (manual_intent_reason or "").strip() or "manual turn input"
        print(f"[Info] 手动回复意图={manual_intent_text}，原因：{intent_reason}")
        planner_prompt += (
            "\n\n[用户手动回复意图（自然语言约束）]\n"
            f"- intent_text: {manual_intent_text}\n"
            f"- reason: {intent_reason}\n"
            "- 这是一段自然语言意图，不需要做枚举映射。\n"
            "- 你必须理解该意图并据此规划回复方向（语气、立场、措辞、是否追问）。\n"
            "- 优先遵循这条意图提示，并在 reason 和 key_points 中体现你的理解。"
        )
    print("🐣🐣🐣 已发送给 Planner，等待回复…")
    planner_resp = await llm.generate(planner_prompt)
    planner_logged = _extract_answer_only((planner_resp or "").strip())
    print("👩‍🍳👩‍🍳👩‍🍳 Planner 已完成")
    _write_prompt_response(planner_prompt, planner_logged, recent_history, label="planner")

    planner_json = _extract_json_object(planner_logged) or {}
    should_reply = planner_json.get("should_reply")
    if should_reply is None:
        should_reply = reply_willingness != "low"
    if manual_intent_text:
        planner_json["manual_reply_intent"] = manual_intent_text
        planner_json["manual_intent_reason"] = (
            (manual_intent_reason or "").strip() or "manual turn input"
        )

    if not should_reply:
        return False, "（不回复）"

    recent_owner_replies = _extract_recent_owner_replies(
        recent_history, owner_name, limit=4
    )
    planner_message = _build_planner_to_responder_message(
        planner_json=planner_json,
        incoming_text=incoming_text,
        rule_willingness=reply_willingness,
        rule_reason=willingness_reason,
        self_profile_compact=self_profile_compact,
        friend_profile_compact=friend_profile_compact,
        persona_anchors=persona_anchors,
    )
    if manual_intent_text:
        planner_message.setdefault("context", {})
        planner_message["context"]["manual_intent_text"] = manual_intent_text
        planner_message["context"]["manual_intent_reason"] = (
            (manual_intent_reason or "").strip() or "manual turn input"
        )

    responder_prompt = _build_responder_prompt(
        owner_user_id=owner_user_id,
        owner_name=owner_name,
        friend_user_id=friend_user_id,
        friend_name=friend_name,
        history_lines=recent_history,
        incoming_text=incoming_text,
        recent_owner_replies=recent_owner_replies,
        persona_anchors=persona_anchors,
        self_profile=self_profile_compact,
        friend_profile=friend_profile_compact,
        planner_result=planner_message,
    )
    if manual_intent_text:
        responder_prompt += (
            "\n\n[用户手动回复意图（最高优先级）]\n"
            f"- intent_text: {manual_intent_text}\n"
            "- 这是自然语言意图，你必须直接按这个意图组织最终回复。\n"
            "- 若你的回复与该意图不一致，视为失败并自行重写到一致。"
        )
    print("🐣🐣🐣 已发送给 Responder，等待回复…")
    response = await llm.generate(responder_prompt)
    logged_response = _extract_answer_only((response or "").strip())

    planner_decision = planner_message.get("decision") or {}
    allow_question = _should_allow_question(
        incoming_text=incoming_text,
        reply_willingness=reply_willingness,
        recent_owner_replies=recent_owner_replies,
        question_policy=str(planner_decision.get("question_policy") or ""),
    )
    if _contains_question(logged_response) and not allow_question:
        logged_response = await _rewrite_to_non_question(
            llm=llm,
            incoming_text=incoming_text,
            response_text=logged_response,
            owner_name=owner_name,
        )

    context_text = "\n".join(recent_history) + "\n" + incoming_text
    risk_flags: List[str] = []
    if _looks_official_or_aiy(logged_response):
        risk_flags.append("official")
    if _has_new_concrete_claim(logged_response, context_text):
        risk_flags.append("new_claim")
    if _is_repetitive_reply(logged_response, recent_owner_replies):
        risk_flags.append("repetitive")
    if _is_off_topic(logged_response, incoming_text):
        risk_flags.append("off_topic")
    if _violates_runtime_policy(logged_response, planner_message, context_text):
        risk_flags.append("policy_violation")
    if len((logged_response or "").strip()) > 52:
        risk_flags.append("too_long")

    force_fallback = (
        "off_topic" in risk_flags
        or "new_claim" in risk_flags
        or "policy_violation" in risk_flags
        or len(risk_flags) >= 2
    )

    if force_fallback:
        rewritten = await _rewrite_grounded_casual(
            llm=llm,
            incoming_text=incoming_text,
            recent_history=recent_history,
            recent_owner_replies=recent_owner_replies,
            response_text=logged_response,
            owner_name=owner_name,
            planner_message=planner_message,
        )
        if rewritten:
            logged_response = rewritten
            risk_flags = []
            if _looks_official_or_aiy(logged_response):
                risk_flags.append("official")
            if _has_new_concrete_claim(logged_response, context_text):
                risk_flags.append("new_claim")
            if _is_repetitive_reply(logged_response, recent_owner_replies):
                risk_flags.append("repetitive")
            if _is_off_topic(logged_response, incoming_text):
                risk_flags.append("off_topic")
            if _violates_runtime_policy(logged_response, planner_message, context_text):
                risk_flags.append("policy_violation")
            if len((logged_response or "").strip()) > 52:
                risk_flags.append("too_long")
            force_fallback = (
                "off_topic" in risk_flags
                or "new_claim" in risk_flags
                or "policy_violation" in risk_flags
                or len(risk_flags) >= 2
            )

    if force_fallback:
        logged_response = _fallback_human_reply(
            incoming_text=incoming_text,
            recent_owner_replies=recent_owner_replies,
            allow_question=allow_question,
            persona_anchors=persona_anchors,
            planner_message=planner_message,
        )

    logged_response = _sanitize_reply_text(logged_response, max_chars=42)
    if _contains_question(logged_response) and not allow_question:
        logged_response = logged_response.replace("？", "").replace("?", "").strip()
    if not logged_response:
        runtime_message = _build_default_runtime_message(
            incoming_text=incoming_text,
            reply_willingness=reply_willingness,
        )
        logged_response = _fallback_human_reply(
            incoming_text=incoming_text,
            recent_owner_replies=recent_owner_replies,
            allow_question=allow_question,
            persona_anchors=persona_anchors,
            planner_message=runtime_message,
        )
    if manual_intent_text and logged_response and logged_response != "（不回复）":
        intent_aligned = await _rewrite_to_match_manual_intent(
            llm=llm,
            incoming_text=incoming_text,
            response_text=logged_response,
            manual_intent_text=manual_intent_text,
            owner_name=owner_name,
        )
        if _intent_semantics_missing(manual_intent_text, intent_aligned):
            intent_aligned = await _rewrite_to_match_manual_intent(
                llm=llm,
                incoming_text=incoming_text,
                response_text=intent_aligned or logged_response,
                manual_intent_text=manual_intent_text,
                owner_name=owner_name,
            )
        intent_aligned = _sanitize_reply_text(intent_aligned, max_chars=42)
        if intent_aligned:
            logged_response = intent_aligned

    print("👩‍🍳👩‍🍳👩‍🍳 已收到回复并处理完毕")
    _write_prompt_response(
        responder_prompt, logged_response, recent_history, label="responder"
    )
    _append_responder_trace(
        responder_trace_path,
        turn_index,
        planner_message,
        responder_prompt,
        logged_response,
        self_profile_compact,
        friend_profile_compact,
    )
    return True, logged_response


async def main() -> None:
    parser = argparse.ArgumentParser(description="Interactive dual-agent reply demo")
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
    print(f"[Info] persona anchors={json.dumps(persona_anchors, ensure_ascii=False) if persona_anchors else '{}'}")
    print("[Info] 初始历史对话如下：")
    for idx, line in enumerate(history_lines, start=1):
        print(f"{idx:02d}. {line}")
    print("[Info] 输入好友消息开始模拟；输入 /exit 结束，输入 /history 查看最近历史。")
    print("-" * 60)

    responder_trace_path = _init_responder_trace()
    turn = 0

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
        )

        print(f"{friend_name}: {user_input}")
        print(f"{owner_name}: {response_text}")
        print("-" * 60)

        if replied and response_text and response_text != "（不回复）":
            history_lines.append(f"{owner_name}: {response_text}")


if __name__ == "__main__":
    asyncio.run(main())
