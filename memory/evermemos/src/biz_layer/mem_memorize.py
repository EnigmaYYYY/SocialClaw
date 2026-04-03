from dataclasses import dataclass
import random
import time
import json
import traceback
import hashlib
import re
import math
import copy
from api_specs.dtos.memory_command import MemorizeRequest
from memory_layer.memory_manager import MemoryManager
from api_specs.memory_types import (
    MemoryType,
    MemCell,
    BaseMemory,
    EpisodeMemory,
    RawDataType,
    Foresight,
)
from api_specs.memory_types import EventLog
from memory_layer.memory_extractor.profile_memory_extractor import ProfileMemory
from common_utils.logging_utils import summarize_json
from core.di import get_bean_by_type
from core.lock.redis_distributed_lock import distributed_lock
from infra_layer.adapters.out.persistence.repository.episodic_memory_raw_repository import (
    EpisodicMemoryRawRepository,
)
from infra_layer.adapters.out.persistence.repository.foresight_record_repository import (
    ForesightRecordRawRepository,
)
from infra_layer.adapters.out.persistence.repository.event_log_record_raw_repository import (
    EventLogRecordRawRepository,
)
from infra_layer.adapters.out.persistence.repository.conversation_status_raw_repository import (
    ConversationStatusRawRepository,
)
from infra_layer.adapters.out.persistence.repository.conversation_meta_raw_repository import (
    ConversationMetaRawRepository,
)
from infra_layer.adapters.out.persistence.repository.memcell_raw_repository import (
    MemCellRawRepository,
)
from infra_layer.adapters.out.persistence.repository.core_memory_raw_repository import (
    CoreMemoryRawRepository,
)
from infra_layer.adapters.out.persistence.repository.group_profile_raw_repository import (
    GroupProfileRawRepository,
)
from infra_layer.adapters.out.persistence.repository.conversation_data_raw_repository import (
    ConversationDataRepository,
)
from infra_layer.adapters.out.persistence.repository.reply_template_raw_repository import (
    ReplyTemplateRawRepository,
)
from api_specs.memory_types import RawDataType
from typing import List, Dict, Optional, Any
from dataclasses import dataclass
import uuid
from datetime import datetime, timedelta, timezone
import os
import asyncio
from collections import defaultdict, Counter
from common_utils.datetime_utils import (
    get_now_with_timezone,
    to_iso_format,
)
from memory_layer.memcell_extractor.base_memcell_extractor import StatusResult
import traceback

from core.observation.logger import get_logger
from infra_layer.adapters.out.search.elasticsearch.converter.episodic_memory_converter import (
    EpisodicMemoryConverter,
)
from infra_layer.adapters.out.search.milvus.converter.episodic_memory_milvus_converter import (
    EpisodicMemoryMilvusConverter,
)
from infra_layer.adapters.out.search.repository.episodic_memory_milvus_repository import (
    EpisodicMemoryMilvusRepository,
)
from infra_layer.adapters.out.search.repository.episodic_memory_es_repository import (
    EpisodicMemoryEsRepository,
)
from biz_layer.mem_sync import MemorySyncService
from core.context.context import get_current_app_info
from memory_layer.template.reply_template_extractor import (
    extract_reply_templates_from_messages,
)

logger = get_logger(__name__)

try:
    import jieba  # type: ignore
except Exception:  # pragma: no cover - optional dependency fallback
    jieba = None


@dataclass
class MemoryDocPayload:
    memory_type: MemoryType
    doc: Any


def _clone_event_log(raw_event_log: Any) -> Optional[EventLog]:
    """Convert any structured event log into an EventLog instance"""
    if raw_event_log is None:
        return None

    if isinstance(raw_event_log, EventLog):
        return EventLog(
            time=getattr(raw_event_log, "time", ""),
            atomic_fact=list(getattr(raw_event_log, "atomic_fact", []) or []),
            fact_embeddings=getattr(raw_event_log, "fact_embeddings", None),
        )

    if isinstance(raw_event_log, dict):
        return EventLog.from_dict(raw_event_log)

    return None


from biz_layer.memorize_config import MemorizeConfig, DEFAULT_MEMORIZE_CONFIG


async def _trigger_clustering(
    group_id: str,
    memcell: MemCell,
    scene: Optional[str] = None,
    config: MemorizeConfig = DEFAULT_MEMORIZE_CONFIG,
    force_profile_extraction: bool = False,
    owner_user_id: Optional[str] = None,
) -> None:
    """Trigger MemCell clustering

    Args:
        group_id: Group ID
        memcell: The MemCell just saved
        scene: Conversation scene (used to determine Profile extraction strategy)
            - None/"private": use private scenario
            - "group": use group scenario
            - Legacy values ("assistant"/"companion") are normalized
        owner_user_id: Owner user ID for self-profile routing
    """
    logger.info(
        f"[Clustering] Start triggering clustering: group_id={group_id}, event_id={memcell.event_id}, scene={scene}"
    )

    try:
        from memory_layer.cluster_manager import (
            ClusterManager,
            ClusterManagerConfig,
            ClusterState,
        )
        from memory_layer.profile_manager import ProfileManager, ProfileManagerConfig
        from infra_layer.adapters.out.persistence.repository.cluster_state_raw_repository import (
            ClusterStateRawRepository,
        )
        from memory_layer.llm.llm_provider import LLMProvider
        from core.di import get_bean_by_type
        import os

        logger.info(f"[Clustering] Retrieving ClusterStateRawRepository...")
        # Get MongoDB storage
        cluster_storage = get_bean_by_type(ClusterStateRawRepository)
        logger.info(
            f"[Clustering] ClusterStateRawRepository retrieved successfully: {type(cluster_storage)}"
        )

        # Create ClusterManager (pure computation component)
        cluster_config = ClusterManagerConfig(
            similarity_threshold=config.cluster_similarity_threshold,
            max_time_gap_days=config.cluster_max_time_gap_days,
        )
        cluster_manager = ClusterManager(config=cluster_config)
        logger.info(f"[Clustering] ClusterManager created successfully")

        # Load clustering state
        state_dict = await cluster_storage.load_cluster_state(group_id)
        cluster_state = (
            ClusterState.from_dict(state_dict) if state_dict else ClusterState()
        )
        logger.info(
            f"[Clustering] Loaded clustering state: {len(cluster_state.event_ids)} clustered events"
        )

        # Convert MemCell to dictionary format required for clustering
        memcell_dict = {
            "event_id": str(memcell.event_id),
            "episode": memcell.episode,
            "timestamp": memcell.timestamp.timestamp() if memcell.timestamp else None,
            "participants": memcell.participants or [],
            "group_id": group_id,
        }

        logger.info(
            f"[Clustering] Start clustering execution: {memcell_dict['event_id']}"
        )
        print(
            f"[Clustering] Start clustering execution: event_id={memcell_dict['event_id']}"
        )

        # Perform clustering (pure computation)
        cluster_id, cluster_state = await cluster_manager.cluster_memcell(
            memcell_dict, cluster_state
        )

        # Save clustering state
        await cluster_storage.save_cluster_state(group_id, cluster_state.to_dict())
        logger.info(f"[Clustering] Clustering state saved")

        print(f"[Clustering] Clustering completed: cluster_id={cluster_id}")

        if cluster_id:
            logger.info(
                f"[Clustering] 鉁?MemCell {memcell.event_id} -> Cluster {cluster_id} (group: {group_id})"
            )
            print(f"[Clustering] 鉁?MemCell {memcell.event_id} -> Cluster {cluster_id}")
        else:
            logger.warning(
                f"[Clustering] 鈿狅笍 MemCell {memcell.event_id} clustering returned None (group: {group_id})"
            )
            print(f"[Clustering] 鈿狅笍 Clustering returned None")

        # Profile extraction
        if cluster_id:
            await _trigger_profile_extraction(
                group_id=group_id,
                cluster_id=cluster_id,
                cluster_state=cluster_state,
                memcell=memcell,
                scene=scene,
                config=config,
                force_profile_extraction=force_profile_extraction,
                owner_user_id=owner_user_id,
            )

    except Exception as e:
        # Clustering failed, print detailed error and re-raise
        import traceback

        error_msg = f"[Clustering] 鉂?Triggering clustering failed: {e}"
        logger.error(error_msg, exc_info=True)
        print(error_msg)  # Ensure visible in console
        print(traceback.format_exc())
        raise  # Re-raise exception so caller knows it failed


_LEXICAL_SINGLE_CHAR_WHITELIST = {"欸", "诶", "嗯", "哈", "哎", "呀", "呃"}
_LEXICAL_STOP_PHRASES = {
    "好的",
    "收到",
    "可以",
    "好的好的",
    "哈哈",
    "哈哈哈",
    "嗯嗯",
    "行行",
    "知道了",
    "明白了",
    "谢谢",
    "谢谢你",
}
_LEXICAL_STYLE_WHITELIST = {
    "班长",
    "老师",
    "好嘞",
    "好啦",
    "好滴",
    "先这样",
    "辛苦了",
    "麻烦啦",
    "这就",
    "马上",
    "懂了",
    "收到啦",
}
_LEXICAL_PRONOUN_PREFIXES = (
    "我",
    "你",
    "他",
    "她",
    "它",
    "我们",
    "你们",
    "他们",
    "她们",
    "咱",
    "咱们",
)
_LEXICAL_PARTICLE_ENDINGS = tuple("吗呢嘛吧啊呀哇哦呗")


def _is_style_like_phrase(phrase: str) -> bool:
    """Heuristic gate for catchphrase-like expressions."""
    if not phrase:
        return False
    phrase = phrase.strip()
    if not phrase:
        return False
    if phrase in _LEXICAL_SINGLE_CHAR_WHITELIST:
        return True
    if phrase in _LEXICAL_STYLE_WHITELIST:
        return True
    if re.fullmatch(r"[哈呵嘿啊呀嗯哦欸诶]+", phrase):
        return True
    # Short sentence-final modal/particle patterns
    if len(phrase) <= 4 and re.search(r"(吧|呀|哈|啦|呢|哦|呗|诶|欸|噢)$", phrase):
        return True
    # Emoticon-like tone marks
    if re.search(r"[!?！？~～…]+$", phrase):
        return True
    return False


def _to_profile_dict(profile: Any) -> Dict[str, Any]:
    if isinstance(profile, dict):
        return copy.deepcopy(profile)
    if hasattr(profile, "to_dict"):
        return profile.to_dict()
    return {}


