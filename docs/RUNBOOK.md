# OpenBot Operator Runbook

## 1. Prerequisites

1. **Environment variables:** Copy [`.env.example`](../.env.example) to `.env` and set a funded `GEMINI_API_KEY` (used by Phase 6 System 2 macro strategist, optional `OPENBOT_SYSTEM1_PROVIDER=gemini` fast profile, or Gemini Live fallback).
2. **System 1 Inference Profiles (Choose 1):**
   - **Profile A — Cloud-Fast (`OPENBOT_SYSTEM1_PROVIDER=gemini`):**
     - Uses `gemini-3.1-flash-lite-preview` via REST with `responseSchema` and `thinkingConfig.thinkingLevel="minimal"`.
     - Zero local GPU VRAM usage, **`2.4s` System 1 p50** (`activeActions/min = 46.00`, `frameToAction p50 = 3353.5ms / p95 = 5834.6ms`, `actionExec p95 = 1101.8ms`, `0` stalled screencast frames verified in Phase 7 live 180s run).
     ```powershell
     $env:OPENBOT_SYSTEM1_PROVIDER = "gemini"
     ```
   - **Profile B — Remote/Tunneled GPU LM Studio (`OPENBOT_SYSTEM1_PROVIDER=lmstudio` -> `http://127.0.0.1:1234/v1`):**
     - Target a dedicated remote GPU machine forwarded onto `127.0.0.1:1234` (SSH/Tailscale/LM Studio tunnel) serving `google/gemma-4-12b`, or run a local `<4 GB` vision model (`google/gemma-4-e4b`) in LM Studio:
       ```powershell
       lms server start
       lms load "google/gemma-4-e4b" -c 2048 --yes
       ```
     - Note: Running 7.5+ GB `google/gemma-4-12b` directly on a 6 GiB laptop GPU spills to system RAM (`~25.9s` p50; override `OPENBOT_SYSTEM1_TIMEOUT_S=45.0` if testing locally). Default strict Phase 7 timeouts are `5.5s` (`gemini`) / `4.0s` (`lmstudio`).
   - **No-Think Enforcement:** LM Studio requests pass `"reasoning_effort": "none"` (verified `reasoning_tokens: 0`) so tactical JSON emits directly without chain-of-thought verbosity.
3. **Python 3.12 bridge (`bridge/`):** Ensure `bridge/.venv` exists (`uv venv --python 3.12` + `uv pip install -e ".[dev]"`).
4. **Node dependencies (root):** Run `npm ci` cleanly once.
5. **Browser port & locale notes:**
   - If `127.0.0.1:9222` is occupied by an existing Chrome/Edge session, pass `--cdp-url http://127.0.0.1:19222` (or set `OPENBOT_CDP_URL=http://127.0.0.1:19222`). NEVER terminate host browser processes on port `9222`.
   - `launchNonThrottledBrowser` passes `--lang=en-US` (with Vietnamese `Chơi đơn` / `Bắt Đầu` fallback hints in `LobbyNavigator`) so UI & prompts stay consistent.
6. **Edge/Chrome Anti-Throttling & Window Visibility (CRITICAL):**
   - Keep the spawned Edge/Chrome window **visible and unminimized** during live play so Windows DWM does not stall WebGL/compositor screenshots.
   - `launchNonThrottledBrowser` automatically passes `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling`.
7. **Game Over Auto-Stop:** Enabled by default. In Phase 6, stops gracefully after 2 consecutive public Lit DOM `win-modal` `game_over=true` HUD polls (~1–2s after victory/defeat) or 3 consecutive `GAME_OVER` `wait_observe` calls. Pass `--no-stop-on-game-over` to keep watching until `--duration` expires.

---

## 2. Phase 7 Dual-Brain Configuration (`OPENBOT_BRAIN_MODE=dual`)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `OPENBOT_BRAIN_MODE` | `dual` | `dual` (System 1 + System 2), `gemini_live` (legacy Pipecat), or `auto` |
| `OPENBOT_SYSTEM1_PROVIDER` | `lmstudio` | `lmstudio` (local/tunneled Gemma 4) or `gemini` (Gemini REST Flash cloud-fast) |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible LM Studio API endpoint |
| `LMSTUDIO_MODEL` | `google/gemma-4-12b` | Vision model identifier (tunneled remote GPU or `google/gemma-4-e4b` for 6 GiB VRAM) |
| `OPENBOT_SYSTEM1_TIMEOUT_S` | `5.5` (`gemini`) / `4.0` (`lmstudio`) | Strict per-call timeout with zero slow backoff retries |
| `OPENBOT_SYSTEM1_INTERVAL_S` | `0.2` | System 1 tactical cadence between completed turns |
| `OPENBOT_SYSTEM1_WIDTH` / `HEIGHT` | `768` / `432` | Grid-annotated JPEG frame dimensions (`quality=62`) |
| `GEMINI_STRATEGIST_MODEL` | `gemini-3.1-flash-lite-preview` | Background System 2 Gemini REST strategist model |
| `OPENBOT_STRATEGIST_INTERVAL_S` | `25.0` | Non-blocking background directive refresh cadence |

