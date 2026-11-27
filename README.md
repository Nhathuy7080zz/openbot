# OpenBot

Real-time **OpenFront** AI agent powered by a **Dual-Brain Hybrid Architecture** (fast stateless System 1 tactical loop + background System 2 macro strategist) and a strictly visual **Chrome DevTools Protocol (CDP)** browser actuator.

## Architecture & Fair-Play Boundary

- **Dual-Brain (`OPENBOT_BRAIN_MODE=dual`):**
  - **System 1 (`bridge/src/openbot_bridge/system1_tactical.py`):** Stateless single-turn vision tactical planner over annotated `[0.1..0.9]` grid frames, dispatching multi-step `execute_plan` batches (`expand_burst`, `attack_territory`, `set_attack_ratio`, `build_structure`, `focus_region`, `reset_overview`, `diplomacy_action`).
  - **System 2 (`bridge/src/openbot_bridge/system2_strategist.py`):** Background Gemini strategist refreshing phase/sector/build directives asynchronously without blocking System 1 execution.
  - **Coordinator & Bridge (`bridge/src/openbot_bridge/`):** FastAPI WebSocket server receiving CDP screencast frames (`/ws/capture-frames`) and 1 Hz public HUD snapshots while relaying validated tool calls over `/ws/actions`.
- **Visual-Only Fair-Play Boundary (`src/`):**
  - Captures GPU-composited viewport screenshots (`Page.startScreencast` with non-overlapping screenshot fallback) and reads **only** public rendered Lit DOM HUD elements (`#game-input-overlay`, `control-panel`, `[data-game-timer]`, `win-modal`).
  - Executes physical browser mouse/keyboard inputs through `CdpActuator` / `ActionExecutor` (`RateLimiter` + coordinate mapper + pre-click gold verification + `Escape` placement cleanup).
  - Strictly forbids `window.game`, `myPlayer`, `Network.*`, `Debugger.*`, WebSocket interception, or Web Worker inspection.
- **Shared Contract (`contracts/action-protocol.json`):** Single source of truth defining all 14 `NON_BLOCKING` function schemas synchronized across TypeScript (`zod`) and Python (`pydantic`).

---

## Prerequisites

- **Node.js 20+** and `npm`
- **Python 3.12** (`>=3.12,<3.13`) — [`uv`](https://docs.astral.sh/uv/) recommended (standard `venv` supported)
- **Microsoft Edge** or **Google Chrome** desktop browser

---

## Setup From Scratch

### 1. Clone and configure environment
```powershell
git clone https://github.com/Nhathuy7080zz/openbot.git
cd openbot
Copy-Item .env.example .env
```

Edit `.env` and set your **required** Gemini API key plus optional inference profile settings:
- `GEMINI_API_KEY`: **Required** for System 2 macro strategist, `OPENBOT_SYSTEM1_PROVIDER=gemini`, or `gemini_live` fallback.
- `OPENBOT_SYSTEM1_PROVIDER`: `lmstudio` (default) or `gemini` (cloud-fast Flash Lite).
- `LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL`: OpenAI-compatible LM Studio endpoint (`http://127.0.0.1:1234/v1`, e.g. `google/gemma-4-12b` on a tunneled GPU or `google/gemma-4-e4b` locally).

### 2. Install TypeScript dependencies
```powershell
npm install
```

### 3. Create Python 3.12 virtual environment and install bridge dependencies
Installs `openbot-bridge` from `bridge/pyproject.toml` (including `pipecat-ai[webrtc-video,google]`, `fastapi`, `httpx`, `uvicorn`, `pydantic`, and dev tools `pytest`, `ruff`, `mypy`):

Using `uv` (recommended):
```powershell
uv venv bridge/.venv --python 3.12
uv pip install --python bridge/.venv/Scripts/python.exe -e "bridge[dev]"
```

Standard Python `venv` fallback:
```powershell
py -3.12 -m venv bridge/.venv
.\bridge\.venv\Scripts\python.exe -m pip install -e "bridge[dev]"
```

### 4. Optional: Local OpenFront dev server (`http://localhost:9000`)
For solo smoke testing locally, clone `OpenFrontIO` separately outside tracked files (`vendor/` is gitignored):
```powershell
git clone https://github.com/openfrontio/OpenFrontIO.git vendor/OpenFrontIO
cd vendor/OpenFrontIO
npm install
$env:SKIP_BROWSER_OPEN = "true"; npm run dev
```

---

## Offline Verification

Run the full build, typecheck, linter, and unit/integration test suites:

```powershell
# TypeScript build, typecheck, ESLint, and Vitest with coverage
npm run verify

# Python lint, strict typecheck, and pytest suite
.\bridge\.venv\Scripts\ruff.exe check bridge/src bridge/tests
.\bridge\.venv\Scripts\mypy.exe bridge/src
.\bridge\.venv\Scripts\pytest.exe bridge/tests
```

---

## Launching Into a Live Private `openfront.io` Lobby

Pass `--cdp-url http://127.0.0.1:19222` to launch an isolated, non-throttled browser window (without colliding with port `9222`), and replace `<LOBBY_CODE>` with your invite code. Non-loopback lobbies require **both** `OPENBOT_ALLOW_PUBLIC=true` and `--allow-remote-host`. See [docs/RUNBOOK.md](docs/RUNBOOK.md) for tuning notes and cleanup commands.

### Profile A — `OPENBOT_SYSTEM1_PROVIDER=gemini` (Ready Immediately)

**Terminal 1 — Python Dual-Brain Bridge:**
```powershell
$env:OPENBOT_SYSTEM1_PROVIDER = "gemini"; $env:PYTHONPATH = "$PWD\bridge\src"; .\bridge\.venv\Scripts\python.exe -m openbot_bridge.server
```

**Terminal 2 — TypeScript Bot Orchestrator:**
```powershell
$env:OPENBOT_ALLOW_PUBLIC = "true"; npm run bot -- --lobby-url "https://openfront.io/join/<LOBBY_CODE>" --allow-remote-host --cdp-url http://127.0.0.1:19222 --duration 1800
```

### Profile B — `OPENBOT_SYSTEM1_PROVIDER=lmstudio` Targeting `http://127.0.0.1:1234/v1` (Tunneled Remote GPU)

**Terminal 1 — Python Dual-Brain Bridge:**
```powershell
$env:OPENBOT_SYSTEM1_PROVIDER = "lmstudio"; $env:LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1"; $env:LMSTUDIO_MODEL = "google/gemma-4-12b"; $env:PYTHONPATH = "$PWD\bridge\src"; .\bridge\.venv\Scripts\python.exe -m openbot_bridge.server
```

**Terminal 2 — TypeScript Bot Orchestrator:**
```powershell
$env:OPENBOT_ALLOW_PUBLIC = "true"; npm run bot -- --lobby-url "https://openfront.io/join/<LOBBY_CODE>" --allow-remote-host --cdp-url http://127.0.0.1:19222 --duration 1800
```
