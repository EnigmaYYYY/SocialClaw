from __future__ import annotations

import json

from social_copilot.agent.openai_compatible import (
    OpenAICompatibleClient,
    OpenAICompatibleConfig,
    _extract_chat_message,
)
from social_copilot.visual_monitor.adapters.vision_litellm_structured import (
    LiteLLMStructuredVisionAdapter,
    LiteLLMStructuredVisionConfig,
)


class _RecordingVisionClient:
    def __init__(self, raw_response: str) -> None:
        self.raw_response = raw_response
        self.calls: list[dict[str, object]] = []

    def chat(self, **kwargs: object):
        self.calls.append(kwargs)
        return type(
            "FakeChatResult",
            (),
            {
                "raw_response": self.raw_response,
                "content": _extract_chat_message(self.raw_response)[0],
                "headers": {},
                "status_code": 200,
                "roundtrip_ms": 12.0,
                "tool_calls": [],
            },
        )()


def test_extract_chat_message_supports_output_text_content_blocks() -> None:
    raw = json.dumps(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": '{"schema_version":"draft-1","messages":[]}',
                            }
                        ],
                    }
                }
            ]
        }
    )

    content, tool_calls = _extract_chat_message(raw)

    assert content == '{"schema_version":"draft-1","messages":[]}'
    assert tool_calls == []


def test_vlm_adapter_keeps_temperature_zero_when_thinking_disabled() -> None:
    client = _RecordingVisionClient(
        json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": '{"schema_version":"draft-1","messages":[]}',
                        }
                    }
                ]
            }
        )
    )
    adapter = LiteLLMStructuredVisionAdapter(
        LiteLLMStructuredVisionConfig(
            base_url="http://example.com/v1",
            model="fake-vlm",
            api_key="test-key",
            disable_thinking=True,
            temperature=0.7,
            max_tokens=256,
        ),
        client=client,
    )

    result = adapter.extract_structured(b"fake-image-bytes")

    assert result.parse_ok is True
    assert len(client.calls) == 1
    assert client.calls[0]["temperature"] == 0.0
    assert client.calls[0]["extra_body"] == {"thinking": {"type": "disabled"}}
    assert client.calls[0]["prefer_stream"] is True


def test_vlm_adapter_can_disable_stream_preference_for_non_stream_strategy() -> None:
    client = _RecordingVisionClient(
        json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": '{"schema_version":"draft-1","messages":[]}',
                        }
                    }
                ]
            }
        )
    )
    adapter = LiteLLMStructuredVisionAdapter(
        LiteLLMStructuredVisionConfig(
            base_url="http://example.com/v1",
            model="fake-vlm",
            api_key="test-key",
            disable_thinking=True,
            stream_strategy="non_stream",
        ),
        client=client,
    )

    result = adapter.extract_structured(b"fake-image-bytes")

    assert result.parse_ok is True
    assert client.calls[0]["prefer_stream"] is False
    assert client.calls[0]["allow_stream_fallback"] is False


