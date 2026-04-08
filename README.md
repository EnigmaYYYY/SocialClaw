# SocialClaw

[中文版本](./README_ZN.md)

SocialClaw is a screen-aware social copilot that watches live chat windows, builds personalized memory and profile context, and suggests replies in real time.

If this project is useful to you, a star helps a lot.

## Why SocialClaw

SocialClaw is not just a reply generator.

It combines:

- live screen understanding from chat windows
- personalized memory and profile construction
- reply suggestions grounded in user style, contact context, and remembered events
- built-in and extensible persona skills for style-controlled guidance

The goal is simple: make social suggestions feel more personal, more contextual, and more usable in real conversations.

In an era where AI assistants are everywhere, the goal of SocialClaw is not to replace the user.

Instead, it is designed to help users improve themselves:

- it does not try to automatically send replies on the user's behalf
- it assists through suggestions instead of silent replacement
- it explains why certain replies are more suitable
- over time, it aims to improve the user's own communication judgment and habits

## What Makes It Different

### Personalized Memory And Profile System

SocialClaw builds both **user-side** and **contact-side** profile context from chat history.

That includes:

- user speaking habits and response style
- contact identity, traits, and preferences
- remembered events and relationship context
- long-term memory used during suggestion generation

This matters because better suggestions do not only come from the latest message. They come from knowing how you usually speak, who the other person is, and what has already happened between you.

### Built-In And Extensible Persona Skills

Persona skills are a first-class part of SocialClaw.

The app already includes a set of built-in persona skills, and users can upload or create their own custom skills to shape how suggestions are written.

Typical use cases include:

- creating mentor-style guidance
- simulating a manager or colleague communication style
- adding a custom social tone for different contexts
- testing multiple reply styles against the same conversation

This makes SocialClaw more than a generic assistant. It becomes a controllable social strategy layer.

### Screen-Aware, Real-Time Suggestions

SocialClaw does not rely on platform webhooks. It watches the actual chat UI, uses a VLM to turn screenshots into structured messages, and then drives memory sync plus suggestion generation from those events.

### OpenAI-Compatible And Proxy-Friendly

Assistant, VLM, and memory-side model calls are designed around OpenAI-compatible APIs. This makes it easy to plug in hosted providers, self-hosted gateways, or proxies such as CLIProxyAPI.

## Privacy And Local-First Design

SocialClaw is designed around local ownership of data.

Chat record files, memory artifacts, profile data, and runtime caches are intended to stay on the user's machine by default.

That makes the project better suited to:

- privacy-sensitive workflows
- local experimentation
- users who want direct control over their files and data lifecycle

Final privacy boundaries still depend on which model providers or proxies you connect, but the project itself is built around local storage rather than centralized hosting.

## Core Capabilities

| Capability | What you get |
| --- | --- |
| Screen-aware monitoring | Detects chat-window changes and extracts structured messages from screenshots |
| Personalized memory and profiles | Builds user memory, contact memory, profile updates, and retrieval context |
| Real-time reply suggestions | Generates grounded reply candidates from current chat context and long-term memory |
| Persona skill enhancement | Applies built-in or custom persona skills to shape suggestion style and strategy |
| Old chat import and backfill | Imports historical chat data and rebuilds memory from local records |
| Operator-facing controls | UI settings for models, stream strategy, memory operations, and monitoring flow |

## Best-Fit Scenarios

SocialClaw currently works best when:

- replies do not need to be ultra-fast
- the conversation benefits from a bit of thought and wording control
- memory, relationship context, and style actually matter

Typical examples include:

- workplace communication
- relationship maintenance
- important private chats
- conversations where tone, framing, and strategy matter

## Where It Is Not Ideal Yet

Because the current system relies on visual-model-based chat extraction, it is not the best fit for extremely high-frequency reply scenarios.

That includes:

- rapid-fire back-and-forth chat
- ultra-low-latency messaging situations
- conversations where you must reply almost instantly every time

In short, SocialClaw is better for conversations that deserve thought, not conversations that demand speed.

