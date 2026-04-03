from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from social_copilot.visual_monitor.api.routes_assistant import router as assistant_router
from social_copilot.visual_monitor.api.routes_events import router as events_router
from social_copilot.visual_monitor.api.routes_monitor import router as monitor_router
from social_copilot.visual_monitor.api.routes_ops import router as ops_router
from social_copilot.visual_monitor.observability.logging import configure_logging
from social_copilot.visual_monitor.service import VisualMonitorService


def create_app() -> FastAPI:
    configure_logging()
    monitor_service = VisualMonitorService()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            yield
        finally:
            await monitor_service.close()

    app = FastAPI(title="Social Copilot Visual Monitor", version="0.1.0", lifespan=lifespan)
    # Electron renderer requests the local backend from a different origin
    # (e.g. http://localhost:5173 in dev or file:// in production), so CORS
    # must be explicitly enabled for monitor/event/suggestion APIs.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.monitor_service = monitor_service
    app.state.event_bus = monitor_service.event_bus
    app.state.metrics = monitor_service.metrics

    app.include_router(ops_router)
    app.include_router(monitor_router)
    app.include_router(events_router)
    app.include_router(assistant_router)
    return app


app = create_app()
