import argparse
import json
from copy import deepcopy
from pathlib import Path

def build_outputs(path, length, positions):
    data = json.loads(path.read_text(encoding="utf-8"))
    messages = [m for m in data.get("conversation_list", []) if m.get("type") == "text"]
    total = len(messages)
    if total < length:
        print(f"Skip {path}: only {total} text messages")
        return

    name = path.name
    suffix = ".group_chat.json"
    base = name[:-len(suffix)] if name.endswith(suffix) else path.stem
    meta = data.get("conversation_meta", {})
    base_group_id = meta.get("group_id", base)
    base_name = meta.get("name") or base

    for pct in positions:
        p = pct / 100.0
        start = int((total - length) * p)
        if start < 0:
            start = 0
        if start > total - length:
            start = max(0, total - length)

        segment = messages[start : start + length]
        out = deepcopy(data)
        out["conversation_list"] = segment

        segment_suffix = f"demo-text-100-p{pct}"
        out_meta = out.setdefault("conversation_meta", {})
        out_meta["name"] = f"{base_name} - {segment_suffix}"
        out_meta["description"] = f"Demo subset (100 messages at {pct}% position, text-only)"
        out_meta["group_id"] = f"{base_group_id}_{segment_suffix.replace('-', '_')}"
        if segment:
            out_meta["created_at"] = segment[0].get("create_time") or out_meta.get("created_at")

        output_path = path.with_name(f"{base}_text_100_p{pct}.json")
        output_path.write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"Wrote: {output_path}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--length", type=int, default=100)
    parser.add_argument("--positions", default="25,50,75")
    args = parser.parse_args()

    positions = []
    for item in args.positions.split(","):
        item = item.strip()
        if not item:
            continue
        positions.append(int(item))

    for raw in args.input:
        build_outputs(Path(raw), args.length, positions)

if __name__ == "__main__":
    main()
