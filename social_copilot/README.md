# Social Copilot Runtime

This directory contains the application runtime inside the `SocialClaw` project.

It keeps the existing Python package name `social_copilot` so the current imports and startup commands continue to work after the structure migration.

## What It Includes

- `visual_monitor/`: FastAPI backend for screen capture, OCR/VLM extraction, message assembly, and suggestion APIs.
- `frontend/`: Electron desktop app with the main console, assistant bubble, ROI overlay, and local settings.
- `agent/`: OpenAI-compatible reply generation path built on top of extracted chat context.
- `tests/`: Python runtime and API coverage for the visual monitoring pipeline.

## Core Capabilities

- Live screen-region monitoring with manual, auto, and hybrid ROI modes
- Foreground-window gating for WeChat / Windows probe support
- OCR-first extraction with optional VLM fallback
- Realtime assistant suggestions via local or OpenAI-compatible model endpoints
- Local file-based memory and chat-record persistence

## Repository Layout

```text
.
├── agent/                  # Reply suggestion and OpenAI-compatible agent path
├── frontend/               # Electron app
├── tests/                  # Python tests
└── visual_monitor/         # FastAPI backend
```

## Requirements

### Backend

- Python 3.10+
- A virtualenv or Conda environment
- macOS or Windows 11 for live desktop capture

### Frontend

- Node.js 20+
- npm

## Location In SocialClaw

From the `SocialClaw` root, this package lives at:

```text
social_copilot/
```

## Installation

First enter the runtime directory:

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot
```

### 2. Install backend dependencies

macOS / Linux:

```bash
python -m venv .venv-visual-monitor
source .venv-visual-monitor/bin/activate
pip install -r requirements-dev.txt
```

Windows PowerShell:

```powershell
python -m venv .venv-visual-monitor
.\.venv-visual-monitor\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
```

If you are using Conda, activate that environment first and then run:

```bash
pip install -r requirements-dev.txt
```

### 3. Install frontend dependencies

```bash
cd frontend
npm install
cd ..
```

## Configuration

### Model configuration

Set your API keys through environment variables. Do not hardcode them in files.

```bash
export SOCIAL_COPILOT_AGENT_API_KEY="your-agent-api-key"
export SOCIAL_COPILOT_VLM_API_KEY="your-vision-api-key"
```

Optional model endpoint variables:

```bash
export SOCIAL_COPILOT_AGENT_BASE_URL="https://your-openai-compatible-endpoint/v1"
export SOCIAL_COPILOT_AGENT_MODEL="your-agent-model"
```

### Visual monitor config

- Example config: `visual_monitor/config/visual_monitor.example.yaml`
- Local override path: `visual_monitor/config/local/visual_monitor.yaml`

The backend supports:

- `ocr` mode
- `vlm_structured` mode
- `hybrid` mode

## Running The Runtime

### Terminal A: start the backend

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw
python -m uvicorn social_copilot.visual_monitor.app:app --host 127.0.0.1 --port 18777 --reload
```

Health checks:

```bash
curl -s http://127.0.0.1:18777/health
curl -s http://127.0.0.1:18777/monitor/status
```

### Terminal B: start the Electron app

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend
npm run dev
```

If you are already inside `social_copilot/frontend`, just run:

```bash
npm run dev
```

## Typical Usage

1. Start the backend and frontend.
2. In the desktop app, configure:
   - assistant model endpoint
   - vision model endpoint
   - visual monitor API URL, usually `http://127.0.0.1:18777`
3. Choose a monitoring strategy:
   - `manual`
   - `auto`
   - `hybrid`
4. If using manual ROI, open the overlay and select the chat region.
5. Keep WeChat in the foreground and let the assistant consume monitor events and produce suggestions.

Windows note:

- The ROI overlay does not auto-focus WeChat.
- Manually bring WeChat to the foreground before selecting the ROI.

## Testing

### Python

```bash
python -m pytest tests -q
```

### Frontend

```bash
cd frontend
npm test
```

### Type checking

```bash
cd frontend
npm run typecheck
```

## Development Notes

- `frontend/node_modules`, `frontend/dist`, caches, screenshots, and local memory data should not be committed.
- API keys should be injected through environment variables or local settings only.
- `memory/` is local runtime state and should stay out of version control.

## Integration Note

Inside `SocialClaw`, this runtime is expected to work together with:

```text
memory/evermemos/
```

The current realtime flow is:

1. Visual Monitor extracts chat events
2. Frontend sends recent messages to EverMemOS
3. EverMemOS updates memory and profiles
4. Social Copilot generates reply suggestions using the refreshed context
