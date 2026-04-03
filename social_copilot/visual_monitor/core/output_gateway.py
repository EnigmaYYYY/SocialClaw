from __future__ import annotations

from typing import Protocol

from social_copilot.visual_monitor.models.events import MessageEvent


class PublishBus(Protocol):
    def publish(self, event: MessageEvent) -> None:
        ...


class OutputGateway:
    """Single place to push parsed message events to downstream outputs."""

    def __init__(self, event_bus: PublishBus) -> None:
        self._event_bus = event_bus

    def push(self, events: list[MessageEvent]) -> None:
        for event in events:
            self._event_bus.publish(event)
