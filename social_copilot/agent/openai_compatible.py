from __future__ import annotations

import json
import os
from dataclasses import dataclass
from time import perf_counter
from typing import Any

import httpx


@dataclass(slots=True)
class OpenAICompatibleConfig:
    base_url: str
    model: str
    api_key: str = ""
    api_key_env: str = "SOCIAL_COPILOT_AGENT_API_KEY"
    timeout_ms: int = 12000
    temperature: float = 0.4
    max_tokens: int = 800
    stream_strategy: str = "non_stream"


@dataclass(slots=True)
class OpenAICompatibleToolCall:
    id: str
    name: str
    arguments_text: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class OpenAICompatibleChatResult:
    content: str
    tool_calls: list[OpenAICompatibleToolCall]
    raw_response: str
    headers: dict[str, str]
    status_code: int
    roundtrip_ms: float


class OpenAICompatibleClient:
    def __init__(self, config: OpenAICompatibleConfig) -> None:
        self._config = config

    def chat_completion(self, system_prompt: str, user_prompt: str) -> str:
        result = self.chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            prefer_stream=self._config.stream_strategy == "stream",
            allow_stream_fallback=self._config.stream_strategy == "stream",
        )
        return result.content

    def chat(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, object]] | None = None,
        tool_choice: str | dict[str, object] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, object] | None = None,
        prefer_stream: bool = False,
        allow_stream_fallback: bool = True,
    ) -> OpenAICompatibleChatResult:
        api_key = self._config.api_key.strip() or os.getenv(self._config.api_key_env, "").strip()
        if not api_key:
            raise RuntimeError(f"missing_api_key_env:{self._config.api_key_env}")

        payload: dict[str, Any] = {
            "model": self._config.model,
            "messages": messages,
            "temperature": self._config.temperature if temperature is None else temperature,
            "max_tokens": self._config.max_tokens if max_tokens is None else max_tokens,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice
        if extra_body:
            payload.update(extra_body)
        url = f"{self._config.base_url.rstrip('/')}/chat/completions"
        started = perf_counter()
        request_headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "social-copilot/1.0",
        }
        if prefer_stream:
            streamed_content, streamed_raw, streamed_headers, streamed_status_code = _retry_chat_via_stream(
                client_factory=httpx.Client,
                url=url,
                payload=payload,
                headers=request_headers,
                timeout_seconds=self._config.timeout_ms / 1000.0,
            )
            return OpenAICompatibleChatResult(
                content=streamed_content,
                tool_calls=[],
                raw_response=streamed_raw,
                headers=streamed_headers,
                status_code=streamed_status_code,
                roundtrip_ms=(perf_counter() - started) * 1000.0,
            )
        try:
            with httpx.Client(timeout=self._config.timeout_ms / 1000.0, trust_env=False) as client:
                response = client.post(
                    url,
                    json=payload,
                    headers=request_headers,
                )
                raw = response.text
                response.raise_for_status()
                headers = {key.lower(): value for key, value in response.headers.items()}
        except httpx.HTTPStatusError as exc:
            detail = _compact_error_body(exc.response.text)
            raise RuntimeError(
                f"openai_compatible_request_failed:HTTP {exc.response.status_code}:{detail}"
            ) from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"openai_compatible_request_failed:{exc}") from exc

        status_code = response.status_code
        content, tool_calls = _extract_chat_message(raw)
        if allow_stream_fallback and _should_retry_via_stream(raw=raw, content=content, tool_calls=tool_calls):
            streamed_content, streamed_raw, streamed_headers, streamed_status_code = _retry_chat_via_stream(
                client_factory=httpx.Client,
                url=url,
                payload=payload,
                headers=request_headers,
                timeout_seconds=self._config.timeout_ms / 1000.0,
            )
            if streamed_content:
                content = streamed_content
                raw = streamed_raw
                headers = streamed_headers
                status_code = streamed_status_code or status_code
        return OpenAICompatibleChatResult(
            content=content,
            tool_calls=tool_calls,
            raw_response=raw,
            headers=headers,
            status_code=status_code,
            roundtrip_ms=(perf_counter() - started) * 1000.0,
        )


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


def _extract_content_from_chat_completion(raw: str) -> str:
    content, _ = _extract_chat_message(raw)
    return content


def extract_message_content_text(message: dict[str, Any]) -> str:
    content = message.get("content", "")
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type", "")).strip().lower()
            if item_type not in {"text", "output_text"}:
                continue
            text_value = item.get("text", item.get("content", item.get("value", "")))
            if isinstance(text_value, dict):
                text = str(
                    text_value.get("value", text_value.get("text", text_value.get("content", "")))
                ).strip()
            else:
                text = str(text_value).strip()
            if text:
                chunks.append(text)
        text = "\n".join(chunks).strip()
    elif content is None:
        text = ""
    else:
        text = str(content).strip()
    if not text:
        reasoning = message.get("reasoning_content", "") or message.get("reasoning", "") or ""
        text = str(reasoning).strip()
    return text