def _strip_lexical_stats_for_llm(profile: Any) -> Dict[str, Any]:
    """Remove heavy/metadata fields before passing old profiles to LLM.

    Keeps only meaningful profile fields, removes:
    - version, created_at, updated_at (metadata)
    - memcell_count, last_updated_cluster (internal tracking)
    - vector, vector_model (embedding data)
    - extend.lexical_stats (heavy stats)
    """
    profile_dict = _to_profile_dict(profile)

    # Remove metadata fields that LLM doesn't need
    metadata_fields = [
        "version", "created_at", "updated_at",
        "memcell_count", "last_updated_cluster",
        "vector", "vector_model", "event_id", "conversation_id"
    ]
    for field in metadata_fields:
        profile_dict.pop(field, None)

    # Clean extend
    extend = profile_dict.get("extend")
    if isinstance(extend, dict):
        extend.pop("lexical_stats", None)
        if not extend:
            profile_dict.pop("extend", None)

    return profile_dict


def _get_existing_lexical_stats(profile: Any) -> Dict[str, Any]:
    profile_dict = _to_profile_dict(profile)
    extend = profile_dict.get("extend")
    if isinstance(extend, dict) and isinstance(extend.get("lexical_stats"), dict):
        return copy.deepcopy(extend["lexical_stats"])
    return {"phrases": {}, "updated_at": None}


def _extract_speaker_id(msg: Dict[str, Any]) -> str:
    for key in ("speaker_id", "createBy", "sender", "sender_id"):
        value = msg.get(key)
        if value:
            return str(value)
    return ""


def _extract_message_text(msg: Dict[str, Any]) -> str:
    text = msg.get("content") or msg.get("text") or msg.get("message") or ""
    if not isinstance(text, str):
        text = str(text)
    text = text.strip()
    if not text:
        return ""
    if re.match(r"^\[[^\]]{1,24}\]$", text):  # [Image]/[Video]/emoji placeholders
        return ""
    return text


def _extract_message_datetime(msg: Dict[str, Any], default_dt: datetime) -> datetime:
    ts = (
        msg.get("timestamp")
        or msg.get("createTime")
        or msg.get("create_time")
        or msg.get("updateTime")
        or msg.get("update_time")
    )
    if ts is None:
        return default_dt

    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)

    try:
        if isinstance(ts, (int, float)):
            ts_num = float(ts)
            if ts_num > 1e12:
                ts_num = ts_num / 1000.0
            return datetime.fromtimestamp(ts_num, tz=timezone.utc)
        if isinstance(ts, str):
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        return default_dt
    return default_dt


def _extract_candidate_phrases(text: str) -> List[str]:
    if not text:
        return []

    text = re.sub(r"https?://\S+", "", text)
    text = text.strip()
    if not text:
        return []

    candidates: List[str] = []

    # Chinese phrases: token unigram/bigram (prefer word-level; fallback to char n-grams)
    for seq in re.findall(r"[\u4e00-\u9fff]+", text):
        if not seq:
            continue
        if jieba:
            tokens = [tok.strip() for tok in jieba.lcut(seq) if tok and tok.strip()]
            tokens = [tok for tok in tokens if re.search(r"[\u4e00-\u9fff]", tok)]
            for tok in tokens:
                if len(tok) == 1:
                    if tok in _LEXICAL_SINGLE_CHAR_WHITELIST:
                        candidates.append(tok)
                    continue
                if len(tok) <= 8:
                    candidates.append(tok)
            for i in range(0, max(0, len(tokens) - 1)):
                bigram = tokens[i] + tokens[i + 1]
                if 2 <= len(bigram) <= 8:
                    candidates.append(bigram)
        else:
            # fallback: keep legacy char n-gram path if jieba is unavailable
            if len(seq) == 1 and seq in _LEXICAL_SINGLE_CHAR_WHITELIST:
                candidates.append(seq)
            max_n = min(4, len(seq))
            for n in range(2, max_n + 1):
                for i in range(0, len(seq) - n + 1):
                    candidates.append(seq[i : i + n])

    # Keep short english tokens as style cues (e.g., "ok", "fine")
    for token in re.findall(r"[A-Za-z]{2,8}", text):
        candidates.append(token.lower())

    filtered: List[str] = []
    for phrase in candidates:
        phrase = phrase.strip()
        if not phrase:
            continue
        if phrase in _LEXICAL_STOP_PHRASES:
            continue
        if len(phrase) > 8:
            continue
        if len(phrase) <= 3:
            if phrase.endswith(_LEXICAL_PARTICLE_ENDINGS):
                continue
            if any(phrase.startswith(p) for p in _LEXICAL_PRONOUN_PREFIXES):
                continue
            if re.fullmatch(r"[你我他她它们吧吗呢啊呀哈哦嗯诶欸]+", phrase):
                continue
        filtered.append(phrase)
    return filtered


def _prune_stats_bucket(bucket: Dict[str, Any], now_ts: float) -> None:
    # keep recent daily counts only (60 days)
    day_counts = bucket.get("day_counts", {})
    if isinstance(day_counts, dict):
        keep_days = {}
        for day, count in day_counts.items():
            try:
                day_ts = datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp()
            except Exception:
                continue
            if now_ts - day_ts <= 60 * 86400:
                keep_days[day] = count
        bucket["day_counts"] = keep_days

    # keep at most 40 segments
    seg = bucket.get("segment_counts", {})
    if isinstance(seg, dict) and len(seg) > 40:
        sorted_seg = sorted(seg.items(), key=lambda x: x[1], reverse=True)[:40]
        bucket["segment_counts"] = dict(sorted_seg)

    # keep at most 4 examples
    examples = bucket.get("examples", [])
    if isinstance(examples, list) and len(examples) > 4:
        bucket["examples"] = examples[:4]


def _update_lexical_stats_from_messages(
    lexical_stats: Dict[str, Any],
    raw_messages: List[Any],
    user_id: str,
    segment_id: str,
    now: datetime,
) -> Dict[str, Any]:
    stats = copy.deepcopy(lexical_stats) if isinstance(lexical_stats, dict) else {}
    phrases = stats.setdefault("phrases", {})
    # remove legacy pending cache to avoid noisy accumulation
    stats.pop("pending_phrase_counts", None)

    normalized = _normalize_raw_data_list(raw_messages)
    user_payload: List[Any] = []
    phrase_totals: Counter = Counter()
    for msg in normalized:
        if _extract_speaker_id(msg) != user_id:
            continue

        text = _extract_message_text(msg)
        if not text:
            continue

        msg_dt = _extract_message_datetime(msg, now)
        day_key = msg_dt.astimezone(timezone.utc).strftime("%Y-%m-%d")

        message_phrase_counts = Counter(_extract_candidate_phrases(text))
        if not message_phrase_counts:
            continue
        phrase_totals.update(message_phrase_counts)
        user_payload.append((msg_dt, day_key, text, message_phrase_counts))

    for msg_dt, day_key, text, message_phrase_counts in user_payload:
        msg_ts = msg_dt.timestamp()
        for phrase, freq in message_phrase_counts.items():
            # cap per-message contribution to avoid long-message bias
            freq = min(freq, 2)

            if phrase not in phrases:
                # Gate new phrases: keep style-like phrases OR repeated ones in current batch.
                if int(phrase_totals.get(phrase, 0)) < 2 and not _is_style_like_phrase(
                    phrase
                ):
                    continue

            bucket = phrases.setdefault(
                phrase,
                {
                    "count": 0,
                    "tf_decay": 0.0,
                    "first_seen_ts": msg_ts,
                    "last_seen_ts": msg_ts,
                    "day_counts": {},
                    "segment_counts": {},
                    "examples": [],
                },
            )

            last_seen = float(bucket.get("last_seen_ts", msg_ts))
            delta_days = max(0.0, (msg_ts - last_seen) / 86400.0)
            decay_lambda = 0.08
            tf_decay = float(bucket.get("tf_decay", 0.0)) * math.exp(
                -decay_lambda * delta_days
            )
            tf_decay += float(freq)

            bucket["tf_decay"] = tf_decay
            bucket["count"] = int(bucket.get("count", 0)) + int(freq)
            bucket["last_seen_ts"] = msg_ts
            bucket["first_seen_ts"] = min(
                float(bucket.get("first_seen_ts", msg_ts)), msg_ts
            )

            day_counts = bucket.setdefault("day_counts", {})
            day_counts[day_key] = int(day_counts.get(day_key, 0)) + int(freq)

            segment_counts = bucket.setdefault("segment_counts", {})
            segment_counts[segment_id] = int(segment_counts.get(segment_id, 0)) + int(
                freq
            )

            examples = bucket.setdefault("examples", [])
            if text not in examples:
                examples.append(text[:80])

            _prune_stats_bucket(bucket, now.timestamp())

    # keep top 300 phrases only
    if len(phrases) > 300:
        top_items = sorted(
            phrases.items(), key=lambda kv: float(kv[1].get("tf_decay", 0.0)), reverse=True
        )[:300]
        stats["phrases"] = dict(top_items)

    stats["updated_at"] = now.isoformat()
    return stats


def _build_catchphrase_from_lexical_stats(
    lexical_stats: Dict[str, Any], now: datetime, top_k: int = 5
) -> List[Dict[str, Any]]:
    phrases = lexical_stats.get("phrases", {}) if isinstance(lexical_stats, dict) else {}
    if not isinstance(phrases, dict):
        return []

    ranked = []
    now_ts = now.timestamp()
    for phrase, bucket in phrases.items():
        if not isinstance(bucket, dict):
            continue
        if len(phrase) < 2:
            continue
        count = int(bucket.get("count", 0))
        if count < 5:
            continue
        day_counts = bucket.get("day_counts", {})
        active_days = len(day_counts) if isinstance(day_counts, dict) else 0
        if active_days < 3:
            continue

        segment_counts = bucket.get("segment_counts", {})
        diversity = len(segment_counts) if isinstance(segment_counts, dict) else 1
        if diversity < 2:
            continue
        if (not _is_style_like_phrase(phrase)) and count < 8:
            # Non-style content phrase must be very frequent before entering catchphrase list.
            continue
        last_seen = float(bucket.get("last_seen_ts", now_ts))
        delta_days = max(0.0, (now_ts - last_seen) / 86400.0)

        tf_decay = float(bucket.get("tf_decay", 0.0))
        recency = math.exp(-0.12 * delta_days)
        stability = min(1.0, active_days / 4.0)

        # Penalize one-day burst patterns
        burst_penalty = 1.0
        if isinstance(day_counts, dict) and day_counts:
            peak = max(day_counts.values())
            if count > 0 and (peak / count) > 0.8 and active_days < 3:
                burst_penalty = 0.7

        score = tf_decay * (1.0 + 0.35 * min(diversity, 6)) * recency * (0.7 + 0.3 * stability) * burst_penalty

        if score <= 0.0:
            continue

        confidence = "low"
        if score >= 18:
            confidence = "high"
        elif score >= 8:
            confidence = "medium"

        examples = bucket.get("examples", []) if isinstance(bucket.get("examples"), list) else []
        day_keys = sorted(day_counts.keys())[-3:] if isinstance(day_counts, dict) else []
        evidences = [{"event_id": f"lexical_stats:{d}", "reasoning": f"词法统计词频在 {d} 日被检测到"} for d in day_keys]

        ranked.append(
            {
                "value": phrase,
                "evidences": evidences,
                "confidence": confidence,
                "score": round(score, 4),
                "count": count,
                "active_days": active_days,
                "diversity": diversity,
                "evidence_examples": examples[:2],
            }
        )

    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked[:top_k]


