import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


SOURCE_FILE = Path("data/user_dialogues_seed.txt")
OUT_DIR = Path("my_chat/longterm_persona")
OUT_DIR.mkdir(parents=True, exist_ok=True)

OWNER_ID = "wxid_fcekh048yglj22"
OWNER_NAME = "李星"

SECTION_CONFIG = {
    "实习上级": {
        "key": "mentor",
        "other_name": "王骁",
        "other_id": "wxid_mentor_wangxiao001",
        "start": "2024-09-02T08:30:00+00:00",
    },
    "学校导师": {
        "key": "advisor",
        "other_name": "陈老师",
        "other_id": "wxid_teacher_chen001",
        "start": "2024-09-03T09:00:00+00:00",
    },
    "母亲": {
        "key": "parent",
        "other_name": "妈妈",
        "other_id": "wxid_mom_li001",
        "start": "2024-09-04T10:00:00+00:00",
    },
    "室友": {
        "key": "roommate",
        "other_name": "周周",
        "other_id": "wxid_roommate_zhouzhou001",
        "start": "2024-09-05T11:00:00+00:00",
    },
    "男朋友": {
        "key": "boyfriend",
        "other_name": "阿远",
        "other_id": "wxid_bf_ayuan001",
        "start": "2024-09-06T12:00:00+00:00",
    },
}


def parse_sections(text: str):
    sections: dict[str, list[tuple[str, str]]] = {}
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("===") and line.endswith("==="):
            current = line.strip("=").strip()
            sections[current] = []
            continue
        if current is None:
            continue
        if ":" not in line:
            continue
        speaker, content = line.split(":", 1)
        sections[current].append((speaker.strip(), content.strip()))
    return sections


def build_meta(title: str, other_name: str, other_id: str, group_id: str, created_at: str):
    return {
        "version": "1.0.0",
        "conversation_meta": {
            "scene": "private",
            "scene_desc": {
                "owner_user_name": OWNER_NAME,
                "owner_user_id": OWNER_ID,
            },
            "name": f"Chat with {other_name} - {title}",
            "description": f"{title} longterm persona dataset",
            "group_id": group_id,
            "created_at": created_at,
            "default_timezone": "UTC",
            "user_details": {
                OWNER_ID: {"full_name": OWNER_NAME, "role": "user"},
                other_id: {"full_name": other_name, "role": "user"},
            },
            "tags": ["longterm", "persona", "from-user-seed"],
        },
    }


def build_rows(messages, start_time: str, base_id: int, other_id: str, other_name: str):
    t0 = datetime.fromisoformat(start_time)
    out = []
    for i, (speaker, content) in enumerate(messages):
        sender = OWNER_ID if speaker == OWNER_NAME else other_id
        sender_name = OWNER_NAME if sender == OWNER_ID else other_name
        out.append(
            {
                "message_id": str(base_id + i),
                "create_time": (t0 + timedelta(minutes=2 * i)).isoformat(),
                "sender": sender,
                "sender_name": sender_name,
                "type": "text",
                "content": content,
                "refer_list": [],
            }
        )
    return out


def main():
    text = SOURCE_FILE.read_text(encoding="utf-8")
    sections = parse_sections(text)

    for section_name, cfg in SECTION_CONFIG.items():
        if section_name not in sections:
            raise ValueError(f"Missing section: {section_name}")

        messages = sections[section_name]
        if len(messages) < 120:
            raise ValueError(f"Section {section_name} has only {len(messages)} messages (<120)")

        group_id = f"chat_{OWNER_ID}_{cfg['other_id']}_longterm_seed"
        doc = build_meta(
            title=section_name,
            other_name=cfg["other_name"],
            other_id=cfg["other_id"],
            group_id=group_id,
            created_at=cfg["start"],
        )
        doc["conversation_list"] = build_rows(
            messages=messages,
            start_time=cfg["start"],
            base_id=100000 * (list(SECTION_CONFIG).index(section_name) + 1),
            other_id=cfg["other_id"],
            other_name=cfg["other_name"],
        )

        out_name = f"{cfg['key']}_longterm_seed_{len(messages)}.json"
        (OUT_DIR / out_name).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{out_name}\t{len(messages)}")


if __name__ == "__main__":
    main()
