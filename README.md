
AI-powered social copilot that watches your chat screens, builds memory profiles, and suggests replies in real time.

## What It Does

SocialClaw sits alongside your messaging apps (WeChat, etc.) and provides three capabilities:

1. **Screen Monitoring** — Continuously captures and detects chat screen changes via VLM (Vision Language Model), extracting structured messages in real time
2. **Memory & Profile System** — Builds and maintains long-term memory, contact profiles, episodic summaries, and predictive insights from your conversations via EverMemOS
3. **Reply Suggestions** — Generates context-aware reply suggestions using your conversation history, contact profiles, and memory context

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Visual Monitor (VLM Process)                           │
│  Screen Capture (1-5 FPS) → Change Detection → VLM     │
│  → Structured Messages → Event Bus (SQLite)             │
└────────────────────────┬────────────────────────────────┘
                         │ Frontend polls /events/poll
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Electron Frontend (Coordinator)                        │
│                                                         │
│  New messages detected →                                │
│    1. Call EverMemOS /process-chat (memory sync)        │
│    2. Call /assistant/suggestions (reply generation)     │
│                                                         │
│  Gating: skips if previous round in-flight or           │
│          awaiting user action                           │
└──────────┬──────────────────────────────┬───────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐   ┌──────────────────────────────┐
│  EverMemOS           │   │  Reply Suggestion            │
│  POST /process-chat  │   │  /assistant/suggestions      │
│                      │   │                              │
│  Parallel execution: │   │  Try EverMemOS reply API     │
│  ├ Memory sync       │   │  → fallback to local model   │
│  └ Profile update    │   │                              │
│  ↓ (after sync)      │   │                              │
│  Reply suggestion    │   │                              │
└──────────────────────┘   └──────────────────────────────┘
```

**Key design decisions:**
- Memory sync and profile detection run **in parallel** (via `asyncio.create_task`)
- Memory sync has 60s timeout protection, reply suggestion has 30s timeout
- LLM calls are globally rate-limited via `asyncio.Semaphore` (default 5 concurrent)
- Visual Monitor → EverMemOS message format is auto-converted

## Prerequisites

| Dependency | Version | Notes |
|-----------|---------|-------|
| Python | 3.12 | EverMemOS requires >=3.12,<3.13 |
| Node.js | >=20 | Electron frontend |
| Docker | Latest | For EverMemOS data stores |
| Conda or uv | Any | Python environment management |

**LLM services you need:**
- A chat completion API (OpenAI-compatible) for memory extraction, profile building, and reply generation
- A VLM API for screenshot-to-text recognition
- An embedding API for vector search (e.g., local Ollama with nomic-embed-text)
- A rerank API (e.g., SiliconFlow with BAAI/bge-reranker-v2-m3)

## Quick Start

### 1. Clone & Configure

```bash
git clone <your-repo-url> SocialClaw
cd SocialClaw

# Create environment config from template
cp .env.example .env
# Edit .env with your actual API keys and service URLs
```

### 2. Start EverMemOS Data Stores

```bash
cd memory/evermemos
docker-compose up -d
docker-compose ps   # Verify all services are healthy
```

This starts:
- MongoDB (27017) — profiles, conversation metadata
- Elasticsearch (19200) — full-text search
- Milvus (19530) — vector similarity search
- Redis (6379) — caching, pending boundaries

### 3. Start EverMemOS API

```bash
cd memory/evermemos

# Copy EverMemOS config if not already done
cp env.template .env
# Edit .env — at minimum set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
# If running services locally, change host.docker.internal → 127.0.0.1

uv sync
uv run python src/run.py --host 127.0.0.1 --port 1995
```

Verify:
```bash
curl http://127.0.0.1:1995/health
```

### 4. Start Visual Monitor API

```bash
cd SocialClaw

# Create Visual Monitor config
cp social_copilot/visual_monitor/config/visual_monitor.example.yaml \
   social_copilot/visual_monitor/config/visual_monitor.yaml
# Edit the yaml — set VLM model, assistant model, and API keys

