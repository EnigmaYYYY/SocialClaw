from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from socket import timeout as SocketTimeout
from time import sleep
from time import perf_counter

import httpx

from social_copilot.visual_monitor.core.vlm_structured_parser import (
    parse_vlm_structured_content,
    parse_vlm_structured_payload,
)
from social_copilot.visual_monitor.models.vlm_structured import VLMStructuredMessage

DEFAULT_TIMEOUT_RETRY_ATTEMPTS = 2
DEFAULT_TIMEOUT_RETRY_DELAY_MS = 250


DEFAULT_WECHAT_STRUCTURED_PROMPT = """任务：你会收到一张完整的微信窗口截图。请只提取当前主会话的结构化聊天消息。
第一步必须先做：读取右侧主聊天面板顶部的会话标题（群名或联系人名）作为 conversation_title。
- 标题若含人数后缀，去掉后缀：例如“三个臭皮匠(3)”->“三个臭皮匠”。
- 只要主会话标题清晰可见，就不能输出 null。

场景约束：
- 输入是整个微信窗口，不只是聊天气泡区域。
- 只提取右侧主聊天面板中的真实消息。
- 不要提取左侧会话列表里的预览文本、未读角标、搜索框内容、输入框草稿、工具栏按钮、系统菜单、顶部功能按钮。
- 可以利用整个窗口中的主会话头部、聊天区时间分隔、左侧当前会话时间提示来辅助判断，但这些辅助区域本身不是消息。

微信发送方判定规则：
- 右侧绿色气泡、右侧自己的头像，判定为 user。
- 左侧白色气泡、左侧对方头像，判定为 contact。
- 不要因为文字行很长、文本框靠近中间，就把左侧白气泡误判成 user。

输出规则：
1) 消息顺序按从上到下；不要重复同一条消息。
2) user 的 contact_name 必须是 null。
3) 群聊里 contact_name=该气泡上方昵称；单聊里 contact_name=conversation_title。
4) 如果消息是“回复/引用”样式，请把主消息正文放在 text，把被引用内容放进 quoted_message.text；如果能看清被引用人的名字，再填 quoted_message.sender_name。
5) 非文字消息也要输出：text 为空字符串，non_text_description 给简短、稳定、克制的描述。
6) 对贴纸、表情包、图片，优先给出稳定、简洁、可重复的描述；不要写得太有创意，不要加入主观解释。
7) non_text_signature_parts 请使用 2-6 个稳定短词概括核心元素，便于应用层去重；不要塞完整句子。
8) 尽量输出 window_time_context：聊天区可见时间分隔、左侧当前选中会话的时间提示。
9) 对消息时间，优先输出 time_anchor；只有在截图里真的看到了时间文本时，time_anchor.value 才能填写具体值。
10) 如果看不到明确时间，不要编造时间；保留合适的 source，并让 value 为 null。
11) 不要把左侧会话列表中当前选中项的最后一条预览，当成右侧主会话里的真实消息。

只输出严格 JSON（不要 Markdown/解释）：
{"schema_version":"draft-1","app_name":"WeChat","capture_time":"ISO-8601 string|null","conversation":{"display_title":"string|null","title_confidence":0.0,"title_source":"main_header|window_context|inferred|unknown"},"window_time_context":{"visible_time_markers":[{"value":"string","source":"chat_separator|sidebar_selected_session|other","position_hint":"string|null"}],"selected_session_time_hint":{"value":"string|null","source":"sidebar_selected_session|other"}},"messages":[{"sender":"user|contact|unknown","contact_name":"string|null","text":"string","content_type":"text|emoji|sticker|image|mixed|unknown","non_text_description":"string|null","non_text_signature_parts":["string"],"quoted_message":{"text":"string","sender_name":"string|null"},"time_anchor":{"value":"string|null","source":"exact_separator|sidebar_selected_session|segment_inferred|capture_fallback|unknown","confidence":0.0},"confidence":0.0}],"extraction_meta":{"mode":"snapshot"}}"""

