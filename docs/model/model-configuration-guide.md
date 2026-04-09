# Model Configuration Guide

SocialClaw uses three types of models, each requiring separate configuration:

| Model Type | Purpose | Call Frequency |
|-----------|---------|---------------|
| **Chat LLM** | Memory extraction, profile building, reply generation | High (2-17 calls per message) |
| **VLM** | Screenshot recognition → chat message extraction | Medium (triggered on screen change) |
| **Embedding + Rerank** | Vector search, semantic reranking | Medium (triggered during memory sync) |

All model calls in SocialClaw use the **OpenAI-compatible API protocol** (`/v1/chat/completions`), so you can use any compatible provider.

> Recommended path: use the **Settings UI** as the default model configuration entry point.  
> Keep `.env` files for bootstrap, headless runs, or advanced service-side overrides.

---

## Table of Contents

1. [Using CLIProxyAPI to Convert CLI Subscriptions to Local API](#1-using-cliproxyapi-to-convert-cli-subscriptions-to-local-api)
2. [Configuring Models in .env Files](#2-configuring-models-in-env-files)
3. [Configuring Models via UI Settings](#3-configuring-models-via-ui-settings)
4. [Differences and Recommendations Between the Two Approaches](#4-differences-and-recommendations-between-the-two-approaches)
5. [Model Selection Recommendations](#5-model-selection-recommendations)
6. [FAQ](#6-faq)

---

## 1. Using CLIProxyAPI to Convert CLI Subscriptions to Local API

If you have an active Claude Max, ChatGPT Plus/Pro, or Gemini CLI subscription, you can use [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) to expose these subscriptions as local OpenAI-compatible APIs for SocialClaw — no additional API spending required.

### What is CLIProxyAPI

CLIProxyAPI is an open-source proxy that wraps OAuth-authenticated CLI tools (Claude Code, ChatGPT Codex, Gemini CLI, Qwen Code, etc.) and exposes them as standard OpenAI/Gemini/Claude/Codex compatible APIs.

```
Your CLI subscription (Claude Max / ChatGPT Plus / Gemini)
        ↓ OAuth authentication
CLIProxyAPI (local proxy)
        ↓ OpenAI-compatible API (http://127.0.0.1:8317/v1)
SocialClaw (transparent — works like any standard API)
```

> Official docs: [help.router-for.me](https://help.router-for.me/cn/introduction/quick-start.html)

### Installation

**macOS (recommended):**

```bash
brew install cliproxyapi
```

**Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/brokechubb/cliproxyapi-installer/refs/heads/master/cliproxyapi-installer | bash
```

**Docker:**

```bash
docker run --rm -p 8317:8317 \
  -v /path/to/your/config.yaml:/CLIProxyAPI/config.yaml \
  -v /path/to/your/auth-dir:/root/.cli-proxy-api \
  eceasy/cli-proxy-api:latest
```

### Setting Up Claude Code Subscription

**Step 1: Log in to your Claude account**

```bash
cliproxyapi --claude-login
```

A browser window will open for Claude login. After authentication, tokens are saved automatically to `~/.cli-proxy-api/`.

**Step 2: Create the config file**

```bash
mkdir -p ~/.cli-proxy-api
cat > ~/.cli-proxy-api/config.yaml << 'EOF'
port: 8317
auth-dir: "~/.cli-proxy-api"
# Empty array = skip API key validation, use OAuth tokens instead
api-keys: []
debug: false
EOF
```

**Step 3: Start the service**

```bash
# macOS background service
brew services start cliproxyapi

# Or run in foreground
cliproxyapi --config ~/.cli-proxy-api/config.yaml
```

**Step 4: Verify it works**

```bash
curl -X POST http://127.0.0.1:8317/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

A successful response from Claude confirms the setup is working.

### Setting Up ChatGPT Codex Subscription

```bash
# Log in to your OpenAI account
cliproxyapi --codex-login

# No extra config needed — Codex is auto-detected by CLIProxyAPI
```

Available models: `gpt-5`, `gpt-5-codex`, etc. (depends on your subscription tier).

### Setting Up Gemini CLI

```bash
# Log in to your Google account
cliproxyapi --gemini-login
```

Available models: `gemini-2.5-pro`, `gemini-2.5-flash`, etc.

Gemini is **free** (with quota limits), making it ideal for VLM screenshot recognition.

### Multi-Model Mixed Configuration

If you have multiple subscriptions, you can use them all through a single CLIProxyAPI instance:

```yaml
# ~/.cli-proxy-api/config.yaml
port: 8317
auth-dir: "~/.cli-proxy-api"
api-keys: []
debug: false

# Model aliases for easier reference in SocialClaw
oauth-model-alias:
  claude:
    - name: "claude-sonnet-4-5-20250929"
      alias: "claude-sonnet"
  gemini-cli:
    - name: "gemini-2.5-pro"
      alias: "gemini-pro"
```

### Using CLIProxyAPI with SocialClaw

After starting CLIProxyAPI, configure SocialClaw's `.env`:

```bash
# Chat LLM — using Claude (via CLIProxyAPI)
LLM_BASE_URL=http://127.0.0.1:8317/v1
LLM_API_KEY=dummy
LLM_MODEL=claude-sonnet-4-5-20250929

# VLM — using Gemini (via CLIProxyAPI)
SOCIAL_COPILOT_VISION_BASE_URL=http://127.0.0.1:8317/v1
SOCIAL_COPILOT_VISION_API_KEY=dummy
SOCIAL_COPILOT_VISION_MODEL=gemini-2.5-pro

# Assistant — using Claude (via CLIProxyAPI)
SOCIAL_COPILOT_ASSISTANT_BASE_URL=http://127.0.0.1:8317/v1
SOCIAL_COPILOT_ASSISTANT_API_KEY=dummy
SOCIAL_COPILOT_ASSISTANT_MODEL=claude-sonnet-4-5-20250929
```

> **Note**: `LLM_API_KEY=dummy` is sufficient — CLIProxyAPI uses your OAuth tokens for authentication, not the API key value.

---

## 2. Configuring Models in .env Files

Use this path when you want headless startup, service-side overrides, or a fully environment-driven deployment.
For ordinary desktop usage, the recommended path is still the Settings UI.

### Config File Locations

```
SocialClaw/
├── .env                    # Main config (affects all services)
├── .env.example            # Template file
└── memory/evermemos/
    ├── env.template        # EverMemOS-specific config template
    └── .env                # EverMemOS-specific config (overrides main if present)
```

### Configuration Priority

```
memory/evermemos/.env (local) > root .env (global) > code defaults
```

If `memory/evermemos/.env` exists, EverMemOS uses it; otherwise it falls back to the root `.env`.

### Key Configuration Variables

**Chat LLM (memory pipeline + reply suggestions):**

```bash
LLM_BASE_URL=https://your-provider.com/v1    # API endpoint
LLM_API_KEY=sk-your-key                        # API key
LLM_MODEL=your-model-name                      # Model name
LLM_TEMPERATURE=0.3                            # Generation temperature
LLM_MAX_TOKENS=32768                           # Max tokens per response
LLM_MAX_CONCURRENT=5                           # Global concurrency limit (prevents 429)
```

**Assistant model (reply suggestions):**

```bash
SOCIAL_COPILOT_ASSISTANT_BASE_URL=https://...  # Falls back to LLM_BASE_URL if empty
SOCIAL_COPILOT_ASSISTANT_API_KEY=sk-...         # Falls back to LLM_API_KEY if empty
SOCIAL_COPILOT_ASSISTANT_MODEL=your-model       # Model name
```

**VLM vision model (screenshot recognition):**

```bash
SOCIAL_COPILOT_VISION_BASE_URL=https://...     # Falls back to LLM_BASE_URL if empty
SOCIAL_COPILOT_VISION_API_KEY=sk-...            # Falls back to LLM_API_KEY if empty
SOCIAL_COPILOT_VISION_MODEL=your-vlm-model      # VLM model name
```

### Fallback Chain

To avoid redundant configuration, Assistant and VLM `BASE_URL` / `API_KEY` support **fallback**:

```
SOCIAL_COPILOT_ASSISTANT_BASE_URL → if empty → uses LLM_BASE_URL
SOCIAL_COPILOT_ASSISTANT_API_KEY  → if empty → uses LLM_API_KEY
SOCIAL_COPILOT_VISION_BASE_URL    → if empty → uses LLM_BASE_URL
SOCIAL_COPILOT_VISION_API_KEY     → if empty → uses LLM_API_KEY
```

If all your models go through the same API service (e.g., all via CLIProxyAPI), you only need to set `LLM_*` plus the `MODEL` name for each.

---

## 3. Configuring Models via UI Settings

The Electron frontend provides a settings panel for changing model configuration without editing `.env` files.

### Accessing the Settings

After launching the frontend, click the **Settings** button in the UI.

### What You Can Configure

The settings panel supports:
- **EverMemOS API** URL
- **Visual Monitor API** URL
- **Owner User ID** (test account)
- **Assistant model** (base_url, api_key, model)
- **Vision model** (base_url, api_key, model)
- **General LLM model** (base_url, api_key, model, temperature, max_tokens)

### Sync Mechanism

When you save settings in the UI, they are **synced in real time** to both backends:

```
UI Save
├── PUT /monitor/config → Visual Monitor (assistant, vision models)
└── PUT /api/v1/copilot/config/llm → EverMemOS (LLM model)
```

- Changes take effect **immediately**, no service restart needed
- If sync fails, the frontend displays an error
- Settings are persisted in the frontend's local storage and restored on next launch

---

## 4. Differences and Recommendations Between the Two Approaches

| Dimension | .env File | UI Settings |
|-----------|----------|-------------|
| **When it takes effect** | Loaded at service startup | Real-time, no restart needed |
| **Scope** | All variables (DB, Redis, embedding, etc.) | Model-related only (base_url, api_key, model) |
| **Persistence** | File system, tracked via .env.example | Frontend localStorage |
| **Priority** | Base defaults | Overrides .env model config at runtime |
| **Best for** | Initial deployment, infrastructure config | Runtime tuning, switching models for testing |
| **Team collaboration** | Each person copies .env.example with their values | Each person's UI is independent |

### Recommended Workflow

**First-time deployment:**

1. Copy `.env.example` to `.env` and fill in all values
2. Start all services
3. Verify connectivity in the UI

**Day-to-day use:**

- Switch models or tune parameters → change in UI, no restart
- Change DB addresses, concurrency limits, etc. → edit `.env`, restart services

**Team collaboration:**

- Each team member copies `.env.example` to `.env` with their own API keys
- Team members using CLIProxyAPI only need to change `LLM_BASE_URL` to their local proxy address

---

## 5. Model Selection Recommendations

### By Use Case

| Use Case | Recommended Models | Reason |
|----------|-------------------|--------|
| Chat LLM (memory + suggestions) | Claude Sonnet 4.5 / GPT-4.1 / DeepSeek V3 | Strong instruction following and Chinese capability |
| VLM (screenshot recognition) | Gemini 2.5 Pro / Gemini 2.5 Flash | Free tier available, strong vision capability |
| Embedding | nomic-embed-text (local Ollama) | Free, 768 dimensions, good quality |
| Rerank | BAAI/bge-reranker-v2-m3 (SiliconFlow) | Free tier available, optimized for Chinese |

### Cost Optimization

| Scenario | Setup | Monthly Cost |
|----------|-------|-------------|
| Fully free | Gemini (CLIProxyAPI) + Ollama + SiliconFlow | $0 |
| Low cost | DeepSeek V3 (API) + Gemini VLM (CLIProxyAPI) + Ollama | ~$5-20 |
| Best experience | Claude Sonnet (CLIProxyAPI) + Gemini VLM + Ollama | Max subscription fee |

### Performance Tuning

```bash
# Lower latency: reduce max_tokens, increase temperature
SOCIAL_COPILOT_ASSISTANT_MAX_TOKENS=400
SOCIAL_COPILOT_ASSISTANT_TEMPERATURE=0.6

# Higher suggestion quality: increase max_tokens, lower temperature
SOCIAL_COPILOT_ASSISTANT_MAX_TOKENS=1200
SOCIAL_COPILOT_ASSISTANT_TEMPERATURE=0.3

# Control LLM concurrency (reduce when hitting 429 frequently)
LLM_MAX_CONCURRENT=3
```

---

## 6. FAQ

### CLIProxyAPI

**Q: `cliproxyapi --claude-login` shows authentication failure?**

Make sure your Claude account has a Claude Pro/Max subscription. Free accounts do not support CLI access.

**Q: API returns `Invalid API key`?**

Check that `api-keys` in `config.yaml` is set to an empty array `[]`. If you set specific keys, requests must match one of them.

**Q: Model name returns `Model not found`?**

CLIProxyAPI requires dated full model names, e.g., `claude-sonnet-4-5-20250929` instead of `claude-sonnet-4.5`. List available models:

```bash
curl http://127.0.0.1:8317/v1/models | python -m json.tool
```

**Q: Token expired?**

Re-authenticate: `cliproxyapi --claude-login`, then restart the service.

**Q: Can EverMemOS running in Docker access CLIProxyAPI on the host?**

Yes. If the EverMemOS API itself is running inside Docker, use `host.docker.internal` instead of `127.0.0.1`:

```bash
LLM_BASE_URL=http://host.docker.internal:8317/v1
```

If you use the default SocialClaw startup scripts, EverMemOS runs on the host, so keep `127.0.0.1`.

### Model Configuration

**Q: Changes to .env don't take effect?**

You need to restart the corresponding service. Both EverMemOS and Visual Monitor load `.env` at startup.

**Q: UI model changes still use the old model?**

Check whether the UI shows sync success. If the backend isn't running, UI changes won't be applied.

**Q: Can all models share one API key?**

Yes. If your API provider supports using one key for different models, just set `LLM_BASE_URL` and `LLM_API_KEY`, then set the `MODEL` name for each (Assistant and VLM will fall back automatically).

**Q: No VLM model available?**

If you can't find a usable VLM, switch to OCR mode in `visual_monitor.yaml`:

```yaml
vision:
  mode: ocr  # Change from vlm_structured to ocr
```

OCR mode uses local Tesseract — no LLM calls needed, but recognition accuracy is lower.

---

## References

- [CLIProxyAPI Official Docs](https://help.router-for.me/cn/introduction/quick-start.html)
- [CLIProxyAPI GitHub](https://github.com/router-for-me/CLIProxyAPI)
- [CLIProxyAPI Config Example](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)
- [CLIProxyAPI: Claude Max to API Tutorial](https://antran.app/blogs/2025/claude_code_max_api/)
