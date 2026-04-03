"""Logging helpers for safer, more readable error details."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from uuid import uuid4
from typing import Any


def summarize_text(text: Any, limit: int = 800) -> str:
    """Return a shortened string for logs while preserving both head and tail."""
    if text is None:
        return "<none>"
    if limit <= 0:
        return ""
    text = str(text)
    if len(text) <= limit:
        return text

    head_len = int(limit * 0.6)
    tail_len = int(limit * 0.3)
    if head_len + tail_len >= limit:
        head_len = limit // 2
        tail_len = limit - head_len

    head = text[:head_len]
    tail = text[-tail_len:] if tail_len > 0 else ""
    truncated = len(text) - head_len - tail_len
    return f"{head} ... <truncated {truncated} chars> ... {tail}"


def summarize_json(obj: Any, limit: int = 800) -> str:
    """Serialize to JSON then truncate for logs."""
    try:
        payload = json.dumps(obj, ensure_ascii=True, default=str)
    except Exception:
        payload = str(obj)
    return summarize_text(payload, limit)


def dump_llm_artifacts(
    tag: str,
    *,
    prompt: str | None = None,
    response: str | None = None,
    meta: dict[str, Any] | None = None,
    enabled_env: str = "LLM_DUMP_FAILED_JSON",
    base_dir_env: str = "LLM_DUMP_DIR",
    default_dir: str = "logs/llm_failures",
) -> str | None:
    """Persist LLM prompt/response for debugging parse failures.

    Controlled by env:
      - LLM_DUMP_FAILED_JSON=0/false/no to disable (default: enabled)
      - LLM_DUMP_DIR to customize output directory (default: logs/llm_failures)
    """
    enabled = os.getenv(enabled_env, "1").strip().lower()
    if enabled in {"0", "false", "no"}:
        return None

    base_dir = os.getenv(base_dir_env, default_dir)
    Path(base_dir).mkdir(parents=True, exist_ok=True)

    safe_tag = re.sub(r"[^A-Za-z0-9_.-]+", "_", tag or "llm")
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_{safe_tag}_{uuid4().hex[:8]}.txt"
    path = Path(base_dir) / filename

    header = {
        "tag": tag,
        "timestamp_utc": timestamp,
        "prompt_len": len(prompt or ""),
        "response_len": len(response or ""),
        "meta": meta or {},
    }

    with open(path, "w", encoding="utf-8") as handle:
        handle.write("### META\n")
        handle.write(json.dumps(header, ensure_ascii=True, indent=2))
        handle.write("\n\n### PROMPT\n")
        handle.write(prompt or "")
        handle.write("\n\n### RESPONSE\n")
        handle.write(response or "")

    return str(path)


def dump_llm_success(
    tag: str,
    *,
    prompt: str | None = None,
    response: str | None = None,
    meta: dict[str, Any] | None = None,
) -> str | None:
    """Persist successful LLM prompt/response for comparison."""
    return dump_llm_artifacts(
        tag,
        prompt=prompt,
        response=response,
        meta=meta,
        enabled_env="LLM_DUMP_SUCCESS_JSON",
        base_dir_env="LLM_SUCCESS_DUMP_DIR",
        default_dir="logs/llm_success",
    )


def dump_profile_llm_artifacts(
    tag: str,
    *,
    prompt: str | None = None,
    response: str | None = None,
    meta: dict[str, Any] | None = None,
) -> str | None:
    """Persist profile LLM prompt/response separately for inspection.

    Writes one file per invocation under the EverMemOS project:
      D:/SC/EverMemOS/logs/profile_llm
    """
    enabled = os.getenv("LLM_DUMP_PROFILE", "1").strip().lower()
    if enabled in {"0", "false", "no"}:
        return None

    project_root = Path(__file__).resolve().parents[2]
    base_dir = project_root / "logs" / "profile_llm"
    base_dir.mkdir(parents=True, exist_ok=True)

    safe_tag = re.sub(r"[^A-Za-z0-9_.-]+", "_", tag or "profile")
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    stem = f"{timestamp}_{safe_tag}_{uuid4().hex[:8]}"

    header = {
        "tag": tag,
        "timestamp_utc": timestamp,
        "prompt_len": len(prompt or ""),
        "response_len": len(response or ""),
        "meta": meta or {},
    }

    artifact_path = base_dir / f"{stem}.txt"

    with open(artifact_path, "w", encoding="utf-8") as handle:
        handle.write("### META\n")
        handle.write(json.dumps(header, ensure_ascii=True, indent=2))
        handle.write("\n\n### PROMPT\n")
        handle.write(prompt or "")
        handle.write("\n\n### RESPONSE\n")
        handle.write(response or "")

    return str(artifact_path)


def dump_embedding_context(
    tag: str,
    *,
    prompt: str,
    meta: dict[str, Any] | None = None,
) -> str | None:
    """Persist embedding context for debugging failed vectorization."""
    base_dir = Path(r"D:\EverMemOS\logs\context_to_emb")
    base_dir.mkdir(parents=True, exist_ok=True)

    safe_tag = re.sub(r"[^A-Za-z0-9_.-]+", "_", tag or "embedding")
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_{safe_tag}_{uuid4().hex[:8]}.txt"
    path = base_dir / filename

    header = {
        "tag": tag,
        "timestamp_utc": timestamp,
        "prompt_len": len(prompt or ""),
        "meta": meta or {},
    }

    with open(path, "w", encoding="utf-8") as handle:
        handle.write("### META\n")
        handle.write(json.dumps(header, ensure_ascii=True, indent=2))
        handle.write("\n\n### PROMPT\n")
        handle.write(prompt or "")

    return str(path)
