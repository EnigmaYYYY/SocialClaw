from __future__ import annotations

from fastapi.testclient import TestClient

from social_copilot.visual_monitor.app import create_app


def test_monitor_test_vlm_returns_empty_image_response_when_model_returns_empty(monkeypatch) -> None:
    captured_strategy: dict[str, object] = {}

    class FakeAdapter:
        def __init__(self, config, *args, **kwargs) -> None:
            captured_strategy["stream_strategy"] = config.stream_strategy

        def extract_structured(self, image_png: bytes):
            return type(
                "FakeVisionResult",
                (),
                {
                    "error": None,
                    "raw_content": "",
                    "parse_ok": False,
                    "messages": [],
                    "roundtrip_ms": 123.4,
                },
            )()

    monkeypatch.setattr(
        "social_copilot.visual_monitor.adapters.vision_litellm_structured.LiteLLMStructuredVisionAdapter",
        FakeAdapter,
    )

    client = TestClient(create_app())
    response = client.post(
        "/monitor/test-vlm",
        json={
            "base_url": "http://example.com/v1",
            "api_key": "test-key",
            "model": "fake-vlm",
            "max_tokens": 256,
            "disable_thinking": True,
            "stream_strategy": "non_stream",
            "timeout_ms": 60000,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error"] == "empty_image_response"
    assert payload["raw_content_preview"] == ""
    assert payload["stream_strategy"] == "non_stream"
    assert captured_strategy["stream_strategy"] == "non_stream"
