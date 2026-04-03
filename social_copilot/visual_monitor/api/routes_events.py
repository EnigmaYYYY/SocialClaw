from __future__ import annotations

import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/events", tags=["events"])


@router.get("/poll")
def events_poll(request: Request, limit: int = 50) -> dict[str, object]:
    events = request.app.state.event_bus.poll(limit=limit)
    return {"count": len(events), "events": [event.model_dump(mode="json") for event in events]}


@router.get("/stream")
async def events_stream(request: Request) -> StreamingResponse:
    async def generator():
        async for event in request.app.state.event_bus.subscribe():
            payload = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)
            yield f"data: {payload}\n\n"

    return StreamingResponse(generator(), media_type="text/event-stream")
