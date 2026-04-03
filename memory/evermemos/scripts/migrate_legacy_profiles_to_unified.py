from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from pymongo import MongoClient


DEFAULT_URI = "mongodb://admin:memsys123@127.0.0.1:27017/memsys?authSource=admin"
DEFAULT_DB = "memsys"


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_iso(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def unique_strings(values: Iterable[Any]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def choose_display_name(*candidates: Optional[str], fallback: str) -> str:
    for candidate in candidates:
        text = str(candidate or "").strip()
        if not text:
            continue
        if text in {"??????", "ОТ"}:
            continue
        return text
    return fallback


def evidence_from_strings(items: Iterable[Any]) -> List[Dict[str, Any]]:
    evidence: List[Dict[str, Any]] = []
    for raw in items:
        text = str(raw or "").strip()
        if not text:
            continue
        parts = text.split("|")
        timestamp = parts[0] if parts else ""
        message_id = parts[1] if len(parts) > 1 else None
        evidence.append(
            {
                "source": "legacy_profile",
                "timestamp": timestamp,
                "message_id": message_id,
            }
        )
    return evidence


def fact_category(field_name: str) -> str:
    mapping = {
        "personality": "trait",
        "interests": "interest",
        "occupation": "occupation",
        "relationship": "role",
        "communication_style": "style",
        "catchphrase": "style",
        "fear_system": "other",
        "value_system": "other",
        "way_of_decision_making": "other",
        "life_habit_preference": "other",
        "motivation_system": "other",
        "humor_use": "style",
    }
    return mapping.get(field_name, "other")


def build_facts_from_legacy(profile_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    facts: List[Dict[str, Any]] = []
    now = iso_now()
    for field_name in (
        "personality",
        "interests",
        "communication_style",
        "catchphrase",
        "fear_system",
        "value_system",
        "way_of_decision_making",
        "life_habit_preference",
        "motivation_system",
        "humor_use",
    ):
        for item in as_list(profile_data.get(field_name)):
            if isinstance(item, dict):
                value = str(item.get("value") or "").strip()
                evidences = evidence_from_strings(as_list(item.get("evidences")))
                level = str(item.get("level") or "").strip()
            else:
                value = str(item or "").strip()
                evidences = []
                level = ""
            if not value:
                continue
            fact_text = value if not level else f"{value} ({level})"
            facts.append(
                {
                    "fact": fact_text,
                    "category": fact_category(field_name),
                    "evidence": evidences,
                    "confidence": 0.6,
                    "last_updated": now,
                }
            )
    relationship = str(profile_data.get("relationship") or "").strip()
    if relationship:
        facts.append(
            {
                "fact": relationship,
                "category": "role",
                "evidence": [],
                "confidence": 0.7,
                "last_updated": now,
            }
        )
    return facts


def merge_fact_lists(*fact_lists: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for fact_list in fact_lists:
        for fact in fact_list or []:
            fact_text = str(fact.get("fact") or "").strip()
            category = str(fact.get("category") or "other").strip()
            if not fact_text:
                continue
            key = (category.casefold(), fact_text.casefold())
            if key in seen:
                continue
            seen.add(key)
            merged.append(
                {
                    "fact": fact_text,
                    "category": category or "other",
                    "evidence": list(fact.get("evidence") or []),
                    "confidence": float(fact.get("confidence") or 0),
                    "last_updated": str(fact.get("last_updated") or iso_now()),
                }
            )
    return merged


def default_social(role: str, current_status: str) -> Dict[str, Any]:
    return {
        "role": role,
        "age_group": None,
        "intimacy_level": "stranger",
        "current_status": current_status,
        "intermediary": {
            "has_intermediary": False,
            "name": None,
            "context": None,
        },
    }


def default_comm(tone_style: str) -> Dict[str, Any]:
    return {
        "frequent_phrases": [],
        "emoji_usage": [],
        "punctuation_style": "",
        "avg_message_length": "short",
        "tone_style": tone_style,
    }


def default_metadata(created_at: Any, updated_at: Any, memcell_count: Any, version: Any, cluster_id: Any) -> Dict[str, Any]:
    created = to_iso(created_at) or iso_now()
    updated = to_iso(updated_at) or created
    return {
        "version": int(version or 1),
        "created_at": created,
        "last_updated": updated,
        "source_memcell_count": int(memcell_count or 0),
        "last_cluster_id": str(cluster_id) if cluster_id else None,
        "update_count": max(int(version or 1) - 1, 0),
    }


def build_user_profile(owner_user_id: str, self_doc: Dict[str, Any], existing: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    profile_data = deepcopy(self_doc.get("profile_data") or {})
    existing = deepcopy(existing or {})
    display_name = choose_display_name(
        profile_data.get("user_name"),
        existing.get("display_name"),
        fallback="我",
    )
    tone_values = unique_strings(item.get("value") for item in as_list(profile_data.get("communication_style")) if isinstance(item, dict))
    catchphrases = unique_strings(item.get("value") for item in as_list(profile_data.get("catchphrase")) if isinstance(item, dict))
    traits = unique_strings(
        [item.get("value") for item in as_list(profile_data.get("personality")) if isinstance(item, dict)]
        + list(existing.get("traits") or [])
    )
    interests = unique_strings(
        [item.get("value") for item in as_list(profile_data.get("interests")) if isinstance(item, dict)]
        + list(existing.get("interests") or [])
    )
    facts = merge_fact_lists(build_facts_from_legacy(profile_data), existing.get("facts") or [])
    metadata = default_metadata(
        self_doc.get("created_at"),
        self_doc.get("updated_at"),
        self_doc.get("memcell_count"),
        self_doc.get("version"),
        self_doc.get("last_updated_cluster"),
    )
    return {
        "profile_id": owner_user_id,
        "profile_type": "user",
        "owner_user_id": owner_user_id,
        "target_user_id": None,
        "conversation_id": None,
        "display_name": display_name,
        "traits": traits,
        "interests": interests,
        "occupation": profile_data.get("occupation"),
        "social_attributes": existing.get("social_attributes") or default_social("self", "self"),
        "communication_style": {
            **default_comm(", ".join(tone_values) if tone_values else "friendly, casual"),
            "frequent_phrases": unique_strings(catchphrases + list((existing.get("communication_style") or {}).get("frequent_phrases") or [])),
            "tone_style": ", ".join(tone_values) if tone_values else (existing.get("communication_style") or {}).get("tone_style", "friendly, casual"),
        },
        "risk_assessment": existing.get("risk_assessment"),
        "facts": facts,
        "metadata": metadata,
        "retrieval": existing.get("retrieval"),
        "extend": {
            **(existing.get("extend") or {}),
            "legacy_profile_data": profile_data,
            "legacy_source": "user_self_profile",
        },
    }


def build_contact_profile(owner_user_id: str, legacy_doc: Dict[str, Any], existing: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    profile_data = deepcopy(legacy_doc.get("profile_data") or {})
    existing = deepcopy(existing or {})
    contact_id = str(legacy_doc.get("user_id") or profile_data.get("user_id") or existing.get("target_user_id") or "").strip()
    if not contact_id:
        raise ValueError("legacy contact profile missing user_id")
    relationship = str(profile_data.get("relationship") or "").strip()
    tone_values = unique_strings(item.get("value") for item in as_list(profile_data.get("communication_style")) if isinstance(item, dict))
    catchphrases = unique_strings(item.get("value") for item in as_list(profile_data.get("catchphrase")) if isinstance(item, dict))
    traits = unique_strings(
        [item.get("value") for item in as_list(profile_data.get("personality")) if isinstance(item, dict)]
        + list(existing.get("traits") or [])
    )
    interests = unique_strings(
        [item.get("value") for item in as_list(profile_data.get("interests")) if isinstance(item, dict)]
        + list(existing.get("interests") or [])
    )
    facts = merge_fact_lists(build_facts_from_legacy(profile_data), existing.get("facts") or [])
    metadata = default_metadata(
        legacy_doc.get("created_at"),
        legacy_doc.get("updated_at"),
        legacy_doc.get("memcell_count"),
        legacy_doc.get("version"),
        legacy_doc.get("last_updated_cluster"),
    )
    social_attributes = existing.get("social_attributes") or default_social(relationship or "unknown", relationship or "acquaintance")
    social_attributes["role"] = relationship or social_attributes.get("role") or "unknown"
    social_attributes["current_status"] = relationship or social_attributes.get("current_status") or "acquaintance"
    return {
        "profile_id": contact_id,
        "profile_type": "contact",
        "owner_user_id": owner_user_id,
        "target_user_id": contact_id,
        "conversation_id": str(legacy_doc.get("group_id") or profile_data.get("group_id") or existing.get("conversation_id") or contact_id),
        "display_name": choose_display_name(profile_data.get("user_name"), existing.get("display_name"), fallback=contact_id),
        "traits": traits,
        "interests": interests,
        "occupation": profile_data.get("occupation") or existing.get("occupation"),
        "social_attributes": social_attributes,
        "communication_style": {
            **default_comm(", ".join(tone_values) if tone_values else "friendly"),
            "frequent_phrases": unique_strings(catchphrases + list((existing.get("communication_style") or {}).get("frequent_phrases") or [])),
            "tone_style": ", ".join(tone_values) if tone_values else (existing.get("communication_style") or {}).get("tone_style", "friendly"),
        },
        "risk_assessment": existing.get("risk_assessment")
        or {
            "is_suspicious": False,
            "risk_level": "low",
            "warning_msg": "",
            "risk_patterns": [],
            "last_checked": None,
        },
        "facts": facts,
        "metadata": metadata,
        "retrieval": existing.get("retrieval"),
        "extend": {
            **(existing.get("extend") or {}),
            "legacy_profile_data": profile_data,
            "legacy_source": "user_profiles",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate legacy EverMemOS profile collections into unified_profiles.")
    parser.add_argument("--mongo-uri", default=DEFAULT_URI)
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--canonical-owner-id", default=None)
    parser.add_argument("--owner-alias", action="append", default=["captain1307"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    client = MongoClient(args.mongo_uri)
    db = client[args.db]

    self_doc = db["user_self_profile"].find_one(sort=[("updated_at", -1)])
    if not self_doc and not args.canonical_owner_id:
        raise SystemExit("No legacy self profile found and no --canonical-owner-id was provided.")

    canonical_owner_id = str(args.canonical_owner_id or self_doc["user_id"]).strip()
    owner_aliases = unique_strings([canonical_owner_id] + list(args.owner_alias or []))
    unified_col = db["unified_profiles"]

    existing_unified = list(
        unified_col.find(
            {"owner_user_id": {"$in": owner_aliases}},
            {"_id": 0},
        )
    )
    existing_user = next((doc for doc in existing_unified if doc.get("profile_type") == "user"), None)
    existing_contacts = {
        str(doc.get("target_user_id") or doc.get("profile_id")): doc
        for doc in existing_unified
        if doc.get("profile_type") == "contact"
    }

    legacy_contacts = list(db["user_profiles"].find({}, {"_id": 0}))

    migrated_user = build_user_profile(canonical_owner_id, self_doc or {}, existing_user)
    migrated_contacts = [
        build_contact_profile(canonical_owner_id, legacy_doc, existing_contacts.get(str(legacy_doc.get("user_id"))))
        for legacy_doc in legacy_contacts
    ]

    print(f"canonical_owner_id={canonical_owner_id}")
    print(f"legacy_contact_count={len(legacy_contacts)}")
    print(f"existing_unified_count={len(existing_unified)}")
    print(f"planned_unified_total={1 + len(migrated_contacts)}")

    if args.dry_run:
        return

    unified_col.replace_one(
        {"profile_type": "user", "owner_user_id": canonical_owner_id},
        migrated_user,
        upsert=True,
    )
    for contact in migrated_contacts:
        unified_col.replace_one(
            {
                "profile_type": "contact",
                "owner_user_id": canonical_owner_id,
                "target_user_id": contact["target_user_id"],
            },
            contact,
            upsert=True,
        )

    delete_aliases = [alias for alias in owner_aliases if alias != canonical_owner_id]
    if delete_aliases:
        unified_col.delete_many({"owner_user_id": {"$in": delete_aliases}})

    final_count = unified_col.count_documents({"owner_user_id": canonical_owner_id})
    print(f"final_unified_count={final_count}")


if __name__ == "__main__":
    main()
