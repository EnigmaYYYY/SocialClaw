#!/usr/bin/env python3
import argparse
import csv
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


TYPE_TEXT = "1"


def parse_epoch(value: str):
    if not value:
        return None
    try:
        ts = int(value)
    except ValueError:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def parse_str_time(value: str):
    if not value:
        return None
    try:
        dt = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat()


def pick_name(row, sender_id: str) -> str:
    remark = (row.get("Remark") or "").strip()
    if remark:
        return remark
    nickname = (row.get("NickName") or "").strip()
    if nickname:
        return nickname
    return sender_id


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert group chat CSV exports to GroupChatFormat JSON (text-only)."
    )
    parser.add_argument("--input-dir", required=True, help="Input folder with CSV files")
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Output folder (default: same as input)",
    )
    parser.add_argument(
        "--scene",
        default="group",
        help="Conversation scene to write into conversation_meta (default: group)",
    )
    parser.add_argument(
        "--default-timezone",
        default="UTC",
        help="Default timezone for conversation_meta (default: UTC)",
    )
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir) if args.output_dir else input_dir

    csv_files = sorted(input_dir.glob("*.csv"))
    if not csv_files:
        raise SystemExit("No CSV files found.")

    for csv_path in csv_files:
        rows = []
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                rows.append(row)

        if not rows:
            print(f"Skip empty: {csv_path}")
            continue

        sender_name_map = {}
        for row in rows:
            sender_id = (row.get("Sender") or "").strip()
            if not sender_id:
                continue
            sender_name_map[sender_id] = pick_name(row, sender_id)

        sender_ids = sorted(sender_name_map.keys())
        group_id = f"chat_{csv_path.stem}"
        group_name = csv_path.stem

        messages = []
        type_counter = Counter()
        skipped = 0
        for idx, row in enumerate(rows, start=1):
            msg_type_raw = (row.get("Type") or "").strip()
            if msg_type_raw != TYPE_TEXT:
                skipped += 1
                continue

            sender_id = (row.get("Sender") or "").strip()
            if not sender_id:
                skipped += 1
                continue

            content = (row.get("StrContent") or "").strip()
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
                "type": "text",
                "content": content,
                "refer_list": [],
            }
            messages.append(msg)
            type_counter["text"] += 1

        created_at = messages[0]["create_time"] if messages else datetime.now(
            tz=timezone.utc
        ).isoformat()

        payload = {
            "version": "1.0.0",
            "conversation_meta": {
                "scene": args.scene,
                "scene_desc": {},
                "name": f"Group Chat: {group_name}",
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

        output_path = output_dir / f"{csv_path.stem}.group_chat.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

        try:
            print(f"Wrote: {output_path}")
        except UnicodeEncodeError:
            safe_path = (
                output_path.as_posix()
                .encode("ascii", "backslashreplace")
                .decode("ascii")
            )
            print(f"Wrote: {safe_path}")
        print(f"  Messages: {len(messages)} (skipped {skipped})")
        print(f"  Types: {dict(type_counter)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