def test_openai_compatible_client_falls_back_to_stream_when_non_stream_content_is_empty(monkeypatch) -> None:
    non_stream_raw = json.dumps(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "reasoning_content": None,
                        "tool_calls": None,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "completion_tokens": 12,
                "prompt_tokens": 10,
                "total_tokens": 22,
            },
        }
    )
    stream_lines = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "data: [DONE]",
    ]

    class FakeResponse:
        def __init__(self, text: str = "", status_code: int = 200, headers: dict[str, str] | None = None) -> None:
            self.text = text
            self.status_code = status_code
            self.headers = headers or {}

        def raise_for_status(self) -> None:
            return None

    class FakeStreamResponse(FakeResponse):
        def __init__(self, lines: list[str]) -> None:
            super().__init__(text="\n".join(lines), status_code=200, headers={})
            self._lines = lines

        def iter_lines(self):
            for line in self._lines:
                yield line

    class FakeStreamContext:
        def __init__(self, response: FakeStreamResponse) -> None:
            self._response = response

        def __enter__(self):
            return self._response

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    class FakeHttpxClient:
        last_instance: "FakeHttpxClient | None" = None
        all_post_calls: list[dict[str, object]] = []
        all_stream_calls: list[dict[str, object]] = []

        def __init__(self, *args, **kwargs) -> None:
            self.post_calls: list[dict[str, object]] = []
            self.stream_calls: list[dict[str, object]] = []
            FakeHttpxClient.last_instance = self

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, json: dict[str, object], headers: dict[str, str]):
            call = {"url": url, "json": json, "headers": headers}
            self.post_calls.append(call)
            FakeHttpxClient.all_post_calls.append(call)
            return FakeResponse(text=non_stream_raw, status_code=200, headers={"x-test": "non-stream"})

        def stream(self, method: str, url: str, json: dict[str, object], headers: dict[str, str]):
            call = {"method": method, "url": url, "json": json, "headers": headers}
            self.stream_calls.append(call)
            FakeHttpxClient.all_stream_calls.append(call)
            return FakeStreamContext(FakeStreamResponse(stream_lines))

    monkeypatch.setattr("social_copilot.agent.openai_compatible.httpx.Client", FakeHttpxClient)

    client = OpenAICompatibleClient(
        OpenAICompatibleConfig(
            base_url="http://example.com/v1",
            model="gpt-5.2-codex",
            api_key="test-key",
            timeout_ms=1000,
            temperature=0,
            max_tokens=128,
        )
    )

    result = client.chat(messages=[{"role": "user", "content": "hello"}])

    assert result.content == "Hello world"
    assert FakeHttpxClient.last_instance is not None
    assert len(FakeHttpxClient.all_post_calls) == 1
    assert len(FakeHttpxClient.all_stream_calls) == 1
    assert FakeHttpxClient.all_stream_calls[0]["json"]["stream"] is True


def test_openai_compatible_client_can_prefer_stream_without_non_stream_probe(monkeypatch) -> None:
    stream_lines = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Vision"}}]}',
        'data: {"choices":[{"delta":{"content":" output"}}]}',
        "data: [DONE]",
    ]

    class FakeResponse:
        def __init__(self, text: str = "", status_code: int = 200, headers: dict[str, str] | None = None) -> None:
            self.text = text
            self.status_code = status_code
            self.headers = headers or {}

        def raise_for_status(self) -> None:
            return None

    class FakeStreamResponse(FakeResponse):
        def __init__(self, lines: list[str]) -> None:
            super().__init__(text="\n".join(lines), status_code=200, headers={})
            self._lines = lines

        def iter_lines(self):
            for line in self._lines:
                yield line

    class FakeStreamContext:
        def __init__(self, response: FakeStreamResponse) -> None:
            self._response = response

        def __enter__(self):
            return self._response

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    class FakeHttpxClient:
        all_post_calls: list[dict[str, object]] = []
        all_stream_calls: list[dict[str, object]] = []

        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, json: dict[str, object], headers: dict[str, str]):
            FakeHttpxClient.all_post_calls.append({"url": url, "json": json, "headers": headers})
            return FakeResponse(text='{"unexpected":true}', status_code=200, headers={})

        def stream(self, method: str, url: str, json: dict[str, object], headers: dict[str, str]):
            FakeHttpxClient.all_stream_calls.append(
                {"method": method, "url": url, "json": json, "headers": headers}
            )
            return FakeStreamContext(FakeStreamResponse(stream_lines))

    monkeypatch.setattr("social_copilot.agent.openai_compatible.httpx.Client", FakeHttpxClient)

    client = OpenAICompatibleClient(
        OpenAICompatibleConfig(
            base_url="http://example.com/v1",
            model="fake-vlm",
            api_key="test-key",
            timeout_ms=1000,
            temperature=0,
            max_tokens=128,
        )
    )

    result = client.chat(messages=[{"role": "user", "content": "hello"}], prefer_stream=True)

    assert result.content == "Vision output"
    assert FakeHttpxClient.all_post_calls == []
    assert len(FakeHttpxClient.all_stream_calls) == 1
    assert FakeHttpxClient.all_stream_calls[0]["json"]["stream"] is True