## Start Here

| Guide | Best for |
| --- | --- |
| [Model Configuration Guide](docs/model/model-configuration-guide.md) | Configure assistant, VLM, embedding, rerank, CLIProxyAPI, `.env`, and UI model settings |
| [Memory Operations Guide](docs/memory/memory-operations-guide.md) | Import old chats, backfill memory, inspect profiles, regenerate memory, and edit profile data |
| [EverMemOS Memory Build & Retrieval Guide](docs/memory/evermemos-memory-build-retrieval-guide.en.md) | Understand how memory is built, stored, retrieved, and fed into reply generation |
| [Chat Record Acquisition Guide](docs/chat_record/old-chat-record-acquisition.md) | Export and ingest historical WeChat records |
| [Visual Monitor Debugging Guide](docs/visual_monitor/visual-monitor-debugging-guide.md) | Tune ROI, screenshot behavior, and monitor-side debugging |

## Quick Start

### Recommended Setup Order

Before using the startup scripts, prepare the environment first. The scripts are meant to launch services, not guess your local Python / Node setup.

### 1. Prepare The Root Config

```bash
git clone <your-repo-url> SocialClaw
cd SocialClaw
cp .env.example .env
```

Then edit `.env` and fill in at least:

- assistant model endpoint and API key
- vision model endpoint and API key
- memory-side LLM settings
- embedding and rerank settings, if needed

### 2. Prepare The Visual Monitor Python Environment

The repository expects a Conda environment for the Visual Monitor side. The recommended name is `social_copilot`.

Example:

```bash
conda create -n social_copilot python=3.12 -y
conda activate social_copilot
pip install -r social_copilot/visual_monitor/requirements.txt
```

On macOS, the shell startup script defaults to:

```bash
/Applications/miniconda3/envs/social_copilot/bin/python
```

If your Python path is different, set `VISUAL_MONITOR_PYTHON` before running the script.

### 3. Prepare EverMemOS

EverMemOS has its own environment template and Docker-backed data stores.

```bash
cd memory/evermemos
cp env.template .env
```

Then edit `memory/evermemos/.env` and verify the model and datastore settings.

Install the EverMemOS runtime with `uv`:

```bash
uv sync
```

### 4. Prepare The Frontend

```bash
cd social_copilot/frontend
npm install
```

## Recommended Startup Paths

### Windows

Recommended launcher:

```powershell
scripts\start_social_stack.cmd
```

Or directly:

```powershell
.\scripts\start_social_stack.ps1
```

Important note:

- the Windows PowerShell script contains local executable path parameters for Python and Node
- if your environment paths differ, edit the defaults at the top of the script or pass your own values explicitly

Typical parameters you may need to adjust:

- `VisualMonitorPython`
- `EverMemOSPython`
- `NodeExe`
- `NpmCmd`

This startup path is intended to launch:

- EverMemOS Docker dependencies
- EverMemOS API
- Visual Monitor API
- Electron frontend dev process

To stop the stack:

```powershell
scripts\stop_social_stack.cmd
```

Or:

```powershell
.\scripts\stop_social_stack.ps1
```

### macOS / shell environments

Recommended backend launcher:

```bash
./scripts/start_socialclaw.sh
```

This script starts the backend stack and waits for health checks to pass:

- EverMemOS Docker dependencies
- EverMemOS API
- Visual Monitor API

Then start the frontend separately:

```bash
cd social_copilot/frontend
npm run dev
```

To stop the backend services:

```bash
./scripts/stop_socialclaw.sh
```

## Manual Startup

Use the manual path only if you want custom deployment control.

1. Clone the repo and create `.env` from `.env.example`
2. Prepare the Conda environment for Visual Monitor
3. Prepare `memory/evermemos/.env` from `env.template`
4. Start EverMemOS Docker dependencies in `memory/evermemos`
5. Start EverMemOS API on `127.0.0.1:1995`
6. Start Visual Monitor API on `127.0.0.1:18777`
7. Start the Electron frontend in `social_copilot/frontend`
8. Open Settings in the app and verify the assistant model, vision model, and API endpoints

