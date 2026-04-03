from __future__ import annotations

import json
import os
from dataclasses import dataclass

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


class OpenAICompatibleClient:
    def __init__(self, config: OpenAICompatibleConfig) -> None:
        self._config = config

    def chat_completion(self, system_prompt: str, user_prompt: str) -> str:
        api_key = self._config.api_key.strip() or os.getenv(self._config.api_key_env, "").strip()
        if not api_key:
            raise RuntimeError(f"missing_api_key_env:{self._config.api_key_env}")

        payload = {
            "model": self._config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": self._config.temperature,
            "max_tokens": self._config.max_tokens,
            "stream": False,
        }
        url = f"{self._config.base_url.rstrip('/')}/chat/completions"
        try:
            with httpx.Client(timeout=self._config.timeout_ms / 1000.0, trust_env=False) as client:
                response = client.post(
                    url,
                    json=payload,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                        "User-Agent": "social-copilot/1.0",
                    },
                )
                raw = response.text
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = _compact_error_body(exc.response.text)
            raise RuntimeError(
                f"openai_compatible_request_failed:HTTP {exc.response.status_code}:{detail}"
            ) from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"openai_compatible_request_failed:{exc}") from exc

        return _extract_content_from_chat_completion(raw)


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
