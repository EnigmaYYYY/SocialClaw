from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from pydantic import ValidationError

from social_copilot.visual_monitor.models.roi_calibration import ManualRoiCalibrationRequest

router = APIRouter(prefix="/monitor", tags=["monitor"])


class DebugVLMImageRequest(BaseModel):
    image_path: str = Field(min_length=1)
    older_image_path: str | None = None


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


@router.post("/debug/vlm-image")
async def monitor_debug_vlm_image(
    payload: DebugVLMImageRequest,
    request: Request,
) -> dict[str, object]:
    return await request.app.state.monitor_service.debug_vlm_image(
        image_path=payload.image_path,
        older_image_path=payload.older_image_path,
    )
