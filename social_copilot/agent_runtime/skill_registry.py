from __future__ import annotations

from pathlib import Path

from social_copilot.agent_runtime.models import SkillDefinition


class SkillRegistry:
    def __init__(self, root_dir: str | Path | None = None) -> None:
        if root_dir is None:
            root_dir = Path(__file__).resolve().parents[2] / ".agents" / "skills"
        self._root_dir = Path(root_dir)
        self._cache: list[SkillDefinition] | None = None

    def list_skills(self, exclude_skill_ids: set[str] | None = None) -> list[SkillDefinition]:
        skills = list(self._load_all_skills())
        if not exclude_skill_ids:
            return skills
        return [item for item in skills if item.skill_id not in exclude_skill_ids]

    def get_skill(self, skill_id: str) -> SkillDefinition | None:
        normalized = skill_id.strip()
        if not normalized:
            return None
        for item in self._load_all_skills():
            if item.skill_id == normalized:
                return item
        return None

    def _load_all_skills(self) -> list[SkillDefinition]:
        if self._cache is not None:
            return list(self._cache)
        if not self._root_dir.exists():
            self._cache = []
            return []

        skills: list[SkillDefinition] = []
        for skill_dir in sorted(path for path in self._root_dir.iterdir() if path.is_dir()):
            skill_path = skill_dir / "SKILL.md"
            if not skill_path.exists():
                continue
            raw = skill_path.read_text(encoding="utf-8").strip()
            if not raw:
                continue
            metadata, body = _split_frontmatter(raw)
            name = str(metadata.get("name", "")).strip() or skill_dir.name
            description = str(metadata.get("description", "")).strip() or _extract_description(body)
            skills.append(
                SkillDefinition(
                    skill_id=skill_dir.name,
                    name=name,
                    description=description,
                    body=body.strip(),
                    path=skill_path,
                )
            )
        self._cache = skills
        return list(skills)


def _split_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    if not raw.startswith("---\n"):
        return {}, raw
    end_marker = "\n---\n"
    end = raw.find(end_marker, 4)
    if end < 0:
        return {}, raw
    frontmatter_text = raw[4:end].strip()
    body = raw[end + len(end_marker) :]
    metadata: dict[str, str] = {}
    lines = frontmatter_text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if ":" not in line:
            index += 1
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value in {"|", ">"}:
            block: list[str] = []
            index += 1
            while index < len(lines):
                next_line = lines[index]
                if next_line.startswith((" ", "\t")) or not next_line.strip():
                    block.append(next_line.lstrip(" \t").rstrip())
                    index += 1
                    continue
                break
            metadata[key] = "\n".join(block).strip()
            continue
        metadata[key] = value.strip('"').strip("'")
        index += 1
    return metadata, body


def _extract_description(body: str) -> str:
    for line in body.splitlines():
        text = line.strip().lstrip("#").strip()
        if text:
            return text
    return ""
