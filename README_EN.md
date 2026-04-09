<div align="center">

# SocialClaw

[中文](./README.md) | [English](./README_EN.md)

</div>

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

SocialClaw now recommends a **CLI-first + UI-first** path:

- use the CLI to check prerequisites, generate local bootstrap config, and launch the stack
- use the settings UI to fill in Assistant / VLM / EverMemOS model endpoints and API keys
- keep `.env` files as bootstrap / advanced config entry points instead of the default first-run path

### 1. Clone The Repository

```bash
git clone https://github.com/EnigmaYYYY/SocialClaw.git
cd SocialClaw
```

### 2. Prepare The Runtime Environment

Prepare the Visual Monitor Python environment:

```bash
conda create -n social_copilot python=3.12 -y
conda activate social_copilot
pip install -r social_copilot/visual_monitor/requirements.txt
```

Install the EverMemOS runtime:

```bash
cd memory/evermemos
uv sync
cd ../..
```

Install frontend dependencies:

```bash
cd social_copilot/frontend
npm install
cd ../..
```

### 3. Initialize Local Bootstrap Config

```bash
npm run doctor
npm run init
```

This step will:

- check Node, Docker, `uv`, and Python prerequisites
- generate missing `.env` and `memory/evermemos/.env` files
- create local CLI config at `.socialclaw/config.json`

On macOS, the CLI prefers:

```bash
/Applications/miniconda3/envs/social_copilot/bin/python
```

If your Visual Monitor Python path is different, edit `.socialclaw/config.json`.

### 4. Start The Full Stack

```bash
npm run start
```

This launches:

- EverMemOS Docker dependencies
- EverMemOS API
- Visual Monitor API
- Electron frontend dev process

Stop the stack with:

```bash
npm run stop
```

### 5. Configure Model Providers In The UI

After startup, open the settings page and fill in:

- Assistant model endpoint / API key / model
- Vision model endpoint / API key / model
- EverMemOS LLM / Vectorize / Rerank config

Saving these values will persist them locally and sync them to the running backends.

That means the default path no longer requires filling two `.env` files with model secrets before first launch.

## CLI Commands

### Global npm Installation

If you install the launcher globally from npm, the default flow becomes:

```bash
npm install -g socialclaw
socialclaw init
socialclaw doctor
socialclaw start
socialclaw stop
```

`socialclaw init` will bootstrap a local project workspace and remember its root path for later CLI use.  
If you want to choose the target directory explicitly:

```bash
socialclaw init --project-dir /your/path/SocialClaw
```

After that, you can keep using `socialclaw doctor/start/stop` even when you are not standing inside the repository directory.

### Git Clone Workflow

If you cloned the repository directly, the local workflow stays the same:

```bash
npm run doctor
npm run init
npm run start
npm run stop
```

### Windows

If you install the launcher globally, the commands are:

```powershell
socialclaw doctor
socialclaw init
socialclaw start
socialclaw stop
```

Inside the repository today, the local equivalents are:

```powershell
npm run doctor
npm run init
npm run start
npm run stop
```

The existing Windows launchers remain available:

- `scripts\start_social_stack.cmd`
- `.\scripts\start_social_stack.ps1`

### macOS / shell environments

On macOS / shell environments, the CLI wraps the existing scripts:

- backend launcher: `./scripts/start_socialclaw.sh`
- frontend launcher: `cd social_copilot/frontend && npm run dev`

If you only want the backend services:

```bash
node ./bin/socialclaw.js start --backend-only
```

Stop the stack with:

```bash
node ./bin/socialclaw.js stop
```

## Manual Startup

Use the manual path only if you want custom deployment control.

1. Prepare the Conda environment for Visual Monitor
2. Prepare `memory/evermemos/.env` and start EverMemOS Docker dependencies
3. Start EverMemOS API on `127.0.0.1:1995`
4. Start Visual Monitor API on `127.0.0.1:18777`
5. Start the Electron frontend in `social_copilot/frontend`
6. Configure Assistant, VLM, and EverMemOS model settings in the UI
7. Only edit the root `.env` when you need headless or advanced service-side control

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

The default recommendation is to use the settings UI as the primary model configuration entry point.

The root `.env` and `memory/evermemos/.env` are now better treated as:

- bootstrap files for first-time local setup
- advanced environment-variable overrides
- headless or non-UI service debugging

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
├── README_EN.md
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