def _extract_chat_message(raw: str) -> tuple[str, list[OpenAICompatibleToolCall]]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip(), []

    choices = payload.get("choices", [])
    if not choices:
        return "", []
    message = choices[0].get("message", {})
    tool_calls = _extract_tool_calls(message.get("tool_calls", []))
    if not isinstance(message, dict):
        return "", tool_calls
    text = extract_message_content_text(message)
    return text, tool_calls


def _extract_tool_calls(raw_tool_calls: object) -> list[OpenAICompatibleToolCall]:
    if not isinstance(raw_tool_calls, list):
        return []
    parsed: list[OpenAICompatibleToolCall] = []
    for item in raw_tool_calls:
        if not isinstance(item, dict):
            continue
        function = item.get("function", {})
        if not isinstance(function, dict):
            continue
        name = str(function.get("name", "")).strip()
        arguments_text = str(function.get("arguments", "")).strip()
        if not name:
            continue
        try:
            arguments = json.loads(arguments_text) if arguments_text else {}
        except json.JSONDecodeError:
            arguments = {}
        parsed.append(
            OpenAICompatibleToolCall(
                id=str(item.get("id", "")).strip() or name,
                name=name,
                arguments_text=arguments_text or "{}",
                arguments=arguments if isinstance(arguments, dict) else {},
            )
        )
    return parsed


def _should_retry_via_stream(
    *,
    raw: str,
    content: str,
    tool_calls: list[OpenAICompatibleToolCall],
) -> bool:
    if content.strip() or tool_calls:
        return False
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    usage = payload.get("usage", {})
    if not isinstance(usage, dict):
        return False
    completion_tokens = usage.get("completion_tokens", 0)
    try:
        completion_tokens_int = int(completion_tokens)
    except Exception:
        completion_tokens_int = 0
    if completion_tokens_int <= 0:
        return False
    choices = payload.get("choices", [])
    if not isinstance(choices, list) or not choices:
        return False
    finish_reason = str((choices[0] or {}).get("finish_reason", "")).strip().lower() if isinstance(choices[0], dict) else ""
    return finish_reason in {"stop", "length", ""}


def _retry_chat_via_stream(
    *,
    client_factory: type[httpx.Client],
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_seconds: float,
) -> tuple[str, str, dict[str, str], int]:
    stream_payload = dict(payload)
    stream_payload["stream"] = True
    text_chunks: list[str] = []
    reasoning_chunks: list[str] = []
    stream_headers: dict[str, str] = {}
    status_code = 0
    try:
        with client_factory(timeout=timeout_seconds, trust_env=False) as client:
            with client.stream("POST", url, json=stream_payload, headers=headers) as response:
                status_code = response.status_code
                response.raise_for_status()
                stream_headers = {key.lower(): value for key, value in response.headers.items()}
                for line in response.iter_lines():
                    parsed = _parse_sse_data_line(line)
                    if parsed is None:
                        continue
                    if parsed == "[DONE]":
                        break
                    try:
                        chunk = json.loads(parsed)
                    except json.JSONDecodeError:
                        continue
                    _collect_stream_text_chunks(chunk, text_chunks, reasoning_chunks)
    except httpx.HTTPError:
        return "", "", {}, status_code

    content = "".join(text_chunks).strip() or "".join(reasoning_chunks).strip()
    if not content:
        return "", "", stream_headers, status_code
    synthesized_raw = json.dumps(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": content,
                    }
                }
            ]
        },
        ensure_ascii=False,
    )
    return content, synthesized_raw, stream_headers, status_code


def _parse_sse_data_line(line: str | bytes) -> str | None:
    text = line.decode("utf-8", errors="ignore") if isinstance(line, bytes) else line
    text = text.strip()
    if not text or not text.startswith("data:"):
        return None
    return text[5:].strip()


def _collect_stream_text_chunks(
    chunk: dict[str, Any],
    text_chunks: list[str],
    reasoning_chunks: list[str],
) -> None:
    choices = chunk.get("choices", [])
    if not isinstance(choices, list):
        return
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta", {})
        if not isinstance(delta, dict):
            continue
        delta_content = delta.get("content", "")
        if isinstance(delta_content, list):
            for item in delta_content:
                if not isinstance(item, dict):
                    continue
                item_type = str(item.get("type", "")).strip().lower()
                if item_type not in {"text", "output_text"}:
                    continue
                text_value = item.get("text", item.get("content", item.get("value", "")))
                if text_value is None:
                    continue
                text = str(text_value)
                if text:
                    text_chunks.append(text)
        elif delta_content is not None:
            text = str(delta_content)
            if text:
                text_chunks.append(text)

        reasoning = delta.get("reasoning_content", delta.get("reasoning", ""))
        if reasoning is not None:
            reasoning_text = str(reasoning)
            if reasoning_text:
                reasoning_chunks.append(reasoning_text)
