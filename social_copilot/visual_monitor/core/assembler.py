from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timezone

from social_copilot.visual_monitor.models.events import FrameEvent, MessageEvent, ParsedMessage


class StreamAssembler:
    def __init__(self) -> None:
        self._counter = 0
        self._session_window_size = 120
        self._session_recent_signatures: dict[str, deque[tuple[str, str, str, str, str, str]]] = defaultdict(deque)
        self._session_signature_sets: dict[str, set[tuple[str, str, str, str, str, str]]] = defaultdict(set)

    def assemble(
        self,
        parsed_messages: list[ParsedMessage],
        frame: FrameEvent,
        similarity_score: float,
        dedup_reason: str,
        extraction_engine: str,
    ) -> list[MessageEvent]:
        events: list[MessageEvent] = []
        session_key = str(frame.metadata.get("session_key", "")).strip() or frame.session_id
        public_frame_id = str(frame.metadata.get("frame_public_id", "")).strip() or frame.frame_id
        signature_queue = self._session_recent_signatures[session_key]
        signature_set = self._session_signature_sets[session_key]
        for parsed in parsed_messages:
            signature = (
                parsed.sender,
                parsed.contact_name or "",
                self._normalize_text(parsed.text),
                (parsed.content_type or "").strip().lower(),
                (parsed.non_text_signature or "").strip().lower() or self._normalize_text(parsed.non_text_description or ""),
                (parsed.time_anchor or "").strip(),
            )
            if signature in signature_set:
                continue
            signature_queue.append(signature)
            signature_set.add(signature)
            while len(signature_queue) > self._session_window_size:
                dropped = signature_queue.popleft()
                signature_set.discard(dropped)
            self._counter += 1

            roi = frame.metadata.get("roi", {"x": 0, "y": 0, "w": 0, "h": 0})
            events.append(
                MessageEvent(
                    event_id=f"m_{public_frame_id}_{self._counter:06d}",
                    timestamp=frame.ts_capture if frame.ts_capture else datetime.now(tz=timezone.utc),
                    session_id=frame.session_id,
                    session_key=session_key,
                    window_id=frame.window_id,
                    roi=roi,
                    frame_id=public_frame_id,
                    sender=parsed.sender,
                    text=parsed.text,
                    contact_name=parsed.contact_name,
                    conversation_title=str(frame.metadata.get("conversation_title", "")).strip() or None,
                    content_type=parsed.content_type,
                    non_text_description=parsed.non_text_description,
                    non_text_signature=parsed.non_text_signature,
                    quoted_message=parsed.quoted_message,
                    time_anchor=parsed.time_anchor,
                    box=parsed.box,
                    extraction_confidence=parsed.confidence,
                    extraction_engine=extraction_engine,
                    frame_hash=frame.frame_hash,
                    similarity_score=similarity_score,
                    dedup_reason=dedup_reason,
                    monitor_profile="adaptive_default",
                )
            )
        return events

    @staticmethod
    def _normalize_text(value: str) -> str:
        return " ".join(value.split()).strip().lower()