# Activate Python environment (conda or venv with requirements installed)
pip install -r social_copilot/visual_monitor/requirements.txt

python -m uvicorn social_copilot.visual_monitor.app:app \
  --host 127.0.0.1 --port 18777 --reload
```

Verify:
```bash
curl http://127.0.0.1:18777/health
curl http://127.0.0.1:18777/monitor/status
```

### 5. Start Electron Frontend

```bash
cd social_copilot/frontend
npm install
npm run dev
```

### 6. Configure in UI

On first launch, open the Settings panel and configure:
- **Visual Monitor API**: `http://127.0.0.1:18777`
- **EverMemOS API**: `http://127.0.0.1:1995`
- **Owner User ID**: your test account identifier
- **Assistant model**: your chat completion model endpoint
- **Vision model**: your VLM endpoint

### One-Script Startup (macOS)

```bash
./scripts/start_socialclaw_macos.sh
```

This starts Docker deps + EverMemOS API + Visual Monitor API.
Start the frontend separately with `cd social_copilot/frontend && npm run dev`.

## Configuration Reference

All configuration is centralized in the root `.env` file. See `.env.example` for the full list with comments.

### Key Configuration Groups

| Group | Key Variables | Purpose |
|-------|--------------|---------|
| VLM | `SOCIAL_COPILOT_VISION_*` | Screenshot recognition model |
| Assistant | `SOCIAL_COPILOT_ASSISTANT_*` | Reply suggestion model |
| LLM | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | EverMemOS memory pipeline |
| Embedding | `VECTORIZE_*` | Text embedding for vector search |
| Rerank | `RERANK_*` | Search result reranking |
| Data stores | `REDIS_*`, `MONGODB_*`, `ES_*`, `MILVUS_*` | Database connections |

### Fallback Chain

Several variables support fallback to avoid duplication:

```
SOCIAL_COPILOT_ASSISTANT_BASE_URL → LLM_BASE_URL
SOCIAL_COPILOT_ASSISTANT_API_KEY  → LLM_API_KEY
SOCIAL_COPILOT_VISION_BASE_URL    → LLM_BASE_URL
SOCIAL_COPILOT_VISION_API_KEY     → LLM_API_KEY
```

If a dedicated service URL is empty, the system falls back to the generic LLM config.

### Concurrency Control

```bash
# Max concurrent LLM calls across the entire system (default: 5)
LLM_MAX_CONCURRENT=5
```

Reduce this if you see frequent `429 Too Many Requests` errors. Increase if your API provider supports higher throughput.

## Tips & Debugging

### Check Service Health

```bash
# All services at a glance
curl -s http://127.0.0.1:18777/health | python -m json.tool
curl -s http://127.0.0.1:1995/health | python -m json.tool

# Visual Monitor status (includes capture stats)
curl -s http://127.0.0.1:18777/monitor/status | python -m json.tool

# Docker services
cd memory/evermemos && docker-compose ps
```

### View Logs

```bash
# If using the one-script startup
tail -f .socialclaw-stack/evermemos.log
tail -f .socialclaw-stack/visual-monitor.log

# EverMemOS logs (if running directly)
# Logs go to stdout/stderr in the terminal

# Visual Monitor (if running with --reload)
# Logs go to stdout/stderr in the terminal
```

### Test Individual Pipelines

**Test VLM recognition** — trigger a manual capture:
```bash
curl -X POST http://127.0.0.1:18777/monitor/capture
# Then check events
curl http://127.0.0.1:18777/events/poll
```

**Test EverMemOS memory** — send a test chat:
```bash
curl -X POST http://127.0.0.1:1995/api/v1/copilot/process-chat \
  -H "Content-Type: application/json" \
  -d '{
    "owner_user_id": "test_user",
    "session_key": "WeChat::TestContact",
    "display_name": "TestContact",
    "messages": [
      {"sender_id": "test_user", "sender_type": "user", "content": "hello", "content_type": "text"},
      {"sender_id": "contact", "sender_type": "contact", "content": "hi there", "content_type": "text"}
    ],
    "incoming_message": {"sender_id": "contact", "sender_type": "contact", "content": "hi there", "content_type": "text"}
  }'
```

