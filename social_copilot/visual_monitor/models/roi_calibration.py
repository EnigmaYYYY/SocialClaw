from __future__ import annotations

from pydantic import BaseModel, Field


class ManualRoiCalibrationRequest(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(gt=0)
    h: int = Field(gt=0)
    enforce_frontmost_gate: bool = True
    frontmost_app_name: str = "WeChat"