def test_openai_compatible_client_can_disable_stream_fallback_for_non_stream_mode(monkeypatch) -> None:
    non_stream_raw = json.dumps(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "reasoning_content": None,
                        "tool_calls": None,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "completion_tokens": 12,
                "prompt_tokens": 10,
                "total_tokens": 22,
            },
        }
    )

    class FakeResponse:
        def __init__(self, text: str = "", status_code: int = 200, headers: dict[str, str] | None = None) -> None:
            self.text = text
            self.status_code = status_code
            self.headers = headers or {}

        def raise_for_status(self) -> None:
            return None

    class FakeHttpxClient:
        all_post_calls: list[dict[str, object]] = []
        all_stream_calls: list[dict[str, object]] = []

        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, json: dict[str, object], headers: dict[str, str]):
            FakeHttpxClient.all_post_calls.append({"url": url, "json": json, "headers": headers})
            return FakeResponse(text=non_stream_raw, status_code=200, headers={"x-test": "non-stream"})

        def stream(self, method: str, url: str, json: dict[str, object], headers: dict[str, str]):
            FakeHttpxClient.all_stream_calls.append(
                {"method": method, "url": url, "json": json, "headers": headers}
            )
            raise AssertionError("stream should not be used when fallback is disabled")

    monkeypatch.setattr("social_copilot.agent.openai_compatible.httpx.Client", FakeHttpxClient)

    client = OpenAICompatibleClient(
        OpenAICompatibleConfig(
            base_url="http://example.com/v1",
            model="fake-vlm",
            api_key="test-key",
            timeout_ms=1000,
            temperature=0,
            max_tokens=128,
        )
    )

    result = client.chat(
        messages=[{"role": "user", "content": "hello"}],
        allow_stream_fallback=False,
    )

    assert result.content == ""
    assert len(FakeHttpxClient.all_post_calls) == 1
    assert FakeHttpxClient.all_stream_calls == []


def test_openai_compatible_client_chat_completion_uses_stream_strategy_from_config(monkeypatch) -> None:
    stream_lines = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}',
        "data: [DONE]",
    ]

    class FakeResponse:
        def __init__(self, text: str = "", status_code: int = 200, headers: dict[str, str] | None = None) -> None:
            self.text = text
            self.status_code = status_code
            self.headers = headers or {}

        def raise_for_status(self) -> None:
            return None

    class FakeStreamResponse(FakeResponse):
        def __init__(self, lines: list[str]) -> None:
            super().__init__(text="\n".join(lines), status_code=200, headers={})
            self._lines = lines

        def iter_lines(self):
            for line in self._lines:
                yield line

    class FakeStreamContext:
        def __init__(self, response: FakeStreamResponse) -> None:
            self._response = response

        def __enter__(self):
            return self._response

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    class FakeHttpxClient:
        all_post_calls: list[dict[str, object]] = []
        all_stream_calls: list[dict[str, object]] = []

        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, json: dict[str, object], headers: dict[str, str]):
            FakeHttpxClient.all_post_calls.append({"url": url, "json": json, "headers": headers})
            return FakeResponse(text='{"choices":[{"message":{"content":"ok"}}]}', status_code=200, headers={})

        def stream(self, method: str, url: str, json: dict[str, object], headers: dict[str, str]):
            FakeHttpxClient.all_stream_calls.append(
                {"method": method, "url": url, "json": json, "headers": headers}
            )
            return FakeStreamContext(FakeStreamResponse(stream_lines))

    monkeypatch.setattr("social_copilot.agent.openai_compatible.httpx.Client", FakeHttpxClient)

    client = OpenAICompatibleClient(
        OpenAICompatibleConfig(
            base_url="http://example.com/v1",
            model="gpt-5.1",
            api_key="test-key",
            timeout_ms=1000,
            stream_strategy="stream",
        )
    )

    result = client.chat_completion(system_prompt="be concise", user_prompt="say ok")

    assert result == "ok"
    assert FakeHttpxClient.all_post_calls == []
    assert len(FakeHttpxClient.all_stream_calls) == 1
