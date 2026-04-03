# Social Copilot Visual Monitor Backend

This package contains the standalone Python backend for realtime visual monitoring.

## Included capabilities
- Adaptive capture scheduler
- Two-stage frame change detection
- Whole-window WeChat capture with conservative same-session judgment
- LiteLLM / OpenAI-compatible structured VLM extraction
- Optional foreground app gate (`WeChat` frontmost check) and window-based auto ROI
- Structured message assembly and event emission
- FastAPI endpoints (`/health`, `/metrics`, `/monitor/*`, `/events/*`)
- Debug frame storage with retention cleanup

## VLM configuration

- The active runtime is VLM-only.
- The backend captures the full frontmost WeChat window and asks the VLM to return structured JSON for:
  - active conversation title
  - visible messages
  - window-level time context
  - message-level time anchors
- For manual debugging / 联调, enable `monitor.frame_cache.testing_mode=true` to preserve full visual cache artifacts instead of cleaning them up after processing.
- When working inside the `social_copilot/` package, configure via `visual_monitor/config/local/visual_monitor.yaml`.
- From the `SocialClaw` project root, the same file is `social_copilot/visual_monitor/config/local/visual_monitor.yaml`.
- API keys should come from environment variables (for example `SOCIAL_COPILOT_VLM_API_KEY`), not hardcoded in files.
- Redesign spec:
  - `docs/specs/2026-03-28-visual-monitor-vlm-redesign.md`

## LiteLLM VLM structured extraction

- For structured chat extraction benchmarking with an OpenAI-compatible VLM endpoint, use:
  - `scripts/benchmark_live_litellm_vlm_structured.py`
- Typical endpoint/model combo:
  - base URL: `https://litellm.sii.sh.cn/v1`
  - model: `sii-Qwen3-VL-235B-A22B-Instruct`
- Output artifacts are written under `test/vlm_runs/<run_tag>/`.
- Framework design note:
  - `docs/plans/2026-02-27-litellm-vlm-structured-chat-framework.md`

## Run tests

```bash
python -m pytest social_copilot/tests -q
```

## Local run (development)

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw
uvicorn social_copilot.visual_monitor.app:app --host 127.0.0.1 --port 18777 --reload
```

Windows PowerShell:

```powershell
Set-Location /Users/enigma/Documents/Social_Copilot/SocialClaw
python -m uvicorn social_copilot.visual_monitor.app:app --host 127.0.0.1 --port 18777 --reload
```