In `dual` mode, the Python bridge exposes `brain_mode: "dual"` on `/health`, processes `/ws/capture-frames` directly into `DualBrainCoordinator` (with `0.1..0.9` coordinate grid overlay), consumes 1 Hz public Lit DOM `hud_snapshot` telemetry over `/ws/actions`, and dispatches `execute_plan` batches with `expand_burst`, periodic camera inspection + `reset_overview` hygiene, failed-build interior coordinate redirect, pre-click base gold cost guards, post-click gold-delta verification, and `Escape` ghost cleanup.

---

## 3. Join a Friend's Private `openfront.io` Lobby (`--duration 1800 --cdp-url http://127.0.0.1:19222`)

> Non-loopback lobbies require **both** `OPENBOT_ALLOW_PUBLIC=true` and `--allow-remote-host` (FairPlayGuard). Replace `<LOBBY_CODE>` with your invite code.

### Profile A — `OPENBOT_SYSTEM1_PROVIDER=gemini` (Ready Immediately)

**Terminal 1 — Python Dual-Brain Bridge:**
```powershell
$env:OPENBOT_SYSTEM1_PROVIDER = "gemini"; $env:PYTHONPATH = "$PWD\bridge\src"; .\bridge\.venv\Scripts\python.exe -m openbot_bridge.server
```

**Terminal 2 — TypeScript Bot Orchestrator:**
```powershell
$env:OPENBOT_ALLOW_PUBLIC = "true"; npm run bot -- --lobby-url "https://openfront.io/join/<LOBBY_CODE>" --allow-remote-host --cdp-url http://127.0.0.1:19222 --duration 1800
```

### Profile B — `OPENBOT_SYSTEM1_PROVIDER=lmstudio` Targeting `http://127.0.0.1:1234/v1` (Tunneled Remote GPU Server)

**Terminal 1 — Python Dual-Brain Bridge:**
```powershell
$env:OPENBOT_SYSTEM1_PROVIDER = "lmstudio"; $env:LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1"; $env:LMSTUDIO_MODEL = "google/gemma-4-12b"; $env:PYTHONPATH = "$PWD\bridge\src"; .\bridge\.venv\Scripts\python.exe -m openbot_bridge.server
```

**Terminal 2 — TypeScript Bot Orchestrator:**
```powershell
$env:OPENBOT_ALLOW_PUBLIC = "true"; npm run bot -- --lobby-url "https://openfront.io/join/<LOBBY_CODE>" --allow-remote-host --cdp-url http://127.0.0.1:19222 --duration 1800
```

Single PowerShell one-liner (Profile A — starts the bridge in a child window and launches directly into the lobby):
```powershell
$env:OPENBOT_SYSTEM1_PROVIDER = "gemini"; $env:PYTHONPATH = "$PWD\bridge\src"; $b = Start-Process -FilePath ".\bridge\.venv\Scripts\python.exe" -ArgumentList "-m","openbot_bridge.server" -PassThru; try { $env:OPENBOT_ALLOW_PUBLIC = "true"; npx tsx src/cli.ts --lobby-url "https://openfront.io/join/<LOBBY_CODE>" --allow-remote-host --cdp-url http://127.0.0.1:19222 --duration 1800 } finally { if ($b -and -not $b.HasExited) { taskkill /PID $b.Id /T /F | Out-Null } }
```

---

## 4. Local Solo Smoke & Eval (`http://localhost:9000`)

1. Start local OpenFront (`vendor/OpenFrontIO`):
   ```powershell
   cd vendor\OpenFrontIO; $env:SKIP_BROWSER_OPEN = "true"; npm run dev
   ```
2. Start the Python bridge with debug grid-frame capture enabled (`lmstudio` or `gemini`):
   ```powershell
   $env:OPENBOT_SYSTEM1_PROVIDER = "gemini"; $env:PYTHONPATH = "$PWD\bridge\src"; $env:OPENBOT_DEBUG_FRAME_PATH = "artifacts\debug-frame.png"; .\bridge\.venv\Scripts\python.exe -m openbot_bridge.server
   ```
3. Run the TypeScript bot orchestrator:
   ```powershell
   npm run bot -- --duration 180 --cdp-url http://127.0.0.1:19222 --debug-frame artifacts/debug-frame.png
   ```

---

## 5. Safe Stop & Windows Process Cleanup

1. Press **`Ctrl+C`** in the bot CLI terminal (`MatchOrchestrator.stop()` flushes telemetry JSONL to `logs/match-*.jsonl`, closes CDP/screencast cleanly, and terminates the dedicated Edge window spawned with `--user-data-dir`).
2. Press **`Ctrl+C`** in the bridge and `OpenFrontIO` terminals.
3. Verify no OpenBot ports remain open (`8765`, `9000`, `19222`):
   ```powershell
   netstat -ano | findstr "8765 9000 19222"
   ```
4. If a stray server PID appears from the list above, terminate only that specific tree:
   ```powershell
   taskkill /PID <PID> /T /F
   ```
