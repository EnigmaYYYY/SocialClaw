from fastapi.testclient import TestClient

from social_copilot.visual_monitor.app import create_app
from social_copilot.visual_monitor.models.events import MessageEvent


def test_health_endpoint_reports_ok() -> None:
    client = TestClient(create_app())
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"


def test_monitor_start_stop_status_flow() -> None:
    client = TestClient(create_app())

    status_before = client.get("/monitor/status")
    assert status_before.status_code == 200
    assert status_before.json()["running"] is False

    started = client.post("/monitor/start")
    assert started.status_code == 200
    assert started.json()["running"] is True

    stopped = client.post("/monitor/stop")
    assert stopped.status_code == 200
    assert stopped.json()["running"] is False


def test_events_poll_returns_enqueued_message() -> None:
    app = create_app()
    event_bus = app.state.event_bus

    event_bus.publish(
        MessageEvent(
            event_id="m_1",
            timestamp="2026-02-22T16:30:00Z",
            session_id="sess1",
            session_key="微信::测试会话",
            window_id="win1",
            roi={"x": 1, "y": 1, "w": 10, "h": 10},
            frame_id="f1",
            sender="contact",
            text="hello",
            box=[0, 0, 10, 10],
            extraction_confidence=0.9,
            extraction_engine="vlm_structured_litellm",
            frame_hash="hash1",
            similarity_score=0.9,
            dedup_reason="new_line_detected",
            monitor_profile="adaptive_default",
        )
    )

    client = TestClient(app)
    response = client.get("/events/poll")
    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert payload["events"][0]["text"] == "hello"


def test_metrics_endpoint_exposes_prometheus_text() -> None:
    client = TestClient(create_app())
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert "visual_monitor_events_published_total" in response.text


def test_monitor_config_can_be_read_and_updated() -> None:
    client = TestClient(create_app())

    baseline = client.get("/monitor/config")
    assert baseline.status_code == 200
    payload = baseline.json()
    assert payload["monitor"]["vision"]["mode"] == "vlm_structured"
    assert payload["monitor"]["window_gate"]["app_name"] == "WeChat"
    assert payload["monitor"]["window_gate"]["app_aliases"] == ["WeChat", "微信", "WeChatAppEx", "Weixin"]

    updated = client.put(
        "/monitor/config",
        json={"monitor": {"ocr": {"mode": "hybrid"}}},
    )
    assert updated.status_code == 200
    payload = updated.json()
    assert payload["monitor"]["vision"]["mode"] == "vlm_structured"


def test_monitor_manual_roi_endpoint_updates_roi_and_mode() -> None:
    client = TestClient(create_app())
    response = client.post("/monitor/roi/manual", json={"x": 11, "y": 22, "w": 333, "h": 444})
    assert response.status_code == 200
    payload = response.json()
    assert payload["monitor"]["roi"] == {"x": 11, "y": 22, "w": 333, "h": 444}
    assert payload["monitor"]["roi_strategy"]["mode"] == "manual"
    assert payload["monitor"]["window_gate"]["enabled"] is True
    assert payload["monitor"]["window_gate"]["app_name"] == "WeChat"
    assert payload["monitor"]["window_gate"]["foreground_settle_seconds"] == 0.0
    assert payload["monitor"]["window_gate"]["confirmation_samples"] == 3
    assert payload["monitor"]["window_gate"]["confirmation_interval_ms"] == 120


def test_monitor_manual_roi_endpoint_rejects_invalid_dimensions() -> None:
    client = TestClient(create_app())
    response = client.post("/monitor/roi/manual", json={"x": 11, "y": 22, "w": 0, "h": 444})
    assert response.status_code == 422


def test_monitor_start_allows_cors_preflight() -> None:
    client = TestClient(create_app())
    response = client.options(
        "/monitor/start",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "*"


def test_monitor_resolve_session_title_endpoint_removed() -> None:
    client = TestClient(create_app())
    response = client.post(
        "/monitor/session/resolve-title",
        json={"title_probe_id": "probe_x", "title": "三个臭皮匠"},
    )
    assert response.status_code == 404


def test_monitor_debug_vlm_image_endpoint_available() -> None:
    client = TestClient(create_app())
    response = client.post(
        "/monitor/debug/vlm-image",
        json={"image_path": "/tmp/not_exists.png"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["reason"] in {"vlm_not_enabled", "image_not_found"}
