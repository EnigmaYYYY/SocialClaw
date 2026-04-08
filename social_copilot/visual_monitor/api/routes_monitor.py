from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Literal

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
    stream_strategy: Literal["stream", "non_stream"] = "stream"
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
    from social_copilot.visual_monitor.adapters.vision_litellm_structured import (
        LiteLLMStructuredVisionAdapter,
        LiteLLMStructuredVisionConfig,
    )

    if not _TEST_IMAGE_PATH.exists():
        return {
            "ok": False,
            "parse_ok": False,
            "message_count": 0,
            "roundtrip_ms": 0.0,
            "error": f"Test image not found: {_TEST_IMAGE_PATH}",
        }

    adapter = LiteLLMStructuredVisionAdapter(
        LiteLLMStructuredVisionConfig(
            base_url=payload.base_url,
            model=payload.model,
            api_key=payload.api_key,
            timeout_ms=payload.timeout_ms,
            max_tokens=payload.max_tokens,
            temperature=0.0,
            disable_thinking=payload.disable_thinking,
            stream_strategy=payload.stream_strategy,
        )
    )
    image_png = await asyncio.to_thread(_TEST_IMAGE_PATH.read_bytes)
    result = await asyncio.to_thread(adapter.extract_structured, image_png)
    error = result.error or ("empty_image_response" if not result.raw_content else "")
    parse_ok = bool(result.parse_ok)
    message_count = len(result.messages) if parse_ok else 0

    return {
        "ok": parse_ok,
        "parse_ok": parse_ok,
        "message_count": message_count,
        "roundtrip_ms": round(result.roundtrip_ms, 1),
        "error": error,
        "raw_content_preview": result.raw_content[:600],
        "stream_strategy": payload.stream_strategy,
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
