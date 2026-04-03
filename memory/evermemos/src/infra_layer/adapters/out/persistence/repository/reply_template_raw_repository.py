"""Reply template repository."""

from datetime import datetime
from typing import Any, Dict, List, Optional

from core.di.decorators import repository
from core.observation.logger import get_logger
from core.oxm.mongo.base_repository import BaseRepository
from infra_layer.adapters.out.persistence.document.memory.reply_template import (
    ReplyTemplate,
)

logger = get_logger(__name__)


def _merge_unique(base: List[str], incoming: List[str]) -> List[str]:
    merged = list(base or [])
    seen = set(merged)
    for item in incoming or []:
        if item and item not in seen:
            merged.append(item)
            seen.add(item)
    return merged


@repository("reply_template_raw_repository", primary=True)
class ReplyTemplateRawRepository(BaseRepository[ReplyTemplate]):
    """CRUD and upsert operations for reply templates."""

    def __init__(self):
        super().__init__(ReplyTemplate)

    async def upsert_template(self, data: Dict[str, Any]) -> Optional[ReplyTemplate]:
        """Upsert by owner+peer+scene+template_key and update counters."""
        try:
            owner_user_id = (data.get("owner_user_id") or "").strip()
            peer_user_id = (data.get("peer_user_id") or "").strip()
            scene = (data.get("scene") or "").strip()
            template_key = (data.get("template_key") or "").strip()

            if not owner_user_id or not peer_user_id or not scene or not template_key:
                logger.warning(
                    "Skip template upsert due to missing key fields: owner=%s peer=%s scene=%s key=%s",
                    owner_user_id,
                    peer_user_id,
                    scene,
                    template_key,
                )
                return None

            query = {
                "owner_user_id": owner_user_id,
                "peer_user_id": peer_user_id,
                "scene": scene,
                "template_key": template_key,
            }
            existing = await self.model.find_one(query)
            now = data.get("last_seen_at") or datetime.utcnow()

            if existing:
                existing.count = max(1, int(existing.count or 0) + 1)
                existing.last_seen_at = now
                existing.source_message_ids = _merge_unique(
                    existing.source_message_ids or [],
                    data.get("source_message_ids") or [],
                )
                existing.source_event_ids = _merge_unique(
                    existing.source_event_ids or [],
                    data.get("source_event_ids") or [],
                )
                existing.risk_flags = _merge_unique(
                    existing.risk_flags or [],
                    data.get("risk_flags") or [],
                )
                # Keep the latest extraction values for readability.
                for field in (
                    "incoming_text",
                    "reply_text",
                    "intent_type",
                    "emotion_in",
                    "from_user_id",
                    "to_user_id",
                    "from_user_name",
                    "to_user_name",
                    "style_tags",
                    "group_id",
                ):
                    value = data.get(field)
                    if value is not None:
                        setattr(existing, field, value)
                await existing.save()
                return existing

            payload = dict(data)
            payload.setdefault("count", 1)
            payload.setdefault("first_seen_at", now)
            payload.setdefault("last_seen_at", now)
            payload.setdefault("source_message_ids", [])
            payload.setdefault("source_event_ids", [])
            payload.setdefault("risk_flags", [])
            doc = self.model(**payload)
            await doc.insert()
            return doc
        except Exception as exc:
            logger.error("Failed to upsert reply template: %s", exc, exc_info=True)
            return None

    async def upsert_batch(self, items: List[Dict[str, Any]]) -> int:
        """Upsert a batch of templates and return success count."""
        success = 0
        for item in items or []:
            doc = await self.upsert_template(item)
            if doc is not None:
                success += 1
        return success