## Minimum Requirements

| Requirement | Notes |
| --- | --- |
| Python 3.12 | EverMemOS expects Python `>=3.12,<3.13` |
| Conda | Recommended for the Visual Monitor environment |
| Node.js 20+ | Needed for the Electron frontend |
| Docker | Used for EverMemOS data stores |
| OpenAI-compatible chat model | Used by assistant and memory-side LLM workflows |
| VLM endpoint | Used for screenshot recognition |
| Embedding + rerank services | Used by retrieval and memory search |

## How SocialClaw Works

1. Visual Monitor watches a live chat window and extracts structured messages from screenshots.
2. The frontend coordinates event polling, memory synchronization, profile updates, and suggestion requests.
3. EverMemOS updates long-term memory and contact profiles, then suggestion generation uses both the current message and stored context.

That creates a loop like this:

- a new message appears on screen
- the screenshot is parsed into structured chat events
- memory and profile state are updated
- suggestion candidates are generated for the current conversation

## Model Story

SocialClaw separates three model roles:

- Assistant model: reply suggestion generation
- Vision model: screenshot-to-message extraction
- Memory-side LLM stack: memory extraction, profile generation, and retrieval orchestration

Because everything is OpenAI-compatible, you can mix providers or proxies. A common setup is:

- CLIProxyAPI or another OpenAI-compatible proxy for assistant / VLM
- local or hosted embedding service
- dedicated rerank service

The app also exposes `stream` / `non_stream` strategy controls for assistant and VLM in the settings UI, which is useful when working with proxy-specific quirks.

## Configuration

The root `.env` is the main shared configuration entry point.

Important groups:

| Group | Variables |
| --- | --- |
| Assistant | `SOCIAL_COPILOT_ASSISTANT_*` |
| Vision / VLM | `SOCIAL_COPILOT_VISION_*` and `SOCIAL_COPILOT_VLM_*` |
| EverMemOS / memory | `SOCIAL_COPILOT_EVERMEMOS_*` and `LLM_*` |
| Embedding | `VECTORIZE_*` |
| Rerank | `RERANK_*` |
| Data stores | `REDIS_*`, `MONGODB_*`, `ES_*`, `MILVUS_*` |

For detailed provider setup, use the [Model Configuration Guide](docs/model/model-configuration-guide.md).

## Repository Layout

```text
SocialClaw/
├── README.md
├── README_ZN.md
├── LICENSE
├── .env.example
├── scripts/
│   ├── start_social_stack.cmd
│   ├── start_social_stack.ps1
│   ├── stop_social_stack.cmd
│   ├── stop_social_stack.ps1
│   ├── start_socialclaw.sh
│   └── stop_socialclaw.sh
├── social_copilot/
│   ├── frontend/
│   ├── visual_monitor/
│   ├── agent/
│   └── agent_runtime/
├── memory/
│   └── evermemos/
└── docs/
```

## TODO / Roadmap

Areas we still want to improve:

- strengthen the personalized memory system and let more long-term behavior be distilled into reusable skills
- improve the UI and interaction design
- let users inspect and adjust chat-record file contents directly from the UI
- keep improving persona-skill import, management, and usage flow
- improve stability and interpretability across the visual monitoring pipeline

Feedback and co-creation are very welcome:

- open issues
- suggest improvements
- contribute new persona skills
- join the project and build with us

## License

This project is released under the [MIT License](./LICENSE).

## Acknowledgements

SocialClaw builds on ideas, inspiration, or upstream components from these projects:

- [EverOS / EverMemOS](https://github.com/EverMind-AI/EverOS.git) for the memory-system foundation
- [kkclaw](https://github.com/kk43994/kkclaw.git) for floating-orb UI inspiration
- [awesome-persona-distill-skills](https://github.com/xixu-me/awesome-persona-distill-skills) for the persona-skill collection reference