def _inject_lexical_stats_into_profile(
    profile: Any,
    lexical_stats: Dict[str, Any],
    llm_catchphrase: List[Dict[str, Any]],
    lexical_catchphrase: List[Dict[str, Any]],
) -> Any:
    final_catchphrase = _select_final_catchphrase(
        llm_catchphrase=llm_catchphrase,
        lexical_catchphrase=lexical_catchphrase,
    )
    if isinstance(profile, dict):
        profile["catchphrase"] = final_catchphrase
        extend = profile.get("extend")
        if not isinstance(extend, dict):
            extend = {}
        extend["lexical_stats"] = lexical_stats
        profile["extend"] = extend
        return profile

    # dataclass/object profile
    try:
        setattr(profile, "catchphrase", final_catchphrase)
        extend_obj = getattr(profile, "extend", None)
        if not isinstance(extend_obj, dict):
            extend_obj = {}
        extend_obj["lexical_stats"] = lexical_stats
        setattr(profile, "extend", extend_obj)
    except Exception:
        pass
    return profile


def _get_profile_catchphrase(profile: Any) -> List[Dict[str, Any]]:
    """Read catchphrase extracted by LLM from profile payload/object."""
    raw = None
    if isinstance(profile, dict):
        raw = profile.get("catchphrase")
    else:
        raw = getattr(profile, "catchphrase", None)
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            value = str(item.get("value", "")).strip()
            if not value:
                continue
            out.append(item)
        elif isinstance(item, str):
            value = item.strip()
            if value:
                out.append({"value": value, "evidences": []})
    return out


def _merge_catchphrase_hybrid(
    llm_catchphrase: List[Dict[str, Any]],
    lexical_catchphrase: List[Dict[str, Any]],
    top_k: int = 5,
) -> List[Dict[str, Any]]:
    """
    Hybrid merge strategy:
    - Keep LLM catchphrases as primary signals.
    - Use lexical catchphrases only as supplements / evidence enrichment.
    """
    merged: List[Dict[str, Any]] = []
    index_by_key: Dict[str, int] = {}

    def _norm_key(value: str) -> str:
        return re.sub(r"\s+", "", value.strip().lower())

    # 1) LLM-first
    for item in llm_catchphrase or []:
        if not isinstance(item, dict):
            continue
        value = str(item.get("value", "")).strip()
        if not value:
            continue
        key = _norm_key(value)
        if key in index_by_key:
            continue
        normalized = dict(item)
        normalized.setdefault("evidences", [])
        normalized.setdefault("confidence", "llm")
        normalized.setdefault("source", "llm")
        merged.append(normalized)
        index_by_key[key] = len(merged) - 1
        if len(merged) >= top_k:
            return merged[:top_k]

    # 2) Lexical supplement
    for item in lexical_catchphrase or []:
        if not isinstance(item, dict):
            continue
        value = str(item.get("value", "")).strip()
        if not value:
            continue
        key = _norm_key(value)
        if key in index_by_key:
            # enrich evidence if same phrase exists
            idx = index_by_key[key]
            existing_evs = merged[idx].get("evidences", [])
            lexical_evs = item.get("evidences", [])
            if isinstance(existing_evs, list) and isinstance(lexical_evs, list):
                merged[idx]["evidences"] = list(dict.fromkeys(existing_evs + lexical_evs))
            continue

        normalized = dict(item)
        normalized.setdefault("evidences", [])
        normalized.setdefault("source", "lexical")
        merged.append(normalized)
        index_by_key[key] = len(merged) - 1
        if len(merged) >= top_k:
            break

    return merged[:top_k]


