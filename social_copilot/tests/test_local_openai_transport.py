from __future__ import annotations

import json

import httpx

from social_copilot.agent import openai_compatible as openai_compatible_module
from social_copilot.agent.openai_compatible import OpenAICompatibleClient, OpenAICompatibleConfig
from social_copilot.visual_monitor.adapters import vision_litellm_structured as vision_module
from social_copilot.visual_monitor.adapters.vision_litellm_structured import (
    LiteLLMStructuredVisionAdapter,
    LiteLLMStructuredVisionConfig,
)


class _FakeResponse:
    def __init__(self, text: str, status_code: int = 200) -> None:
        self.text = text
        self.status_code = status_code
        self.headers = {"content-type": "application/json"}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("POST", "http://localhost/test")
            response = httpx.Response(self.status_code, request=request, text=self.text)
            raise httpx.HTTPStatusError("boom", request=request, response=response)


def test_openai_compatible_client_disables_environment_proxy(monkeypatch) -> None:
    seen: dict[str, object] = {}

    class _FakeClient:
        def __init__(self, *, timeout: float, trust_env: bool) -> None:
            seen["timeout"] = timeout
            seen["trust_env"] = trust_env

        def __enter__(self) -> _FakeClient:
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, json: dict[str, object], headers: dict[str, str]) -> _FakeResponse:
            seen["url"] = url
            seen["payload"] = json
            seen["headers"] = headers
            return _FakeResponse(
                '{"choices":[{"message":{"content":"ok"}}]}',
                status_code=200,
            )

    monkeypatch.setattr(openai_compatible_module.httpx, "Client", _FakeClient)

    client = OpenAICompatibleClient(
        OpenAICompatibleConfig(
            base_url="http://localhost:8317/v1",
            model="gpt-5.2",
            api_key="test-key",
        )
    )
    result = client.chat_completion("system", "user")

    assert result == "ok"
    assert seen["trust_env"] is False
    assert seen["url"] == "http://localhost:8317/v1/chat/completions"


def test_structured_vision_adapter_disables_environment_proxy(monkeypatch) -> None:
    seen: dict[str, object] = {}

    class _FakeClient:
        def __init__(self, *, timeout: float, trust_env: bool) -> None:
            seen["timeout"] = timeout
            seen["trust_env"] = trust_env

        def __enter__(self) -> _FakeClient:
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, json: dict[str, object], headers: dict[str, str]) -> _FakeResponse:
            seen["url"] = url
            seen["payload"] = json
            seen["headers"] = headers
            payload = {
                "choices": [
                    {
                        "message": {
                            "content": json_module.dumps(
                                {
                                    "schema_version": "draft-1",
                                    "app_name": "WeChat",
                                    "capture_time": None,
                                    "conversation": {
                                        "display_title": "测试会话",
                                        "title_confidence": 0.99,
                                        "title_source": "main_header",
                                    },
                                    "window_time_context": {
                                        "visible_time_markers": [],
                                        "selected_session_time_hint": None,
                                    },
                                    "messages": [],
                                    "extraction_meta": {"mode": "snapshot"},
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            }
            return _FakeResponse(json_module.dumps(payload, ensure_ascii=False), status_code=200)

    json_module = json
    monkeypatch.setattr(vision_module.httpx, "Client", _FakeClient)

    adapter = LiteLLMStructuredVisionAdapter(
        LiteLLMStructuredVisionConfig(
            base_url="http://localhost:8317/v1",
            model="gpt-5.2",
            api_key="test-key",
        )
    )
    result = adapter.extract_structured(b"fake-png-bytes")

    assert result.parse_ok is True
    assert result.conversation_title == "测试会话"
    assert seen["trust_env"] is False
    assert seen["url"] == "http://localhost:8317/v1/chat/completions"