DEFAULT_WECHAT_INCREMENTAL_PROMPT = """你会收到两张完整的微信窗口截图：older（上一帧）与 newer（当前帧）。
任务：只输出 newer 相比 older 在当前主会话中新出现的消息。
先读取 newer 的主聊天区域顶部会话标题作为 conversation_title（群名需去掉人数后缀）。
- 不要提取左侧会话列表里的预览文本、搜索框内容、输入框草稿、工具栏按钮或顶部功能按钮。
- 左侧当前选中项和聊天区时间分隔只可作为辅助判断，不能直接当消息。
微信发送方判定规则：
- 右侧绿色气泡、右侧自己的头像，判定为 user。
- 左侧白色气泡、左侧对方头像，判定为 contact。
- 不要因为文字行很长、文本框靠近中间，就把左侧白气泡误判成 user。

规则：
1) 若无新增，返回 {"conversation_title":"...或null","messages":[]}。
2) 不要重复 older 里已有消息；顺序按从上到下。
3) user 的 contact_name 必须为 null。
4) 群聊 contact_name=气泡上方昵称；单聊 contact_name=conversation_title。
5) 如果消息是“回复/引用”样式，请把主消息正文放在 text，把被引用内容放进 quoted_message.text；如果能看清被引用人的名字，再填 quoted_message.sender_name。
6) 非文字消息也必须输出（text=""，并提供稳定简洁的 non_text_description）。
7) non_text_signature_parts 请使用稳定短词，不要写完整句子，不要每次换一种描述方式。
8) 如果 newer 看起来已经不是 older 中的那个主会话，也仍然返回当前真实 conversation_title，并对当前主会话保守处理。
9) 尽量输出 window_time_context 与每条消息的 time_anchor。
10) 只有在截图里真的看到了时间文本时，time_anchor.value 才能填写具体值；不要编造时间。
11) 如果无法确定某条内容是不是 older 已存在，宁可不输出，也不要把旧消息重复当作新增。

只输出严格 JSON（不要 Markdown/解释）：
{"schema_version":"draft-1","app_name":"WeChat","capture_time":"ISO-8601 string|null","conversation":{"display_title":"string|null","title_confidence":0.0,"title_source":"main_header|window_context|inferred|unknown"},"window_time_context":{"visible_time_markers":[{"value":"string","source":"chat_separator|sidebar_selected_session|other","position_hint":"string|null"}],"selected_session_time_hint":{"value":"string|null","source":"sidebar_selected_session|other"}},"messages":[{"sender":"user|contact|unknown","contact_name":"string|null","text":"string","content_type":"text|emoji|sticker|image|mixed|unknown","non_text_description":"string|null","non_text_signature_parts":["string"],"quoted_message":{"text":"string","sender_name":"string|null"},"time_anchor":{"value":"string|null","source":"exact_separator|sidebar_selected_session|segment_inferred|capture_fallback|unknown","confidence":0.0},"confidence":0.0}],"extraction_meta":{"mode":"incremental"}}"""


@dataclass(slots=True)
class LiteLLMStructuredVisionConfig:
    base_url: str
    model: str
    api_key: str = ""
    api_key_env: str = "SOCIAL_COPILOT_VLM_API_KEY"
    timeout_ms: int = 8000
    max_tokens: int = 800
    temperature: float = 0.0


@dataclass(slots=True)
class LiteLLMStructuredVisionResult:
    messages: list[VLMStructuredMessage]
    conversation_title: str | None
    schema_version: str | None
    conversation: dict[str, object] | None
    window_time_context: dict[str, object] | None
    extraction_meta: dict[str, object] | None
    raw_response: str
    raw_content: str
    attempt_count: int
    attempt_errors: list[str]
    parse_ok: bool
    roundtrip_ms: float
    litellm_duration_ms: float | None
    provider_duration_ms: float | None
    error: str | None


