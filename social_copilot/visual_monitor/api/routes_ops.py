from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

router = APIRouter(tags=["ops"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/metrics")
def metrics(request: Request) -> PlainTextResponse:
    payload = request.app.state.metrics.render().decode("utf-8")
    return PlainTextResponse(content=payload, media_type="text/plain; version=0.0.4; charset=utf-8")
