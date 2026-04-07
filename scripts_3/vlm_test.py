"""
VLM batch test script.

Usage:
    cd D:\\SC_project\\SocialClaw
    D:\\conda_envs\\emos2\\python.exe scripts_3\\vlm_test.py
    D:\\conda_envs\\emos2\\python.exe scripts_3\\vlm_test.py --image path\\to\\image.png
    D:\\conda_envs\\emos2\\python.exe scripts_3\\vlm_test.py --models gpt-4o,gpt-4.1
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from social_copilot.visual_monitor.adapters.vision_litellm_structured import (
    DEFAULT_WECHAT_STRUCTURED_PROMPT,
)
from social_copilot.visual_monitor.core.vlm_structured_parser import parse_vlm_structured_content

BASE_URL = "https://api.kr777.top/v1"
API_KEY = "sk-sY5kQUbNWBsdEQyO9u4eInW82GDnKlFB9cTT0ifzGNhzn626"
OUT_DIR = ROOT / "logs" / "vlm_test"
TIMEOUT = 60.0
MAX_TOKENS = 2000


def fetch_models() -> list[str]:
    print("Fetching model list...")
    with httpx.Client(timeout=15.0) as client:
        resp = client.get(
            f"{BASE_URL}/models",
            headers={"Authorization": f"Bearer {API_KEY}"},
        )
        resp.raise_for_status()
        data = resp.json()
    models = [m["id"] for m in data.get("data", [])]
    print(f"  Found {len(models)} models.")
    return models


def find_latest_image() -> Path:
    cache_dir = ROOT / "social_copilot" / "cache"
    pngs = sorted(cache_dir.rglob("*.png"))
    if not pngs:
        raise FileNotFoundError(f"No PNG files found under {cache_dir}")
    return pngs[-1]


def extract_content(message: dict) -> str:
    content = message.get("content", "") or ""
    if isinstance(content, list):
        chunks = [
            str(item.get("text", ""))
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        content = "\n".join(chunks).strip()
    else:
        content = str(content).strip()
    if not content:
        content = str(message.get("reasoning_content", "") or "").strip()
    return content


def test_model(model_id: str, image_bytes: bytes) -> dict:
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "model": model_id,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": DEFAULT_WECHAT_STRUCTURED_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                ],
            }
        ],
        "temperature": 0.0,
        "max_tokens": MAX_TOKENS,
        "stream": False,
    }
    url = f"{BASE_URL}/chat/completions"
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
        "User-Agent": "social-copilot-vlm-test/1.0",
    }

    start = time.perf_counter()
    status_code = None
    raw_response = ""
    error = ""

    try:
        with httpx.Client(timeout=TIMEOUT, trust_env=False) as client:
            resp = client.post(url, json=payload, headers=headers)
            status_code = resp.status_code
            raw_response = resp.text
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        error = f"HTTP {exc.response.status_code}: {exc.response.text[:300]}"
    except Exception as exc:
        error = str(exc)

    roundtrip_ms = (time.perf_counter() - start) * 1000.0

    raw_content = ""
    parse_ok = False
    reasoning_tokens = None

    if raw_response:
        try:
            resp_json = json.loads(raw_response)
            choices = resp_json.get("choices", [])
            if choices:
                raw_content = extract_content(choices[0].get("message", {}))
            usage = resp_json.get("usage", {})
            details = usage.get("completion_tokens_details", {}) or {}
            reasoning_tokens = details.get("reasoning_tokens")
        except Exception:
            pass

    if raw_content:
        _, parse_ok, _ = parse_vlm_structured_content(raw_content)

    return {
        "model": model_id,
        "status_code": status_code,
        "parse_ok": parse_ok,
        "reasoning_tokens": reasoning_tokens,
        "roundtrip_ms": round(roundtrip_ms, 1),
        "error": error,
        "raw_content": raw_content,
        "raw_response": raw_response,
    }


def safe_filename(model_id: str) -> str:
    return re.sub(r"[^\w\-.]", "_", model_id)


def main() -> None:
    parser = argparse.ArgumentParser(description="Batch VLM test against kr777.top")
    parser.add_argument("--image", type=str, default=None, help="Path to test PNG image")
    parser.add_argument("--models", type=str, default=None, help="Comma-separated model IDs to test")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Resolve image
    if args.image:
        image_path = Path(args.image)
    else:
        image_path = find_latest_image()
    print(f"Test image: {image_path}  ({image_path.stat().st_size // 1024} KB)")
    image_bytes = image_path.read_bytes()

    # Resolve model list
    if args.models:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    else:
        models = fetch_models()

    print(f"\nTesting {len(models)} models...\n")

    results: list[dict] = []
    for i, model_id in enumerate(models, 1):
        print(f"[{i}/{len(models)}] {model_id} ...", end=" ", flush=True)
        result = test_model(model_id, image_bytes)
        results.append(result)

        out_path = OUT_DIR / f"{safe_filename(model_id)}.json"
        out_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        status = "OK" if result["parse_ok"] else ("ERR" if result["error"] else "EMPTY")
        rt = result["reasoning_tokens"]
        print(
            f"{status}  parse_ok={result['parse_ok']}  "
            f"reasoning_tokens={rt}  "
            f"{result['roundtrip_ms']:.0f}ms"
            + (f"  [{result['error'][:60]}]" if result["error"] else "")
        )

    # Summary table
    print("\n" + "=" * 90)
    print(f"{'Model':<40} {'OK':<5} {'Reason.Tok':<12} {'ms':<8} Error")
    print("-" * 90)
    for r in results:
        print(
            f"{r['model']:<40} {str(r['parse_ok']):<5} {str(r['reasoning_tokens']):<12} "
            f"{r['roundtrip_ms']:<8.0f} {r['error'][:40]}"
        )
    print("=" * 90)
    print(f"\nResults saved to: {OUT_DIR}")


if __name__ == "__main__":
    main()