def _select_final_catchphrase(
    llm_catchphrase: List[Dict[str, Any]], lexical_catchphrase: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Select final catchphrase strategy.

    Modes:
    - llm_only (default): only use LLM extraction
    - llm_with_fallback: use lexical only when LLM is empty
    - hybrid: merge llm + lexical
    """
    mode = os.getenv("PROFILE_CATCHPHRASE_MODE", "llm_only").strip().lower()
    if mode == "hybrid":
        return _merge_catchphrase_hybrid(
            llm_catchphrase=llm_catchphrase,
            lexical_catchphrase=lexical_catchphrase,
        )
    if mode == "llm_with_fallback":
        return llm_catchphrase or lexical_catchphrase
    return llm_catchphrase


async def _trigger_profile_extraction(
    group_id: str,
    cluster_id: str,
    cluster_state,  # ClusterState
    memcell: MemCell,
    scene: Optional[str] = None,
    config: MemorizeConfig = DEFAULT_MEMORIZE_CONFIG,
    force_profile_extraction: bool = False,
    owner_user_id: Optional[str] = None,  # Optional override for owner_user_id
) -> None:
    """Trigger Profile extraction

    Args:
        group_id: Group ID
        cluster_id: The cluster to which the current memcell was assigned
        cluster_state: Current clustering state
        memcell: The MemCell currently being processed
        scene: Conversation scene
        config: Memory extraction configuration
    """
    try:
        from memory_layer.profile_manager import ProfileManager, ProfileManagerConfig
        from infra_layer.adapters.out.persistence.repository.unified_profile_repository import (
            UnifiedProfileRepository,
        )
        from infra_layer.adapters.out.persistence.repository.conversation_meta_raw_repository import (
            ConversationMetaRawRepository,
        )
        from copilot_orchestrator.converters import EverMemOSConverter
        from api_specs.unified_types import ProfileType
        from memory_layer.llm.llm_provider import LLMProvider
        from core.di import get_bean_by_type
        import os

        # Get the number of memcells in the current cluster
        cluster_memcell_count = cluster_state.cluster_counts.get(cluster_id)
        if cluster_memcell_count is None:
            logger.warning(
                f"[Profile] profile.memcell_skip Missing cluster count for {cluster_id}, skipping extraction"
            )
            return
        if cluster_memcell_count < config.profile_min_memcells and not force_profile_extraction:
            logger.debug(
                f"[Profile] profile.memcell_skip Cluster {cluster_id} has only {cluster_memcell_count} memcells "
                f"(requires {config.profile_min_memcells}), skipping extraction"
            )
            return
        if cluster_memcell_count < config.profile_min_memcells and force_profile_extraction:
            logger.info(
                f"[Profile] profile.memcell_force_extract cluster={cluster_id}, group_id={group_id}, "
                f"memcells={cluster_memcell_count}, required={config.profile_min_memcells}"
            )

        logger.info(
            f"[Profile] profile.extract_start cluster={cluster_id}, memcells={cluster_memcell_count}, group_id={group_id}"
        )
        print(f"🍃🍃🍃 [Profile] Starting profile extraction: cluster={cluster_id}, memcells={cluster_memcell_count}, group_id={group_id}")

        # Get unified profile storage (single source of truth)
        unified_profile_repo = get_bean_by_type(UnifiedProfileRepository)

        # Resolve owner user id (used for self-profile routing)
        conversation_meta_repo = get_bean_by_type(ConversationMetaRawRepository)
        conversation_meta = await conversation_meta_repo.get_by_conversation_id(group_id)
        # Use passed owner_user_id if available, otherwise try from conversation_meta
        if not owner_user_id:
            owner_user_id = None
            if conversation_meta and conversation_meta.scene_desc:
                owner_user_id = conversation_meta.scene_desc.get("owner_user_id")

        # Log warning if owner_user_id is still empty
        if not owner_user_id:
            logger.warning(
                f"[Profile] owner_user_id is empty for group_id={group_id}, "
                "profile extraction may create duplicate or incorrect profiles"
            )

        # Create LLM Provider
        llm_provider = LLMProvider(
            provider_type=os.getenv("LLM_PROVIDER", "openai"),
            model=os.getenv("LLM_MODEL", "gpt-4"),
            base_url=os.getenv("LLM_BASE_URL"),
            api_key=os.getenv("LLM_API_KEY"),
            temperature=float(os.getenv("LLM_TEMPERATURE", "0.3")),
            max_tokens=int(os.getenv("LLM_MAX_TOKENS", "16384")),
        )

        # Determine scenario (normalize legacy values)
        profile_scenario = _normalize_scene(scene)

        # Create ProfileManager (pure computation component)
        profile_config = ProfileManagerConfig(
            scenario=profile_scenario,
            min_confidence=config.profile_min_confidence,
            enable_versioning=config.profile_enable_versioning,
            auto_extract=True,
        )
        profile_manager = ProfileManager(
            llm_provider=llm_provider,
            config=profile_config,
            group_id=group_id,
            group_name=None,
        )

        # Get participant list (exclude robots)
        user_id_list = [
            u
            for u in (memcell.participants or [])
            if "robot" not in u.lower() and "assistant" not in u.lower()
        ]

        # Load existing profiles by user_id (incremental update per participant)
        # Load existing profiles by user_id (incremental update per participant)
        existing_profiles_by_user_id: Dict[str, Any] = {}
        old_profiles_for_llm: List[Dict[str, Any]] = []

        for uid in user_id_list:
            if owner_user_id and uid == owner_user_id:
                # Load owner's self profile
                unified_owner = await unified_profile_repo.get_user_profile(owner_user_id)
                if unified_owner:
                    profile_memory_dict = EverMemOSConverter.unified_to_profile_memory(unified_owner)
                    old_profiles_for_llm.append(_strip_lexical_stats_for_llm(profile_memory_dict))
                    existing_profiles_by_user_id[uid] = profile_memory_dict
                continue

            # Load friend profile only in normal mode (skip in regenerate mode to avoid cross-conversation contamination)
            if force_profile_extraction:
                continue

            unified_contact = await unified_profile_repo.get_by_owner_and_target(owner_user_id, uid) if owner_user_id else None
            if unified_contact:
                profile_memory_dict = EverMemOSConverter.unified_to_profile_memory(unified_contact)
                old_profiles_for_llm.append(_strip_lexical_stats_for_llm(profile_memory_dict))
                existing_profiles_by_user_id[uid] = profile_memory_dict

        # Perform Profile extraction (pass MemCell objects directly, not dictionaries)
        extract_start_time = time.monotonic()
        new_profiles = await profile_manager.extract_profiles(
            memcells=[memcell],  # Pass MemCell object
            old_profiles=old_profiles_for_llm,
            user_id_list=user_id_list,
            owner_user_id=owner_user_id,
        )
        extract_elapsed_ms = int((time.monotonic() - extract_start_time) * 1000)

        if not new_profiles:
            logger.warning(
                f"[Profile] profile.extract_empty cluster={cluster_id}, group_id={group_id}, "
                f"duration_ms={extract_elapsed_ms}"
            )
            print(f"🍃🍃🍃 [Profile] No profiles extracted: cluster={cluster_id}, group_id={group_id}")
        else:
            logger.info(
                f"[Profile] profile.extract_success cluster={cluster_id}, group_id={group_id}, "
                f"profile_count={len(new_profiles)}, duration_ms={extract_elapsed_ms}"
            )
            print(f"🍃🍃🍃 [Profile] Extracted {len(new_profiles)} profiles: cluster={cluster_id}, group_id={group_id}")

        now_dt = get_now_with_timezone()
        segment_id = str(
            memcell.event_id or cluster_id or f"{group_id}:{int(now_dt.timestamp())}"
        )
        raw_messages_for_lexical = memcell.original_data or []

        # Save newly extracted profiles
        for profile in new_profiles:
            if isinstance(profile, dict):
                user_id = profile.get("user_id")
            else:
                user_id = getattr(profile, "user_id", None)

            if user_id:
                user_id = str(user_id)
                profile_kind = "friend"

                # Incremental lexical catchphrase update from raw messages.
                existing_profile = existing_profiles_by_user_id.get(user_id)
                lexical_stats = _get_existing_lexical_stats(existing_profile)
                lexical_stats = _update_lexical_stats_from_messages(
                    lexical_stats=lexical_stats,
                    raw_messages=raw_messages_for_lexical,
                    user_id=user_id,
                    segment_id=segment_id,
                    now=now_dt,
                )
                llm_catchphrase = _get_profile_catchphrase(profile)
                lexical_catchphrase = _build_catchphrase_from_lexical_stats(
                    lexical_stats=lexical_stats,
                    now=now_dt,
                    top_k=5,
                )
                profile = _inject_lexical_stats_into_profile(
                    profile=profile,
                    lexical_stats=lexical_stats,
                    llm_catchphrase=llm_catchphrase,
                    lexical_catchphrase=lexical_catchphrase,
                )

                if owner_user_id and user_id == owner_user_id:
                    profile_kind = "self"
                    if isinstance(profile, dict):
                        profile.pop("user_to_friend_catchphrase", None)
                        profile.pop("user_to_friend_chat_style_preference", None)
                    else:
                        if hasattr(profile, "user_to_friend_catchphrase"):
                            profile.user_to_friend_catchphrase = None
                        if hasattr(profile, "user_to_friend_chat_style_preference"):
                            profile.user_to_friend_chat_style_preference = None

                # Convert to UnifiedProfile and save to unified store (single source of truth)
                if profile_kind == "self":
                    unified_profile_type = ProfileType.USER
                    unified_target_user_id = None
                else:
                    unified_profile_type = ProfileType.CONTACT
                    unified_target_user_id = user_id

                profile_for_conversion = profile
                if not isinstance(profile_for_conversion, dict):
                    if hasattr(profile_for_conversion, "to_dict"):
                        profile_for_conversion = profile_for_conversion.to_dict()
                    elif hasattr(profile_for_conversion, "__dict__"):
                        profile_for_conversion = profile_for_conversion.__dict__
                    else:
                        profile_for_conversion = dict(profile_for_conversion)

                unified_profile = EverMemOSConverter.convert_profile_memory_v2(
                    profile_memory=profile_for_conversion,
                    profile_type=unified_profile_type,
                    owner_user_id=owner_user_id or user_id,
                    target_user_id=unified_target_user_id,
                )

                # Carry over conversation_id from group_id for retrieval context
                if not unified_profile.conversation_id:
                    unified_profile.conversation_id = group_id

                await unified_profile_repo.upsert_by_owner_target(unified_profile)

                logger.info(
                    f"[Profile] profile.save_success profile_kind={profile_kind}, "
                    f"user_id={user_id}, owner_user_id={owner_user_id}, group_id={group_id}, "
                    f"cluster={cluster_id}, profile_type={unified_profile_type.value}, "
                    f"catchphrase_mode={os.getenv('PROFILE_CATCHPHRASE_MODE', 'llm_only')}, "
                    f"llm_catchphrase={len(llm_catchphrase)}, lexical_catchphrase={len(lexical_catchphrase)}"
                )
                print(f"🍃🍃🍃 [Profile] Saved {profile_kind} profile: user_id={user_id}, display_name={getattr(unified_profile, 'display_name', 'N/A')}")
            else:
                logger.warning(
                    f"[Profile] 鈿狅笍 Profile has no user_id, skipping save: {type(profile)}"
                )

        logger.info(
            f"[Profile] profile.extract_completed group_id={group_id}, cluster={cluster_id}, "
            f"extracted={len(new_profiles)} profiles"
        )

    except Exception as e:
        import traceback

        logger.error(
            f"[Profile] profile.extract_error group_id={group_id}, cluster={cluster_id}, error={e}",
            exc_info=True,
        )
        # Profile extraction failure should not block main flow


def _format_raw_messages(raw_list: Optional[List[Any]]) -> str:
    """Format raw chat messages for logging (speaker_name + content only)."""
    if not raw_list:
        return ""

    lines: List[str] = []
    for item in raw_list:
        # Handle RawData-like objects with .content dict
        if hasattr(item, "content") and isinstance(getattr(item, "content"), dict):
            content_dict = getattr(item, "content")
            speaker = (content_dict.get("speaker_name") or content_dict.get("speaker_id") or "").strip()
            text = (content_dict.get("content") or "").strip()
            if speaker or text:
                if speaker:
                    lines.append(f"{speaker}: {text}")
                else:
                    lines.append(text)
            continue

        if isinstance(item, dict):
            speaker = (item.get("speaker_name") or item.get("sender_name") or item.get("speaker_id") or item.get("sender") or "").strip()
            text = (item.get("content") or item.get("text") or item.get("message") or "").strip()
            if speaker or text:
                if speaker:
                    lines.append(f"{speaker}: {text}")
                else:
                    lines.append(text)
            continue

        text = str(item).strip()
        if text:
            lines.append(text)

    return "\n".join(lines)


def _raw_data_to_message_dict(item: Any) -> Optional[Dict[str, Any]]:
    """Normalize RawData (or dict) into a message dict with content/timestamp."""
    content = None
    if hasattr(item, "content") and isinstance(getattr(item, "content"), dict):
        content = getattr(item, "content")
    elif isinstance(item, dict):
        content = item

    if not isinstance(content, dict):
        return None

    msg_type = content.get("msgType")
    supported_msg_types = {
        1: None,  # text
        2: "[Image]",
        3: "[Video]",
        4: "[Audio]",
        5: "[File]",
        6: "[File]",
    }
    if msg_type is not None and msg_type not in supported_msg_types:
        return None

    placeholder = supported_msg_types.get(msg_type)
    if placeholder is not None:
        content = content.copy()
        content["content"] = placeholder

    return content


def _normalize_raw_data_list(raw_list: Optional[List[Any]]) -> List[Dict[str, Any]]:
    """Convert RawData list into normalized message dict list."""
    if not raw_list:
        return []
    normalized: List[Dict[str, Any]] = []
    for item in raw_list:
        msg = _raw_data_to_message_dict(item)
        if msg is not None:
            normalized.append(msg)
    return normalized


def _message_fingerprint(msg: Dict[str, Any]) -> str:
    """Build a stable fingerprint for a message dict."""
    if not isinstance(msg, dict):
        return ""
    for key in ("_id", "message_id", "data_id", "id", "original_id"):
        if msg.get(key):
            return f"{key}:{msg.get(key)}"
    ts = (
        msg.get("timestamp")
        or msg.get("createTime")
        or msg.get("create_time")
        or msg.get("updateTime")
        or msg.get("update_time")
        or ""
    )
    speaker = (
        msg.get("speaker_id")
        or msg.get("sender")
        or msg.get("sender_id")
        or msg.get("speaker_name")
        or ""
    )
    content = msg.get("content") or msg.get("text") or msg.get("message") or ""
    return f"{ts}|{speaker}|{content}"


def _hash_raw_messages(raw_list: Optional[List[Any]]) -> str:
    """Hash normalized messages to build a deterministic signature."""
    normalized = _normalize_raw_data_list(raw_list)
    parts = [_message_fingerprint(m) for m in normalized]
    digest = hashlib.sha1("\n".join(parts).encode("utf-8", errors="ignore")).hexdigest()
    return digest


def _extract_participant_ids_from_messages(
    messages: List[Dict[str, Any]]
) -> List[str]:
    """Extract participant ids from normalized message dicts."""
    participant_ids = set()
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        speaker_id = msg.get("speaker_id")
        if speaker_id:
            participant_ids.add(str(speaker_id))

        refer_list = msg.get("referList") or msg.get("refer_list")
        if refer_list:
            for refer_item in refer_list:
                if isinstance(refer_item, dict):
                    if "_id" in refer_item:
                        participant_ids.add(str(refer_item["_id"]))
                    elif "id" in refer_item:
                        participant_ids.add(str(refer_item["id"]))
                elif isinstance(refer_item, str):
                    participant_ids.add(refer_item)
    return list(participant_ids)


def _extract_last_timestamp(
    messages: List[Dict[str, Any]], fallback: datetime
) -> datetime:
    """Get timestamp from last message, fallback to current time."""
    if not messages:
        return fallback
    last_msg = messages[-1]
    ts_value = (
        last_msg.get("timestamp")
        or last_msg.get("createTime")
        or last_msg.get("create_time")
    )
    try:
        if ts_value:
            return _normalize_datetime_for_storage(ts_value)
    except Exception:
        pass
    return fallback


def _build_memcell_from_raw_data(
    raw_list: List[Any], request: MemorizeRequest, current_time: datetime
) -> Optional[MemCell]:
    """Build a MemCell directly from raw data list."""
    message_dicts = _normalize_raw_data_list(raw_list)
    if not message_dicts:
        return None

    timestamp = _extract_last_timestamp(message_dicts, current_time)
    participants = _extract_participant_ids_from_messages(message_dicts)

    return MemCell(
        user_id_list=request.user_id_list,
        original_data=message_dicts,
        timestamp=timestamp,
        summary="",
        group_id=request.group_id,
        group_name=request.group_name,
        participants=participants,
        type=_convert_data_type_to_raw_data_type(request.raw_data_type),
    )


def _build_user_id_to_name_map(conversation_meta: Any) -> Dict[str, str]:
    """Build user id -> full name map from conversation_meta.user_details."""
    mapping: Dict[str, str] = {}
    if not conversation_meta:
        return mapping
    user_details = getattr(conversation_meta, "user_details", None) or {}
    if not isinstance(user_details, dict):
        return mapping

    for user_id, detail in user_details.items():
        if not user_id:
            continue
        full_name = None
        if isinstance(detail, dict):
            full_name = detail.get("full_name")
        else:
            full_name = getattr(detail, "full_name", None)
        if full_name:
            mapping[str(user_id)] = str(full_name)
    return mapping


async def _extract_and_save_reply_templates(
    memcell: MemCell,
    request: MemorizeRequest,
    *,
    scene_hint: Optional[str] = None,
) -> int:
    """
    Extract templates from current memcell and upsert into MongoDB.

    This reuses existing memcell extraction output instead of building a separate
    data path for template generation.
    """
    try:
        if not memcell or not request.group_id:
            return 0
        messages = memcell.original_data or []
        if not messages:
            return 0

        conversation_meta_repo = get_bean_by_type(ConversationMetaRawRepository)
        conversation_meta = await conversation_meta_repo.get_by_conversation_id(request.conversation_id)
        owner_user_id = ""
        if conversation_meta:
            meta_scene = getattr(conversation_meta, "scene", None)
            if meta_scene:
                scene = _normalize_scene(meta_scene)
            scene_desc = getattr(conversation_meta, "scene_desc", None) or {}
            owner_user_id = str(scene_desc.get("owner_user_id") or "").strip()

        if not owner_user_id:
            logger.info(
                "[Template] Skip extraction because owner_user_id is missing: group_id=%s",
                request.group_id,
            )
            return 0

        user_id_to_name = _build_user_id_to_name_map(conversation_meta)
        templates = extract_reply_templates_from_messages(
            messages,
            owner_user_id=owner_user_id,
            scene=scene,
            group_id=request.group_id,
            source_event_id=str(memcell.event_id) if memcell.event_id else None,
            user_id_to_name=user_id_to_name,
        )
        if not templates:
            return 0

        template_repo = get_bean_by_type(ReplyTemplateRawRepository)
        saved = await template_repo.upsert_batch(templates)
        logger.info(
            "[Template] Extracted %s templates, upserted %s: group_id=%s, memcell_id=%s",
            len(templates),
            saved,
            request.group_id,
            memcell.event_id,
        )
        return saved
    except Exception as exc:
        logger.error("[Template] Failed to extract/save templates: %s", exc, exc_info=True)
        return 0


def _convert_data_type_to_raw_data_type(data_type) -> RawDataType:
    """
    Convert different data type enums to unified RawDataType

    Args:
        data_type: Could be DataTypeEnum, RawDataType, or string

    Returns:
        RawDataType: Converted unified data type
    """
    if isinstance(data_type, RawDataType):
        return data_type

    # Get string value
    if hasattr(data_type, 'value'):
        type_str = data_type.value
    else:
        type_str = str(data_type)

    # Mapping conversion
    type_mapping = {
        "Conversation": RawDataType.CONVERSATION,
        "CONVERSATION": RawDataType.CONVERSATION,
        # Other types map to CONVERSATION as default
    }

    return type_mapping.get(type_str, RawDataType.CONVERSATION)


def _normalize_scene(scene: Optional[str]) -> str:
    """Normalize legacy scene values to current enums."""
    if not scene:
        return "private"
    scene_key = scene.strip().lower()
    if scene_key in ["assistant", "private"]:
        return "private"
    if scene_key in ["companion", "group", "group_chat"]:
        return "group"
    return scene_key


from biz_layer.mem_db_operations import (
    _convert_timestamp_to_time,
    _convert_episode_memory_to_doc,
    _convert_foresight_to_doc,
    _convert_event_log_to_docs,
    _save_memcell_to_database,
    _update_status_for_continuing_conversation,
    _update_status_after_memcell_extraction,
    _save_group_profile_memory,
    _normalize_datetime_for_storage,
)
from typing import Tuple


def if_memorize(memcell: MemCell) -> bool:
    return True


# ==================== MemCell Processing Business Logic ====================


@dataclass
class ExtractionState:
    """Memory extraction state, stores intermediate results"""

    memcell: MemCell
    request: MemorizeRequest
    current_time: datetime
    scene: str
    is_assistant_scene: bool
    participants: List[str]
    force_profile_extraction: bool = False
    group_episode: Optional[EpisodeMemory] = None
    group_episode_memories: List[EpisodeMemory] = None
    episode_memories: List[EpisodeMemory] = None
    parent_docs_map: Dict[str, Any] = None

    def __post_init__(self):
        self.group_episode_memories = []
        self.episode_memories = []
        self.parent_docs_map = {}


async def process_memory_extraction(
    memcell: MemCell,
    request: MemorizeRequest,
    memory_manager: MemoryManager,
    current_time: datetime,
) -> int:
    """
    Main memory extraction process

    Starting from MemCell, extract all memory types including Episode, Foresight, EventLog, etc.
    
    Returns:
        int: Total number of memories extracted
    """
    # 1. Initialize state
    state = await _init_extraction_state(memcell, request, current_time)

    # 2. Extract Episodes
    await _extract_episodes(state, memory_manager)

    # 3. Update MemCell and trigger clustering
    await _update_memcell_and_cluster(state)

    # 4. Save and extract subsequent memories
    memories_count = 0
    if if_memorize(memcell):
        memories_count = await _process_memories(state, memory_manager)
    
    return memories_count


async def _init_extraction_state(
    memcell: MemCell, request: MemorizeRequest, current_time: datetime
) -> ExtractionState:
    """Initialize extraction state"""
    conversation_meta_repo = get_bean_by_type(ConversationMetaRawRepository)
    conversation_meta = await conversation_meta_repo.get_by_conversation_id(request.conversation_id)
    scene = (
        conversation_meta.scene
        if conversation_meta and conversation_meta.scene
        else "private"
    )
    scene = _normalize_scene(scene)
    # Assistant scene is deprecated; treat all current scenes as non-assistant
    is_assistant_scene = False
    participants = list(set(memcell.participants)) if memcell.participants else []

    return ExtractionState(
        memcell=memcell,
        request=request,
        current_time=current_time,
        scene=scene,
        is_assistant_scene=is_assistant_scene,
        participants=participants,
        force_profile_extraction=bool(getattr(request, "force_profile_extraction", False)),
    )


async def _extract_episodes(state: ExtractionState, memory_manager: MemoryManager):
    """Extract group and personal Episodes"""
    if state.is_assistant_scene:
        logger.info("[MemCell Processing] assistant scene (legacy), only extract group Episode")
        tasks = [_create_episode_task(state, memory_manager, None)]
    else:
        logger.info(
            f"[MemCell Processing] private/group scene, extract group + {len(state.participants)} personal Episodes"
        )
        tasks = [_create_episode_task(state, memory_manager, None)]
        tasks.extend(
            [
                _create_episode_task(state, memory_manager, uid)
                for uid in state.participants
            ]
        )

    results = await asyncio.gather(*tasks, return_exceptions=True)
    _process_episode_results(state, results)


def _create_episode_task(
    state: ExtractionState, memory_manager: MemoryManager, user_id: Optional[str]
):
    """Create Episode extraction task"""
    return memory_manager.extract_memory(
        memcell=state.memcell,
        memory_type=MemoryType.EPISODIC_MEMORY,
        user_id=user_id,
        group_id=state.request.group_id,
        group_name=state.request.group_name,
    )


def _process_episode_results(state: ExtractionState, results: List[Any]):
    """Process Episode extraction results"""
    # Group Episode
    group_episode = results[0] if results else None
    if isinstance(group_episode, Exception):
        logger.error(
            f"[MemCell Processing] 鉂?Group Episode exception: {group_episode}"
        )
        group_episode = None
    elif group_episode:
        group_episode.ori_event_id_list = [state.memcell.event_id]
        group_episode.memcell_event_id_list = [state.memcell.event_id]
        state.group_episode_memories.append(group_episode)
        state.group_episode = group_episode
        state.memcell.episode = group_episode.episode
        state.memcell.subject = group_episode.subject
        logger.info("[MemCell Processing] 鉁?Group Episode extracted successfully")

    # Personal Episodes
    if not state.is_assistant_scene:
        for user_id, result in zip(state.participants, results[1:]):
            if isinstance(result, Exception):
                logger.error(
                    f"[MemCell Processing] 鉂?Personal Episode exception: user_id={user_id}"
                )
                continue
            if result:
                result.ori_event_id_list = [state.memcell.event_id]
                result.memcell_event_id_list = [state.memcell.event_id]
                state.episode_memories.append(result)
                logger.info(
                    f"[MemCell Processing] 鉁?Personal Episode successful: user_id={user_id}"
                )


async def _update_memcell_and_cluster(state: ExtractionState):
    """Update MemCell's episode field and trigger clustering"""
    if not state.request.group_id or not state.group_episode:
        return

    # Update MemCell
    try:
        memcell_repo = get_bean_by_type(MemCellRawRepository)
        await memcell_repo.update_by_event_id(
            event_id=state.memcell.event_id,
            update_data={
                "episode": state.group_episode.episode,
                "subject": state.group_episode.subject,
            },
        )
        logger.info(
            f"[MemCell Processing] 鉁?Updated MemCell episode: {state.memcell.event_id}"
        )
    except Exception as e:
        logger.error(f"[MemCell Processing] 鉂?Failed to update MemCell: {e}")

    # Trigger clustering
    try:
        memcell_for_clustering = MemCell(
            event_id=state.memcell.event_id,
            user_id_list=state.memcell.user_id_list,
            original_data=state.memcell.original_data,
            timestamp=state.memcell.timestamp,
            summary=state.memcell.summary,
            group_id=state.memcell.group_id,
            group_name=state.memcell.group_name,
            participants=state.memcell.participants,
            type=state.memcell.type,
            episode=state.group_episode.episode,
        )
        await _trigger_clustering(
            state.request.group_id,
            memcell_for_clustering,
            state.scene,
            force_profile_extraction=state.force_profile_extraction,
            owner_user_id=state.request.owner_user_id,
        )
        logger.info(
            f"[MemCell Processing] 鉁?Clustering completed (scene={state.scene})"
        )
    except Exception as e:
        logger.error(f"[MemCell Processing] 鉂?Failed to trigger clustering: {e}")


async def _process_memories(state: ExtractionState, memory_manager: MemoryManager) -> int:
    """Save Episodes and extract/save Foresight and EventLog
    
    Returns:
        int: Total number of memories saved
    """
    await load_core_memories(state.request, state.participants, state.current_time)

    episodic_source = state.group_episode_memories + state.episode_memories
    episodes_to_save = list(episodic_source)

    # assistant scene (legacy): copy group Episode to each user
    if state.is_assistant_scene and state.group_episode_memories:
        episodes_to_save.extend(_clone_episodes_for_users(state))

    episodes_count = 0
    foresight_count = 0
    eventlog_count = 0
    group_profile_count = 0

    if episodes_to_save:
        await _save_episodes(state, episodes_to_save, episodic_source)
        episodes_count = len(episodes_to_save)

    if episodic_source:
        foresight_memories, event_logs = await _extract_foresight_and_eventlog(
            state, memory_manager, episodic_source
        )
        await _save_foresight_and_eventlog(state, foresight_memories, event_logs)
        foresight_count = len(foresight_memories)
        eventlog_count = len(event_logs)

    if state.scene == "group":
        group_profiles = await _extract_group_profile(state, memory_manager)
        await _save_group_profile(state, group_profiles)
        group_profile_count = len(group_profiles)

    await update_status_after_memcell(
        state.request, state.memcell, state.current_time, state.request.raw_data_type
    )
    
    return episodes_count + foresight_count + eventlog_count + group_profile_count


async def _extract_group_profile(
    state: ExtractionState, memory_manager: MemoryManager
) -> List[Any]:
    """Extract group profile (only for group scene)."""
    if state.scene != "group":
        return []

    try:
        result = await memory_manager.extract_memory(
            memcell=state.memcell,
            memory_type=MemoryType.GROUP_PROFILE,
            user_id=None,
            group_id=state.request.group_id,
            group_name=state.request.group_name,
            old_memory_list=None,
            user_organization=None,
        )
        if not result:
            return []
        return result if isinstance(result, list) else [result]
    except Exception as e:
        logger.error(f"[MemCell Processing] Failed to extract GroupProfile: {e}")
        return []


async def _build_group_member_styles(state: ExtractionState) -> List[dict]:
    """Build per-member speech styles for group profile from stored profiles."""
    try:
        from infra_layer.adapters.out.persistence.repository.unified_profile_repository import (
            UnifiedProfileRepository,
        )
        from infra_layer.adapters.out.persistence.repository.conversation_meta_raw_repository import (
            ConversationMetaRawRepository,
        )
        from core.di import get_bean_by_type

        participants = [
            uid
            for uid in (state.memcell.participants or [])
            if "robot" not in uid.lower() and "assistant" not in uid.lower()
        ]
        if not participants:
            return []

        owner_user_id = None
        scene_desc = getattr(state.request, "scene_desc", None) or {}
        owner_user_id = scene_desc.get("owner_user_id")
        if not owner_user_id:
            conversation_meta_repo = get_bean_by_type(ConversationMetaRawRepository)
            conversation_meta = await conversation_meta_repo.get_by_conversation_id(
                state.request.conversation_id
            )
            if conversation_meta and conversation_meta.scene_desc:
                owner_user_id = conversation_meta.scene_desc.get("owner_user_id")

        user_details = getattr(state.request, "user_details", None) or {}

        unified_profile_repo = get_bean_by_type(UnifiedProfileRepository)

        member_styles = []
        for uid in participants:
            profile_dict = None
            source = None
            if owner_user_id and uid == owner_user_id:
                unified = await unified_profile_repo.get_user_profile(uid)
                if unified:
                    profile_dict = EverMemOSConverter.unified_to_profile_memory(unified)
                    source = "unified_self"
            if profile_dict is None and owner_user_id:
                unified = await unified_profile_repo.get_by_owner_and_target(
                    owner_user_id, uid
                )
                if unified:
                    profile_dict = EverMemOSConverter.unified_to_profile_memory(unified)
                    source = "unified_contact"
            if not profile_dict or not isinstance(profile_dict, dict):
                continue

            user_name = profile_dict.get("user_name") or user_details.get(uid, {}).get(
                "full_name"
            ) or uid

            member_styles.append(
                {
                    "user_id": uid,
                    "user_name": user_name,
                    "catchphrase": profile_dict.get("catchphrase")
                    or profile_dict.get("user_to_friend_catchphrase")
                    or [],
                    "communication_style": profile_dict.get("communication_style")
                    or profile_dict.get("user_to_friend_chat_style_preference")
                    or [],
                    "humor_use": profile_dict.get("humor_use") or [],
                    "source": source,
                }
            )

        return member_styles
    except Exception as e:
        logger.warning(f"[GroupProfile] Failed to build member styles: {e}")
        return []


async def _save_group_profile(state: ExtractionState, group_profiles: List[Any]) -> None:
    """Save group profile memories to database."""
    if not group_profiles:
        return

    group_profile_repo = get_bean_by_type(GroupProfileRawRepository)
    version = None
    if getattr(state, "current_time", None):
        version = state.current_time.strftime("%Y%m%d%H%M%S%f")

    member_styles = await _build_group_member_styles(state)
    for profile in group_profiles:
        if member_styles:
            if isinstance(profile, dict):
                profile["member_styles"] = member_styles
            else:
                setattr(profile, "member_styles", member_styles)
        await _save_group_profile_memory(profile, group_profile_repo, version=version)


def _clone_episodes_for_users(state: ExtractionState) -> List[EpisodeMemory]:
    """Copy group Episode to each user"""
    from dataclasses import replace

    cloned = []
    group_ep = state.group_episode_memories[0]
    for user_id in state.participants:
        if "robot" in user_id.lower() or "assistant" in user_id.lower():
            continue
        cloned.append(replace(group_ep, user_id=user_id, user_name=user_id))
    logger.info(f"[MemCell Processing] Copied group Episode to {len(cloned)} users")
    return cloned


async def _save_episodes(
    state: ExtractionState,
    episodes_to_save: List[EpisodeMemory],
    episodic_source: List[EpisodeMemory],
):
    """Save Episodes to database"""
    for ep in episodes_to_save:
        if getattr(ep, "group_name", None) is None:
            ep.group_name = state.request.group_name
        if getattr(ep, "user_name", None) is None:
            ep.user_name = ep.user_id

    docs = [
        _convert_episode_memory_to_doc(ep, state.current_time)
        for ep in episodes_to_save
    ]
    payloads = [MemoryDocPayload(MemoryType.EPISODIC_MEMORY, doc) for doc in docs]
    saved_map = await save_memory_docs(payloads)
    saved_docs = saved_map.get(MemoryType.EPISODIC_MEMORY, [])

    for ep, saved_doc in zip(episodic_source, saved_docs):
        ep.id = str(saved_doc.id)
        state.parent_docs_map[str(saved_doc.id)] = saved_doc


async def _extract_foresight_and_eventlog(
    state: ExtractionState,
    memory_manager: MemoryManager,
    episodic_source: List[EpisodeMemory],
) -> Tuple[List[Foresight], List[EventLog]]:
    """Extract Foresight and EventLog"""
    logger.info(
        f"[MemCell Processing] Extracting Foresight/EventLog, total {len(episodic_source)} Episodes"
    )

    tasks = []
    metadata = []

    for ep in episodic_source:
        if not ep.id:
            continue
        tasks.append(
            memory_manager.extract_memory(
                memcell=state.memcell,
                memory_type=MemoryType.FORESIGHT,
                user_id=ep.user_id,
                episode_memory=ep,
            )
        )
        metadata.append({'type': MemoryType.FORESIGHT, 'ep': ep})
        tasks.append(
            memory_manager.extract_memory(
                memcell=state.memcell,
                memory_type=MemoryType.EVENT_LOG,
                user_id=ep.user_id,
                episode_memory=ep,
            )
        )
        metadata.append({'type': MemoryType.EVENT_LOG, 'ep': ep})

    if not tasks:
        return [], []

    results = await asyncio.gather(*tasks, return_exceptions=True)

    foresight_memories = []
    event_logs = []

    for meta, result in zip(metadata, results):
        if isinstance(result, Exception) or not result:
            continue

        ep = meta['ep']
        if meta['type'] == MemoryType.FORESIGHT:
            for mem in result:
                mem.parent_episode_id = ep.id
                mem.user_id = ep.user_id
                mem.conversation_id = ep.conversation_id or ep.group_id
                mem.group_id = ep.group_id
                mem.group_name = ep.group_name
                mem.user_name = ep.user_name
                foresight_memories.append(mem)
        elif meta['type'] == MemoryType.EVENT_LOG:
            result.parent_episode_id = ep.id
            result.user_id = ep.user_id
            result.conversation_id = ep.conversation_id or ep.group_id
            result.group_id = ep.group_id
            result.group_name = ep.group_name
            result.user_name = ep.user_name
            event_logs.append(result)

    return foresight_memories, event_logs


async def _save_foresight_and_eventlog(
    state: ExtractionState,
    foresight_memories: List[Foresight],
    event_logs: List[EventLog],
):
    """Save Foresight and EventLog"""
    foresight_docs = []
    for mem in foresight_memories:
        parent_doc = state.parent_docs_map.get(str(mem.parent_episode_id))
        if parent_doc:
            foresight_docs.append(
                _convert_foresight_to_doc(mem, parent_doc, state.current_time)
            )

    event_log_docs = []
    for el in event_logs:
        parent_doc = state.parent_docs_map.get(str(el.parent_episode_id))
        if parent_doc:
            event_log_docs.extend(
                _convert_event_log_to_docs(el, parent_doc, state.current_time)
            )

    # assistant scene (legacy): copy to each user
    if state.is_assistant_scene:
        user_ids = [
            u
            for u in state.participants
            if "robot" not in u.lower() and "assistant" not in u.lower()
        ]
        foresight_docs.extend(
            [
                doc.model_copy(update={"user_id": uid, "user_name": uid})
                for doc in foresight_docs
                for uid in user_ids
            ]
        )
        event_log_docs.extend(
            [
                doc.model_copy(update={"user_id": uid, "user_name": uid})
                for doc in event_log_docs
                for uid in user_ids
            ]
        )
        logger.info(
            f"[MemCell Processing] Copied Foresight/EventLog to {len(user_ids)} users"
        )

    payloads = []
    payloads.extend(
        MemoryDocPayload(MemoryType.FORESIGHT, doc) for doc in foresight_docs
    )
    payloads.extend(
        MemoryDocPayload(MemoryType.EVENT_LOG, doc) for doc in event_log_docs
    )
    if payloads:
        await save_memory_docs(payloads)


def extract_message_time(raw_data):
    """
    Extract message time from RawData object

    Args:
        raw_data: RawData object

    Returns:
        datetime: Message time, return None if extraction fails
    """
    # Prioritize timestamp field
    if hasattr(raw_data, 'timestamp') and raw_data.timestamp:
        try:
            return _normalize_datetime_for_storage(raw_data.timestamp)
        except Exception as e:
            logger.debug(f"Failed to parse timestamp from raw_data.timestamp: {e}")
            pass

    # Extract from extend field
    if (
        hasattr(raw_data, 'extend')
        and raw_data.extend
        and isinstance(raw_data.extend, dict)
    ):
        timestamp_val = raw_data.extend.get('timestamp')
        if timestamp_val:
            try:
                return _normalize_datetime_for_storage(timestamp_val)
            except Exception as e:
                logger.debug(f"Failed to parse timestamp from extend field: {e}")
                pass

    return None


from core.observation.tracing.decorators import trace_logger


@trace_logger(operation_name="mem_memorize preprocess_conv_request", log_level="info")
async def preprocess_conv_request(
    request: MemorizeRequest, current_time: datetime
) -> MemorizeRequest:
    """
    Simplified request preprocessing:
    1. Read all historical messages from Redis
    2. Set historical messages as history_raw_data_list
    3. Set current new message as new_raw_data_list
    4. Boundary detection handled by subsequent logic (will clear or retain Redis after detection)
    """

    logger.info(f"[preprocess] Start processing: group_id={request.group_id}")

    # Check if there is new data
    if not request.new_raw_data_list:
        logger.info("[preprocess] No new data, skip processing")
        return None

    # Use conversation_data_repo for read-then-store operation
    conversation_data_repo = get_bean_by_type(ConversationDataRepository)

    try:
        # Step 1: First get historical messages from conversation_data_repo
        # No time range limit, get up to 1000 recent messages (controlled by cache manager's max_length)
        history_raw_data_list = await conversation_data_repo.get_conversation_data(
            group_id=request.group_id, start_time=None, end_time=None, limit=1000
        )

        logger.info(
            f"[preprocess] Read {len(history_raw_data_list)} historical messages from conversation_data_repo"
        )

        # Update request
        request.history_raw_data_list = history_raw_data_list
        # new_raw_data_list remains unchanged (the newly passed messages)

        logger.info(
            f"[preprocess] Completed: {len(history_raw_data_list)} historical, {len(request.new_raw_data_list)} new messages"
        )

        return request

    except Exception as e:
        logger.error(f"[preprocess] Redis read failed: {e}")
        traceback.print_exc()
        # Use original request if Redis fails
        return request


async def update_status_when_no_memcell(
    request: MemorizeRequest,
    status_result: StatusResult,
    current_time: datetime,
    data_type: RawDataType,
):
    if data_type == RawDataType.CONVERSATION:
        # Try to update status table
        try:
            status_repo = get_bean_by_type(ConversationStatusRawRepository)

            if status_result.should_wait:
                logger.info(
                    f"[mem_memorize] Determined as unable to decide boundary, continue waiting, no status update"
                )
                return
            else:
                logger.info(
                    f"[mem_memorize] Determined as non-boundary, continue accumulating messages, update status table"
                )
                # Get latest message timestamp
                latest_time = _convert_timestamp_to_time(current_time, current_time)
                if request.new_raw_data_list:
                    last_msg = request.new_raw_data_list[-1]
                    if hasattr(last_msg, 'content') and isinstance(
                        last_msg.content, dict
                    ):
                        latest_time = last_msg.content.get('timestamp', latest_time)
                    elif hasattr(last_msg, 'timestamp'):
                        latest_time = last_msg.timestamp

                if not latest_time:
                    latest_time = min(latest_time, current_time)

                # Use encapsulated function to update conversation continuation status
                await _update_status_for_continuing_conversation(
                    status_repo, request, latest_time, current_time
                )

        except Exception as e:
            logger.error(f"Failed to update status table: {e}")
    else:
        pass


async def update_status_after_memcell(
    request: MemorizeRequest,
    memcell: MemCell,
    current_time: datetime,
    data_type: RawDataType,
):
    if data_type == RawDataType.CONVERSATION:
        # Update last_memcell_time in status table to memcell's timestamp
        try:
            status_repo = get_bean_by_type(ConversationStatusRawRepository)

            # Get MemCell's timestamp
            memcell_time = None
            if memcell and hasattr(memcell, 'timestamp'):
                memcell_time = memcell.timestamp
            else:
                memcell_time = current_time

            # Use encapsulated function to update status after MemCell extraction
            await _update_status_after_memcell_extraction(
                status_repo, request, memcell_time, current_time
            )

            logger.info(
                f"[mem_memorize] Memory extraction completed, status table updated"
            )

        except Exception as e:
            logger.error(f"Final status table update failed: {e}")
    else:
        pass


async def save_memory_docs(
    doc_payloads: List[MemoryDocPayload], version: Optional[str] = None
) -> Dict[MemoryType, List[Any]]:
    """
    Generic Doc saving function, automatically saves and synchronizes by MemoryType enum
    """

    grouped_docs: Dict[MemoryType, List[Any]] = defaultdict(list)
    for payload in doc_payloads:
        if payload and payload.doc:
            grouped_docs[payload.memory_type].append(payload.doc)

    saved_result: Dict[MemoryType, List[Any]] = {}

    # Episodic
    episodic_docs = grouped_docs.get(MemoryType.EPISODIC_MEMORY, [])
    if episodic_docs:
        episodic_repo = get_bean_by_type(EpisodicMemoryRawRepository)
        episodic_es_repo = get_bean_by_type(EpisodicMemoryEsRepository)
        episodic_milvus_repo = get_bean_by_type(EpisodicMemoryMilvusRepository)
        saved_episodic: List[Any] = []

        for doc in episodic_docs:
            saved_doc = await episodic_repo.append_episodic_memory(doc)
            saved_episodic.append(saved_doc)

            es_doc = EpisodicMemoryConverter.from_mongo(saved_doc)
            await episodic_es_repo.create(es_doc)

            milvus_entity = EpisodicMemoryMilvusConverter.from_mongo(saved_doc)
            vector = (
                milvus_entity.get("vector") if isinstance(milvus_entity, dict) else None
            )
            if vector and len(vector) > 0:
                await episodic_milvus_repo.insert(milvus_entity, flush=False)
            else:
                logger.warning(
                    "[mem_memorize] Skipping write to Milvus: vector empty or missing, event_id=%s",
                    getattr(saved_doc, "event_id", None),
                )

        saved_result[MemoryType.EPISODIC_MEMORY] = saved_episodic

    # Foresight
    foresight_docs = grouped_docs.get(MemoryType.FORESIGHT, [])
    if foresight_docs:
        foresight_repo = get_bean_by_type(ForesightRecordRawRepository)
        saved_foresight = await foresight_repo.create_batch(foresight_docs)
        saved_result[MemoryType.FORESIGHT] = saved_foresight

        sync_service = get_bean_by_type(MemorySyncService)
        await sync_service.sync_batch_foresights(
            saved_foresight, sync_to_es=True, sync_to_milvus=True
        )

    # Event Log
    event_log_docs = grouped_docs.get(MemoryType.EVENT_LOG, [])
    if event_log_docs:
        event_log_repo = get_bean_by_type(EventLogRecordRawRepository)
        saved_event_logs = await event_log_repo.create_batch(event_log_docs)
        saved_result[MemoryType.EVENT_LOG] = saved_event_logs

        sync_service = get_bean_by_type(MemorySyncService)
        await sync_service.sync_batch_event_logs(
            saved_event_logs, sync_to_es=True, sync_to_milvus=True
        )

    # Profile: no longer written via save_memory_docs.
    # Profile writes go through _trigger_profile_extraction → UnifiedProfileRepository.

    return saved_result


async def load_core_memories(
    request: MemorizeRequest, participants: List[str], current_time: datetime
):
    logger.info(f"[mem_memorize] Reading user data: {participants}")
    # Initialize Repository instance
    core_memory_repo = get_bean_by_type(CoreMemoryRawRepository)

    # Read user CoreMemory data
    user_core_memories = {}
    for user_id in participants:
        try:
            core_memory = await core_memory_repo.get_by_user_id(user_id)
            if core_memory:
                user_core_memories[user_id] = core_memory
            # Remove individual user success/failure logs
        except Exception as e:
            logger.error(f"Failed to get user {user_id} CoreMemory: {e}")

    logger.info(f"[mem_memorize] Retrieved {len(user_core_memories)} users' CoreMemory")

    # Directly convert CoreMemory to list of ProfileMemory objects
    old_memory_list = []
    if user_core_memories:
        for user_id, core_memory in user_core_memories.items():
            if core_memory:
                # Directly create ProfileMemory object
                profile_memory = ProfileMemory(
                    # Memory base class required fields
                    memory_type=MemoryType.CORE,
                    user_id=user_id,
                    timestamp=to_iso_format(current_time),
                    ori_event_id_list=[],
                    # Memory base class optional fields
                    subject=f"{getattr(core_memory, 'user_name', user_id)}'s personal profile",
                    summary=f"User {user_id}'s basic information updated",
                    group_id=request.group_id,
                    participants=[user_id],
                    type=RawDataType.CONVERSATION,
                    # ProfileMemory specific fields - directly use original dictionary format
                    user_name=getattr(core_memory, 'user_name', None),
                    gender=getattr(core_memory, 'gender', None),
                    occupation=getattr(core_memory, 'occupation', None),
                    relationship=getattr(core_memory, 'relationship', None),
                    output_reasoning=getattr(core_memory, 'output_reasoning', None),
                    way_of_decision_making=getattr(core_memory, 'way_of_decision_making', None),
                    personality=getattr(core_memory, 'personality', None),
                    interests=getattr(core_memory, 'interests', None),
                    motivation_system=getattr(core_memory, 'motivation_system', None),
                    fear_system=getattr(core_memory, 'fear_system', None),
                    value_system=getattr(core_memory, 'value_system', None),
                    humor_use=getattr(core_memory, 'humor_use', None),
                    life_habit_preference=getattr(core_memory, 'life_habit_preference', None),
                    communication_style=getattr(core_memory, 'communication_style', None),
                    catchphrase=getattr(core_memory, 'catchphrase', None),
                    user_to_friend_catchphrase=getattr(core_memory, 'user_to_friend_catchphrase', None),
                    user_to_friend_chat_style_preference=getattr(
                        core_memory, 'user_to_friend_chat_style_preference', None
                    ),
                )
                old_memory_list.append(profile_memory)

        logger.info(
            f"[mem_memorize] Directly converted {len(old_memory_list)} CoreMemory to ProfileMemory"
        )
    else:
        logger.info(f"[mem_memorize] No user CoreMemory data, old_memory_list is empty")


async def memorize(request: MemorizeRequest) -> int:
    """
    Main memory extraction process (global queue version)

    Flow:
    1. Extract MemCell
    2. Save MemCell to database
    3. Submit to global queue for asynchronous processing by Worker
    4. Return immediately, do not wait for subsequent processing to complete
    
    Returns:
        int: Number of memories extracted (0 if no boundary detected or extraction failed)
    """
    # Unified conversation key migration: conversation_id is canonical.
    if not getattr(request, "conversation_id", None) and getattr(request, "group_id", None):
        request.conversation_id = request.group_id
    if not getattr(request, "group_id", None) and getattr(request, "conversation_id", None):
        request.group_id = request.conversation_id

    lock_key = f"mem_memorize:{request.conversation_id}"
    async with distributed_lock(lock_key, timeout=300.0, blocking_timeout=300.0) as acquired:
        if not acquired:
            logger.warning(
                "[mem_memorize] Failed to acquire lock for group_id=%s, skip this batch",
                request.group_id,
            )
            return 0

        logger.info(f"[mem_memorize] request.current_time: {request.current_time}")

    # Get current time
    if request.current_time:
        current_time = request.current_time
    else:
        current_time = get_now_with_timezone() + timedelta(seconds=1)
    logger.info(f"[mem_memorize] Current time: {current_time}")

    memory_manager = MemoryManager()
    conversation_data_repo = get_bean_by_type(ConversationDataRepository)
    # ===== MemCell Extraction Phase =====
    if request.raw_data_type == RawDataType.CONVERSATION:
        request = await preprocess_conv_request(request, current_time)
        if request == None:
            logger.warning(f"[mem_memorize] preprocess_conv_request returned None")
            return 0

    # Boundary detection
    now = time.time()
    logger.info("=" * 80)
    logger.info(f"[Boundary Detection] Start detection: group_id={request.group_id}")
    logger.info(
        f"[Boundary Detection] Temporary stored historical messages: {len(request.history_raw_data_list)} messages"
    )
    logger.info(
        f"[Boundary Detection] New messages: {len(request.new_raw_data_list)} messages"
    )
    logger.info("=" * 80)

    memcell_result = await memory_manager.extract_memcell(
        request.history_raw_data_list,
        request.new_raw_data_list,
        request.raw_data_type,
        request.group_id,
        request.group_name,
        request.user_id_list,
        force_split_all=getattr(request, "skip_pending_boundary", False),
    )
    logger.debug(f"[mem_memorize] Extracting MemCell took: {time.time() - now} seconds")

    if memcell_result == None:
        logger.warning(f"[mem_memorize] Skipped extracting MemCell")
        return 0

    memcell, status_result = memcell_result

    # Pending boundary state (delay confirmation by one batch)
    status_repo = get_bean_by_type(ConversationStatusRawRepository)
    status_doc = await status_repo.get_by_group_id(request.group_id)
    pending_active = bool(getattr(status_doc, "pending_boundary", False))
    pending_count = getattr(status_doc, "pending_boundary_count", None)
    pending_hash = getattr(status_doc, "pending_boundary_hash", None)
    last_confirmed_hash = getattr(status_doc, "last_confirmed_boundary_hash", None)
    confirmed_hash: Optional[str] = None
    skip_memcell_save = False

    # Check boundary detection result
    logger.info("=" * 80)
    logger.info(f"[Boundary Detection Result] memcell is None: {memcell is None}")
    if memcell is None:
        logger.info(
            f"[Boundary Detection Result] Judgment: {'Need to wait for more messages' if status_result.should_wait else 'Non-boundary, continue accumulating'}"
        )
    else:
        logger.info(
            f"[Boundary Detection Result] Judgment: It's a boundary! event_id={memcell.event_id}"
        )
    logger.info("=" * 80)

    if memcell == None:
        if pending_active:
            await status_repo.upsert_by_group_id(
                request.group_id,
                {
                    "pending_boundary": False,
                    "pending_boundary_count": None,
                    "pending_boundary_time": None,
                    "pending_boundary_hash": None,
                },
            )
        # Save new messages to conversation_data_repo
        await conversation_data_repo.save_conversation_data(
            request.new_raw_data_list, request.group_id
        )
        await update_status_when_no_memcell(
            request, status_result, current_time, request.raw_data_type
        )
        remaining_messages = (
            (request.history_raw_data_list or []) + (request.new_raw_data_list or [])
        )
        remaining_count = len(remaining_messages)
        remaining_text = _format_raw_messages(remaining_messages)
        if remaining_text:
            logger.info(
                "🥸🥸🥸 Remaining history (not in MemCell): %s messages\n%s",
                remaining_count,
                remaining_text,
            )
        logger.warning(f"[mem_memorize] No boundary detected, returning")
        return 0
    else:
        # Check if we should skip the pending boundary mechanism (for historical imports)
        skip_pending = getattr(request, "skip_pending_boundary", False)
        logger.info(f"[mem_memorize] skip_pending_boundary={skip_pending}, pending_active={pending_active}")

        if not pending_active and not skip_pending:
            # Use the actual MemCell size (history + split part of new batch)
            pending_count = len(memcell.original_data or [])
            pending_time = _extract_last_timestamp(
                _normalize_raw_data_list(memcell.original_data or []),
                current_time,
            )
            pending_hash = _hash_raw_messages(memcell.original_data or [])
            await status_repo.upsert_by_group_id(
                request.group_id,
                {
                    "pending_boundary": True,
                    "pending_boundary_count": pending_count,
                    "pending_boundary_time": pending_time,
                    "pending_boundary_hash": pending_hash,
                },
            )
            await conversation_data_repo.save_conversation_data(
                request.new_raw_data_list, request.group_id
            )
            logger.info(
                "[Boundary Detection] Pending boundary set (count=%s), wait next batch to confirm",
                pending_count,
            )
            return 0

        if not skip_pending:
            await status_repo.upsert_by_group_id(
                request.group_id,
                {
                    "pending_boundary": False,
                    "pending_boundary_count": None,
                    "pending_boundary_time": None,
                    "pending_boundary_hash": None,
                },
            )
        if pending_count and pending_count > 0:
            combined_raw = (request.history_raw_data_list or []) + (
                request.new_raw_data_list or []
            )
            pending_raw = combined_raw[:pending_count]
            confirmed_hash = _hash_raw_messages(pending_raw)
            if last_confirmed_hash and confirmed_hash == last_confirmed_hash:
                logger.warning(
                    "[mem_memorize] Duplicate pending boundary detected, skip MemCell save: group_id=%s hash=%s",
                    request.group_id,
                    confirmed_hash,
                )
                skip_memcell_save = True
            rebuilt_memcell = _build_memcell_from_raw_data(
                pending_raw, request, current_time
            )
            if rebuilt_memcell is not None:
                memcell = rebuilt_memcell
        logger.info(f"[mem_memorize] Successfully extracted MemCell")
        memcell_count = len(memcell.original_data) if memcell.original_data else 0
        memcell_text = _format_raw_messages(memcell.original_data)
        if memcell_text:
            logger.info(
                "😊😊😊 MemCell messages: %s messages\n%s",
                memcell_count,
                memcell_text,
            )
        # Judged as boundary, clear conversation history data (restart accumulation)
        try:
            conversation_data_repo = get_bean_by_type(ConversationDataRepository)
            delete_success = await conversation_data_repo.delete_conversation_data(
                request.group_id
            )
            if delete_success:
                logger.info(
                    f"[mem_memorize] Judged as boundary, conversation history cleared: group_id={request.group_id}"
                )
            else:
                logger.warning(
                    f"[mem_memorize] Failed to clear conversation history: group_id={request.group_id}"
                )
            combined_raw = (request.history_raw_data_list or []) + (
                request.new_raw_data_list or []
            )
            # Calculate remaining messages based on memcell content
            if skip_pending:
                # For historical imports, remaining = total - memcell messages
                memcell_msg_ids = set()
                for msg in (memcell.original_data or []):
                    msg_id = msg.get("message_id") or msg.get("data_id")
                    if msg_id:
                        memcell_msg_ids.add(msg_id)
                remaining_history = [
                    raw for raw in combined_raw
                    if (raw.data_id not in memcell_msg_ids)
                ]
                logger.info(
                    f"[mem_memorize] skip_pending mode: {len(remaining_history)} remaining messages after memcell ({memcell_count} msgs)"
                )
            else:
                remaining_history = combined_raw
                if pending_count and pending_count > 0:
                    remaining_history = combined_raw[pending_count:]
            # Save new messages to conversation_data_repo
            await conversation_data_repo.save_conversation_data(
                remaining_history, request.group_id
            )
            remaining_messages = remaining_history
            remaining_count = len(remaining_messages)
            remaining_text = _format_raw_messages(remaining_messages)
            if remaining_text:
                logger.info(
                    "🥸🥸🥸 Remaining history (not in MemCell): %s messages\n%s",
                    remaining_count,
                    remaining_text,
                )
        except Exception as e:
            logger.error(
                f"[mem_memorize] Exception while clearing conversation history: {e}"
            )
            logger.error(
                "[mem_memorize] Clear history context: group_id=%s new_messages=%s",
                request.group_id,
                len(request.new_raw_data_list),
            )
            logger.error(
                "[mem_memorize] New messages preview: %s",
                summarize_json(request.new_raw_data_list[:3]),
            )
            traceback.print_exc()
    # TODO: Read status table, read accumulated MemCell data table, determine whether to perform memorize calculation

    if skip_memcell_save:
        if confirmed_hash:
            await status_repo.upsert_by_group_id(
                request.group_id,
                {"last_confirmed_boundary_hash": confirmed_hash},
            )
        logger.warning(
            "[mem_memorize] Skipped duplicate MemCell save: group_id=%s",
            request.group_id,
        )
        return 0

    # Save MemCell to table
    memcell = await _save_memcell_to_database(memcell, current_time)
    if confirmed_hash:
        await status_repo.upsert_by_group_id(
            request.group_id,
            {"last_confirmed_boundary_hash": confirmed_hash},
        )
    logger.info(f"[mem_memorize] Successfully saved MemCell: {memcell.event_id}")

    # Extract and persist reply templates from memcell (best effort).
    await _extract_and_save_reply_templates(memcell, request)

    # Get current request_id

    app_info = get_current_app_info()
    request_id = app_info.get('request_id')
    # Directly execute memory extraction (blocking/asynchronous logic controlled by middleware layer request_process)
    try:
        memories_count = await process_memory_extraction(
            memcell, request, memory_manager, current_time
        )
        logger.info(
            "[mem_memorize] Memory extraction completed, count=%s, request_id=%s",
            memories_count,
            request_id,
        )
        logger.info(
            "👌👌👌 Memory extraction finished: count=%s, request_id=%s",
            memories_count,
            request_id,
        )
        return memories_count
    except Exception as e:
        logger.error("[mem_memorize] Memory extraction failed: %s", e)
        logger.error(
            "[mem_memorize] Extraction context: group_id=%s memcell_id=%s new_messages=%s",
            request.group_id,
            memcell.event_id if memcell else None,
            len(request.new_raw_data_list),
        )
        logger.error(
            "[mem_memorize] New messages preview: %s",
            summarize_json(request.new_raw_data_list[:3]),
        )
        traceback.print_exc()
        return 0







