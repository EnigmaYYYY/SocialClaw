#!/usr/bin/env python3
import argparse
import csv
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


TYPE_MAP = {
    "1": ("text", None),
    "3": ("image", "[Image]"),
    "34": ("audio", "[Audio]"),
    "43": ("video", "[Video]"),
    "47": ("image", "[Sticker]"),
    "48": ("link", "[Location]"),
    "49": ("link", "[AppMessage]"),
    "50": ("system", "[System]"),
    "66": ("link", "[AppMessage]"),
    "42": ("link", "[ContactCard]"),
    "10000": ("system", None),
}


def parse_epoch(value: str) -> str | None:
    if not value:
        return None
    try:
        ts = int(value)
    except ValueError:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def parse_str_time(value: str) -> str | None:
    if not value:
        return None
    try:
        dt = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat()


def normalize_sender_name(name: str, fallback: str) -> str:
    name = (name or "").strip()
    if not name:
        return fallback
    return name


def map_message_type(type_value: str) -> tuple[str, str | None]:
    return TYPE_MAP.get(type_value, ("text", "[Unsupported]"))


def build_group_id(sender_ids: list[str], fallback: str) -> str:
    if len(sender_ids) == 2:
        return f"chat_{sender_ids[0]}_{sender_ids[1]}"
    if sender_ids:
        return f"chat_{'_'.join(sender_ids)}"
    return f"chat_{fallback}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert a chat CSV export to GroupChatFormat JSON."
    )
    parser.add_argument("--input", required=True, help="Input CSV file path")
    parser.add_argument("--output", required=True, help="Output JSON file path")
    parser.add_argument(
        "--scene",
        default="work",
        help="Conversation scene to write into conversation_meta (default: work)",
    )
    parser.add_argument(
        "--default-timezone",
        default="UTC",
        help="Default timezone for conversation_meta (default: UTC)",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    rows = []
    with input_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            rows.append(row)

    if not rows:
        raise SystemExit("No rows found in CSV.")

    sender_name_map: dict[str, str] = {}
    self_sender_id = None
    for row in rows:
        sender_id = (row.get("Sender") or "").strip()
        if not sender_id:
            continue
        sender_name_map[sender_id] = normalize_sender_name(
            row.get("NickName", ""), sender_id
        )
        if row.get("IsSender") == "1" and not self_sender_id:
            self_sender_id = sender_id

    sender_ids = sorted(sender_name_map.keys())
    group_id = build_group_id(sender_ids, fallback=input_path.stem)

    friend_name = None
    if self_sender_id and len(sender_ids) == 2:
        friend_id = sender_ids[0] if sender_ids[1] == self_sender_id else sender_ids[1]
        friend_name = sender_name_map.get(friend_id)

    conversation_name = (
        f"Chat with {friend_name}" if friend_name else "Chat Conversation"
    )

    messages = []
    type_counter = Counter()
    skipped = 0
    for idx, row in enumerate(rows, start=1):
        sender_id = (row.get("Sender") or "").strip()
        if not sender_id:
            skipped += 1
            continue

        msg_type_raw = (row.get("Type") or "").strip()
        mapped_type, placeholder = map_message_type(msg_type_raw)
        type_counter[mapped_type] += 1

        content = (row.get("StrContent") or "").strip()
        if not content and placeholder:
            content = placeholder

        if not content:
            skipped += 1
            continue

        created = parse_epoch(row.get("CreateTime", "")) or parse_str_time(
            row.get("StrTime", "")
        )
        if not created:
            created = datetime.now(tz=timezone.utc).isoformat()

        msg = {
            "message_id": str(row.get("localId") or f"msg_{idx}"),
            "create_time": created,
            "sender": sender_id,
            "sender_name": sender_name_map.get(sender_id, sender_id),
            "type": mapped_type,
            "content": content,
            "refer_list": [],
        }

        if msg_type_raw != "1":
            extra = {
                "wechat_type": msg_type_raw,
                "wechat_sub_type": row.get("SubType"),
            }
            raw_content = row.get("StrContent")
            if raw_content:
                extra["raw_content"] = raw_content
            msg["extra"] = extra

        messages.append(msg)

    created_at = messages[0]["create_time"] if messages else datetime.now(
        tz=timezone.utc
    ).isoformat()

    payload = {
        "version": "1.0.0",
        "conversation_meta": {
            "scene": args.scene,
            "scene_desc": {},
            "name": conversation_name,
            "description": "",
            "group_id": group_id,
            "created_at": created_at,
            "default_timezone": args.default_timezone,
            "user_details": {
                sender_id: {
                    "full_name": sender_name_map.get(sender_id, sender_id),
                    "role": "user",
                }
                for sender_id in sender_ids
            },
            "tags": [],
        },
        "conversation_list": messages,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    try:
        print(f"Wrote: {output_path}")
    except UnicodeEncodeError:
        safe_path = output_path.as_posix().encode("ascii", "backslashreplace").decode(
            "ascii"
        )
        print(f"Wrote: {safe_path}")
    print(f"Messages: {len(messages)} (skipped {skipped})")
    print(f"Types: {dict(type_counter)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