**Test reply suggestions**:
```bash
curl -X POST http://127.0.0.1:18777/assistant/suggestions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"sender": "contact", "text": "你好啊", "contact_name": "TestFriend"}
    ],
    "owner_user_id": "test_user",
    "session_key": "WeChat::TestFriend"
  }'
```

### Common Issues

| Symptom | Check |
|---------|-------|
| No messages detected | VLM service reachable? `SOCIAL_COPILOT_VISION_*` configured? |
| 429 rate limit errors | Reduce `LLM_MAX_CONCURRENT` (try 2-3) |
| Memory not updating | MongoDB/Redis running? `docker-compose ps` |
| Suggestions always fallback | `SOCIAL_COPILOT_EVERMEMOS_ENABLED=true`? EverMemOS API up? |
| Empty suggestions | Check assistant model API key and base URL |
| Profile not building | Need >=10 messages for threshold trigger, or set `force_profile_update: true` |

### Verbose Logging

```bash
# In .env
LOG_LEVEL=DEBUG
```

This enables detailed LLM call logging including token counts, durations, and finish reasons. Watch for warnings like `Duration too long` or `Finish reason: length` (truncated responses).

## Documentation

| Guide | Description |
|-------|------------|
| [Model Configuration](docs/model/model-configuration-guide.md) | How to configure LLM / VLM / Embedding models, use CLIProxyAPI to convert CLI subscriptions, .env vs UI settings |
| [Memory Operations](docs/memory/memory-operations-guide.md) | Import old chats, backfill memory, view/edit friend profiles, profile regeneration |
| [Chat Record Acquisition](docs/chat_record/old-chat-record-acquisition.md) | Validated pipeline for exporting WeChat old chat records via MemoTrace |
| [Visual Monitor Debugging](docs/visual_monitor/visual-monitor-debugging-guide.md) | ROI tuning, screenshot frequency, debug mode, cached image inspection |

## Project Structure

```
SocialClaw/
├── .env.example              # Root environment config template
├── README.md
├── scripts/
│   ├── start_socialclaw_macos.sh  # macOS one-script startup
│   ├── stop_socialclaw_macos.sh   # macOS one-script shutdown
│   ├── start_socialclaw_win.ps1   # Windows startup
│   ├── stop_socialclaw_win.ps1    # Windows shutdown
│   ├── start_socialclaw.sh        # Backward-compatible macOS wrapper
│   ├── stop_socialclaw.sh         # Backward-compatible macOS wrapper
│   ├── start_socialclaw.ps1       # Backward-compatible Windows wrapper
│   └── stop_socialclaw.ps1        # Backward-compatible Windows wrapper
├── social_copilot/
│   ├── agent/                # LLM clients, reply assistant
│   ├── frontend/             # Electron + React frontend
│   ├── visual_monitor/       # Screen capture, VLM, event bus
│   │   ├── config/           # YAML config templates
│   │   ├── api/              # FastAPI routes (monitor, assistant)
│   │   └── core/             # Pipeline, scheduler, change detection
│   └── requirements.txt
├── memory/
│   └── evermemos/            # Memory & profile system
│       ├── src/
│       │   ├── copilot_orchestrator/  # Chat workflow, reply generator
│       │   ├── memory_layer/          # LLM providers, memory manager
│       │   ├── agentic_layer/         # Memory orchestration
│       │   └── infra_layer/           # Persistence adapters
│       ├── docker-compose.yaml
│       ├── env.template
│       └── pyproject.toml
└── docs/
```

## Tech Stack

- **Backend**: Python (FastAPI, asyncio, LangGraph, LangChain)
- **Frontend**: Electron, React, TypeScript, Vite
- **Data Stores**: MongoDB, Elasticsearch, Milvus, Redis
- **AI**: OpenAI-compatible APIs (any provider), VLM for vision
