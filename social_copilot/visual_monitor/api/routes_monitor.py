from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from pydantic import ValidationError

from social_copilot.visual_monitor.models.roi_calibration import ManualRoiCalibrationRequest

router = APIRouter(prefix="/monitor", tags=["monitor"])

_TEST_IMAGE_PATH = Path(__file__).resolve().parents[3] / "social_copilot" / "test_assets" / "vlm_test.png"


class DebugVLMImageRequest(BaseModel):
    image_path: str = Field(min_length=1)
    older_image_path: str | None = None


class VlmTestRequest(BaseModel):
    base_url: str = Field(min_length=1)
    api_key: str = ""
    model: str = Field(min_length=1)
    max_tokens: int = Field(default=2000, ge=64)
    disable_thinking: bool = True
    timeout_ms: int = Field(default=60000, ge=5000)


@router.get("/status")
def monitor_status(request: Request) -> dict[str, object]:
    status = request.app.state.monitor_service.status()
    return {"running": status.running, "last_error": status.last_error}


@router.get("/debug")
def monitor_debug(request: Request) -> dict[str, object]:
    return request.app.state.monitor_service.runtime_debug()


@router.post("/start")
async def monitor_start(request: Request) -> dict[str, object]:
    status = await request.app.state.monitor_service.start()
    return {"running": status.running, "last_error": status.last_error}


@router.post("/stop")
async def monitor_stop(request: Request) -> dict[str, object]:
    status = await request.app.state.monitor_service.stop()
    return {"running": status.running, "last_error": status.last_error}


@router.get("/config")
def monitor_get_config(request: Request) -> dict[str, object]:
    return request.app.state.monitor_service.get_config().model_dump(mode="json")


@router.put("/config")
async def monitor_update_config(request: Request) -> dict[str, object]:
    payload = await request.json()
    try:
        updated = await request.app.state.monitor_service.update_config(payload)
    except ValidationError as exc:
        return {"error": "invalid_config", "details": exc.errors()}
    return updated.model_dump(mode="json")


@router.post("/roi/manual")
async def monitor_set_manual_roi(
    payload: ManualRoiCalibrationRequest,
    request: Request,
) -> dict[str, object]:
    updated = await request.app.state.monitor_service.calibrate_manual_roi(
        roi_patch={"x": payload.x, "y": payload.y, "w": payload.w, "h": payload.h},
        enforce_frontmost_gate=payload.enforce_frontmost_gate,
        frontmost_app_name=payload.frontmost_app_name,
    )
    return updated.model_dump(mode="json")


@router.post("/test-vlm")
async def monitor_test_vlm(payload: VlmTestRequest) -> dict[str, object]:
    """Send the fixed test image to the specified VLM and verify the response is parseable."""
    from social_copilot.visual_monitor.adapters.vision_litellm_structured import DEFAULT_WECHAT_STRUCTURED_PROMPT
    from social_copilot.visual_monitor.core.vlm_structured_parser import parse_vlm_structured_content

    if not _TEST_IMAGE_PATH.exists():
        return {
            "ok": False,
            "parse_ok": False,
            "message_count": 0,
            "roundtrip_ms": 0.0,
            "error": f"Test image not found: {_TEST_IMAGE_PATH}",
        }

    image_b64 = base64.b64encode(_TEST_IMAGE_PATH.read_bytes()).decode("ascii")
    temperature = 1.0 if payload.disable_thinking else 0.0
    extra: dict[str, object] = {"thinking": {"type": "disabled"}} if payload.disable_thinking else {}

    api_payload: dict[str, object] = {
        "model": payload.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": DEFAULT_WECHAT_STRUCTURED_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                ],
            }
        ],
        "temperature": temperature,
        "max_tokens": payload.max_tokens,
        "stream": False,
        **extra,
    }

    url = payload.base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {payload.api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    start = time.perf_counter()
    error = ""
    raw_content = ""
    parse_ok = False
    message_count = 0

    try:
        async with httpx.AsyncClient(timeout=payload.timeout_ms / 1000.0, trust_env=False) as client:
            resp = await client.post(url, json=api_payload, headers=headers)
            resp.raise_for_status()
            resp_json = resp.json()
            choices = resp_json.get("choices", [])
            if choices:
                msg = choices[0].get("message", {})
                content = msg.get("content", "") or ""
                if isinstance(content, list):
                    raw_content = "\n".join(
                        item.get("text", "")
                        for item in content
                        if isinstance(item, dict) and item.get("type") == "text"
                    ).strip()
                else:
                    raw_content = str(content).strip()
                if not raw_content:
                    raw_content = str(msg.get("reasoning_content", "") or "").strip()
    except httpx.HTTPStatusError as exc:
        error = f"HTTP {exc.response.status_code}: {exc.response.text[:300]}"
    except Exception as exc:
        error = str(exc)

    roundtrip_ms = (time.perf_counter() - start) * 1000.0

    if raw_content:
        _, parse_ok, _ = parse_vlm_structured_content(raw_content)
        if parse_ok:
            try:
                message_count = len(json.loads(raw_content).get("messages", []))
            except Exception:
                pass

    return {
        "ok": parse_ok,
        "parse_ok": parse_ok,
        "message_count": message_count,
        "roundtrip_ms": round(roundtrip_ms, 1),
        "error": error,
    }


@router.post("/debug/vlm-image")
async def monitor_debug_vlm_image(
    payload: DebugVLMImageRequest,
    request: Request,
) -> dict[str, object]:
    return await request.app.state.monitor_service.debug_vlm_image(
        image_path=payload.image_path,
        older_image_path=payload.older_image_path,
    )