class LiteLLMStructuredVisionAdapter:
    def __init__(self, config: LiteLLMStructuredVisionConfig) -> None:
        self._config = config

    @staticmethod
    def _rabbit_log(message: str) -> None:
        print(f"🐰🐰🐰 {message}", flush=True)

    def extract_structured(
        self,
        image_png: bytes,
        expected_conversation_title: str | None = None,
    ) -> LiteLLMStructuredVisionResult:
        return self._extract_structured_with_prompt(
            images_png=[image_png],
            prompt=self._apply_expected_title_hint(DEFAULT_WECHAT_STRUCTURED_PROMPT, expected_conversation_title),
        )

    def extract_structured_incremental(
        self,
        older_image_png: bytes,
        newer_image_png: bytes,
        expected_conversation_title: str | None = None,
    ) -> LiteLLMStructuredVisionResult:
        return self._extract_structured_with_prompt(
            images_png=[older_image_png, newer_image_png],
            prompt=self._apply_expected_title_hint(DEFAULT_WECHAT_INCREMENTAL_PROMPT, expected_conversation_title),
        )

    @staticmethod
    def _apply_expected_title_hint(prompt: str, expected_conversation_title: str | None) -> str:
        title = (expected_conversation_title or "").strip()
        if not title:
            return prompt
        return (
            f"{prompt}\n\n"
            f"辅助提示：上一次确认的主会话标题是“{title}”。"
            "这只是提示，不一定仍然正确。"
            "你必须先检查当前主会话是否仍是该标题，再返回当前真实 conversation_title。"
        )

    def _extract_structured_with_prompt(
        self,
        images_png: list[bytes],
        prompt: str,
    ) -> LiteLLMStructuredVisionResult:
        if not images_png:
            result = LiteLLMStructuredVisionResult(
                messages=[],
                conversation_title=None,
                schema_version=None,
                conversation=None,
                window_time_context=None,
                extraction_meta=None,
                raw_response="",
                raw_content="",
                attempt_count=0,
                attempt_errors=[],
                parse_ok=False,
                roundtrip_ms=0.0,
                litellm_duration_ms=None,
                provider_duration_ms=None,
                error="empty_images_png",
            )
            self._persist_debug_log(prompt=prompt, images_png=images_png, result=result)
            return result

        api_key = self._config.api_key.strip() or os.getenv(self._config.api_key_env, "").strip()
        if not api_key:
            result = LiteLLMStructuredVisionResult(
                messages=[],
                conversation_title=None,
                schema_version=None,
                conversation=None,
                window_time_context=None,
                extraction_meta=None,
                raw_response="",
                raw_content="",
                attempt_count=0,
                attempt_errors=[],
                parse_ok=False,
                roundtrip_ms=0.0,
                litellm_duration_ms=None,
                provider_duration_ms=None,
                error=f"missing_api_key_env:{self._config.api_key_env}",
            )
            self._persist_debug_log(prompt=prompt, images_png=images_png, result=result)
            return result

        content_blocks: list[dict[str, object]] = [{"type": "text", "text": prompt}]
        for image_png in images_png:
            image_base64 = base64.b64encode(image_png).decode("ascii")
            content_blocks.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}})

        payload = {
            "model": self._config.model,
            "messages": [
                {
                    "role": "user",
                    "content": content_blocks,
                }
            ],
            "temperature": self._config.temperature,
            "max_tokens": self._config.max_tokens,
            "stream": False,
        }
        url = f"{self._config.base_url.rstrip('/')}/chat/completions"
        started = perf_counter()
        raw = ""
        headers: dict[str, str] = {}
        attempt_errors: list[str] = []
        attempt_count = 0
        for attempt in range(1, DEFAULT_TIMEOUT_RETRY_ATTEMPTS + 1):
            attempt_count = attempt
            self._rabbit_log(
                "VLM request send "
                f"(attempt={attempt}/{DEFAULT_TIMEOUT_RETRY_ATTEMPTS}, "
                f"model={self._config.model}, image_count={len(images_png)})"
            )
            try:
                with httpx.Client(timeout=self._config.timeout_ms / 1000.0, trust_env=False) as client:
                    response = client.post(
                        url,
                        json=payload,
                        headers={
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {api_key}",
                            "User-Agent": "social-copilot-vlm/1.0",
                        },
                    )
                    raw = response.text
                    response.raise_for_status()
                    headers = {key.lower(): value for key, value in response.headers.items()}
                self._rabbit_log(
                    "VLM response received "
                    f"(attempt={attempt}/{DEFAULT_TIMEOUT_RETRY_ATTEMPTS}, status={response.status_code})"
                )
                break
            except httpx.HTTPStatusError as exc:
                error_text = f"HTTPStatusError:{exc.response.status_code}:{_compact_error_body(exc.response.text)}"
                attempt_errors.append(error_text)
                self._rabbit_log(
                    "VLM response received with HTTPStatusError "
                    f"(attempt={attempt}/{DEFAULT_TIMEOUT_RETRY_ATTEMPTS}, error={error_text})"
                )
                result = LiteLLMStructuredVisionResult(
                    messages=[],
                    conversation_title=None,
                    schema_version=None,
                    conversation=None,
                    window_time_context=None,
                    extraction_meta=None,
                    raw_response="",
                    raw_content="",
                    attempt_count=attempt_count,
                    attempt_errors=attempt_errors,
                    parse_ok=False,
                    roundtrip_ms=(perf_counter() - started) * 1000.0,
                    litellm_duration_ms=None,
                    provider_duration_ms=None,
                    error=error_text,
                )
                self._persist_debug_log(prompt=prompt, images_png=images_png, result=result)
                return result
            except httpx.HTTPError as exc:
                error_text = f"HTTPError:{exc}"
                attempt_errors.append(error_text)
                self._rabbit_log(
                    "VLM response received with HTTPError "
                    f"(attempt={attempt}/{DEFAULT_TIMEOUT_RETRY_ATTEMPTS}, error={error_text})"
                )
                if attempt >= DEFAULT_TIMEOUT_RETRY_ATTEMPTS or not _is_timeout_error(exc):
                    result = LiteLLMStructuredVisionResult(
                        messages=[],
                        conversation_title=None,
                        schema_version=None,
                        conversation=None,
                        window_time_context=None,
                        extraction_meta=None,
                        raw_response="",
                        raw_content="",
                        attempt_count=attempt_count,
                        attempt_errors=attempt_errors,
                        parse_ok=False,
                        roundtrip_ms=(perf_counter() - started) * 1000.0,
                        litellm_duration_ms=None,
                        provider_duration_ms=None,
                        error=error_text,
                    )
                    self._persist_debug_log(prompt=prompt, images_png=images_png, result=result)
                    return result
            except Exception as exc:  # pragma: no cover
                error_text = str(exc)
                attempt_errors.append(error_text)
                self._rabbit_log(
                    "VLM response received with Exception "
                    f"(attempt={attempt}/{DEFAULT_TIMEOUT_RETRY_ATTEMPTS}, error={error_text})"
                )
                if attempt >= DEFAULT_TIMEOUT_RETRY_ATTEMPTS or not _is_timeout_error(exc):
                    result = LiteLLMStructuredVisionResult(
                        messages=[],
                        conversation_title=None,
                        schema_version=None,
                        conversation=None,
                        window_time_context=None,
                        extraction_meta=None,
                        raw_response="",
                        raw_content="",
                        attempt_count=attempt_count,
                        attempt_errors=attempt_errors,
                        parse_ok=False,
                        roundtrip_ms=(perf_counter() - started) * 1000.0,
                        litellm_duration_ms=None,
                        provider_duration_ms=None,
                        error=error_text,
                    )
                    self._persist_debug_log(prompt=prompt, images_png=images_png, result=result)
                    return result
            if attempt < DEFAULT_TIMEOUT_RETRY_ATTEMPTS:
                sleep(DEFAULT_TIMEOUT_RETRY_DELAY_MS / 1000.0)

        roundtrip_ms = (perf_counter() - started) * 1000.0
        raw_content = _extract_content_from_chat_completion(raw)
        payload = parse_vlm_structured_payload(raw_content)
        messages, parse_ok, conversation_title = parse_vlm_structured_content(raw_content)
        self._rabbit_log(
            "VLM structured parse complete "
            f"(attempt={attempt_count}, parse_ok={parse_ok}, message_count={len(messages)}, "
            f"roundtrip_ms={round(roundtrip_ms, 2)})"
        )
        result = LiteLLMStructuredVisionResult(
            messages=messages,
            conversation_title=conversation_title,
            schema_version=payload.schema_version if payload is not None else None,
            conversation=payload.conversation.model_dump(mode="json") if payload is not None and payload.conversation is not None else None,
            window_time_context=payload.window_time_context.model_dump(mode="json") if payload is not None and payload.window_time_context is not None else None,
            extraction_meta=payload.extraction_meta if payload is not None else None,
            raw_response=raw,
            raw_content=raw_content,
            attempt_count=attempt_count,
            attempt_errors=attempt_errors,
            parse_ok=parse_ok,
            roundtrip_ms=roundtrip_ms,
            litellm_duration_ms=_to_float(headers.get("x-litellm-response-duration-ms")),
            provider_duration_ms=_to_float(headers.get("llm_provider-req-cost-time")),
            error=None,
        )
        self._persist_debug_log(prompt=prompt, images_png=images_png, result=result)
        return result

    def _persist_debug_log(
        self,
        prompt: str,
        images_png: list[bytes],
        result: LiteLLMStructuredVisionResult,
    ) -> None:
        try:
            log_dir = self._log_dir()
            log_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
            payload = {
                "timestamp_utc": datetime.now(tz=timezone.utc).isoformat(),
                "model": self._config.model,
                "base_url": self._config.base_url,
                "prompt": prompt,
                "image_count": len(images_png),
                "image_sizes": [len(item) for item in images_png],
                "attempt_count": result.attempt_count,
                "attempt_errors": result.attempt_errors,
                "parse_ok": result.parse_ok,
                "schema_version": result.schema_version,
                "conversation_title": result.conversation_title,
                "conversation": result.conversation,
                "window_time_context": result.window_time_context,
                "extraction_meta": result.extraction_meta,
                "messages": [item.model_dump(mode="json") for item in result.messages],
                "error": result.error or "",
                "roundtrip_ms": result.roundtrip_ms,
                "litellm_duration_ms": result.litellm_duration_ms,
                "provider_duration_ms": result.provider_duration_ms,
                "raw_response": result.raw_response,
                "raw_content": result.raw_content,
            }
            log_path = log_dir / f"vlm_{timestamp}.json"
            log_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            # VLM logging is best-effort and must not break extraction.
            return

    @staticmethod
    def _log_dir() -> Path:
        return Path(__file__).resolve().parents[2] / "log"


def _extract_content_from_chat_completion(raw: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip()

    choices = payload.get("choices", [])
    if not choices:
        return ""
    message = choices[0].get("message", {})
    content = message.get("content", "")
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                chunks.append(str(item.get("text", "")))
        return "\n".join(chunks).strip()
    return str(content).strip()


def _compact_error_body(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text

    error = payload.get("error")
    if isinstance(error, dict):
        message = str(error.get("message", "")).strip()
        code = str(error.get("code", "")).strip()
        type_ = str(error.get("type", "")).strip()
        parts = [part for part in [type_, code, message] if part]
        if parts:
            return ":".join(parts)
    return text


def _to_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value.strip())
    except Exception:
        return None


def _is_timeout_error(exc: Exception) -> bool:
    if isinstance(exc, SocketTimeout):
        return True
    if isinstance(exc, httpx.TimeoutException):
        return True
    reason = getattr(exc, "reason", None)
    if isinstance(reason, SocketTimeout):
        return True
    text = str(exc).strip().lower()
    return "timed out" in text or "timeout" in text
