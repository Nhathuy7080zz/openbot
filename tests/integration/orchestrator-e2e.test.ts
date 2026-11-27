import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserActuator } from '../../src/browser/actuator.js';
import { ActionExecutor } from '../../src/harness/action-executor.js';
import { RateLimiter } from '../../src/harness/rate-limiter.js';
import { MatchOrchestrator } from '../../src/loop/orchestrator.js';
import { TelemetryLogger } from '../../src/loop/telemetry.js';

describe('MatchOrchestrator E2E (Mocked /ws/actions + Mocked BrowserActuator)', () => {
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    for (const srv of servers) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    servers.length = 0;
  });

  it('processes spawn, attack, build, and session_status(go_away -> resumed) and writes JSONL telemetry', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-e2e-'));
    const logPath = path.join(tmpDir, 'e2e.jsonl');

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(wss);
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', (err) => reject(err));
    });
    const addr = wss.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('Expected numeric server port');
    }

    const receivedResponses: Array<Record<string, unknown>> = [];

    wss.on('connection', (ws) => {
      ws.send(
        JSON.stringify({
          type: 'session_status',
          session_id: 'sess-e2e',
          state: 'connected',
          resumption_handle_present: false,
          timestamp_ms: 1000,
        }),
      );

      ws.on('message', (data) => {
        const rawText = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : typeof data === 'string'
            ? data
            : Buffer.concat(data as Buffer[]).toString('utf8');
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        if (parsed['type'] === 'action_response') {
          receivedResponses.push(parsed);
        }
      });

      const baseFrame = Date.now() - 100;
      const requests = [
        {
          type: 'action_request',
          call_id: 'call-1',
          session_id: 'sess-e2e',
          tool_name: 'select_spawn',
          arguments: { x: 0.5, y: 0.5, rationale: 'Central coast spawn' },
          frame_captured_at_ms: baseFrame,
          model_emitted_at_ms: baseFrame + 50,
        },
        {
          type: 'action_request',
          call_id: 'call-2',
          session_id: 'sess-e2e',
          tool_name: 'attack_territory',
          arguments: { x: 0.6, y: 0.4, ratio_pct: 30, rationale: 'Expand east' },
          frame_captured_at_ms: baseFrame + 100,
          model_emitted_at_ms: baseFrame + 140,
        },
        {
          type: 'action_request',
          call_id: 'call-3',
          session_id: 'sess-e2e',
          tool_name: 'build_structure',
          arguments: { structure: 'city', x: 0.48, y: 0.52, rationale: 'Boost troop cap' },
          frame_captured_at_ms: baseFrame + 200,
          model_emitted_at_ms: baseFrame + 240,
        },
      ];

      for (const req of requests) {
        ws.send(JSON.stringify(req));
      }

      ws.send(
        JSON.stringify({
          type: 'session_status',
          session_id: 'sess-e2e',
          state: 'go_away',
          resumption_handle_present: true,
          timestamp_ms: 2000,
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'session_status',
          session_id: 'sess-e2e',
          state: 'resumed',
          resumption_handle_present: true,
          timestamp_ms: 2500,
        }),
      );
    });

    const actuator: BrowserActuator = {
      getViewportRect: vi.fn().mockResolvedValue({ left: 0, top: 0, width: 1280, height: 720 }),
      clickAt: vi.fn().mockResolvedValue(undefined),
      drag: vi.fn().mockResolvedValue(undefined),
      wheelAt: vi.fn().mockResolvedValue(undefined),
      pressKey: vi.fn().mockResolvedValue(undefined),
      holdKey: vi.fn().mockResolvedValue(undefined),
      clickDomSelector: vi.fn().mockResolvedValue(undefined),
      fillDomSelector: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const executor = new ActionExecutor({
      actuator,
      rateLimiter: new RateLimiter({
        maxApm: 180,
        burstCap: 10,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      }),
      sleep: () => Promise.resolve(),
    });

    const telemetry = new TelemetryLogger({ logFilePath: logPath });
    const orchestrator = new MatchOrchestrator({
      wsUrl: `ws://127.0.0.1:${addr.port}`,
      executor,
      telemetry,
      pingIntervalMs: 60_000,
      reconnectDelayMs: 50,
    });

    await orchestrator.start();

    const deadline = Date.now() + 3000;
    while (receivedResponses.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await orchestrator.stop();

    expect(receivedResponses).toHaveLength(3);
    expect(receivedResponses.every((r) => r['status'] === 'success')).toBe(true);

    const summary = telemetry.summarize();
    expect(summary.totalActions).toBe(3);
    expect(summary.successCount).toBe(3);
    expect(summary.resumptionCount).toBe(1);
    expect(summary.frameToActionP50Ms).toBeGreaterThanOrEqual(0);
    expect(summary.frameToActionP95Ms).toBeGreaterThanOrEqual(summary.frameToActionP50Ms);
    expect(summary.sampleRationales.map((s) => s.rationale)).toEqual([
      'Central coast spawn',
      'Expand east',
      'Boost troop cap',
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('triggers onGameOver once after consecutive GAME_OVER wait_observe calls', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-gameover-'));
    const logPath = path.join(tmpDir, 'gameover.jsonl');

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(wss);
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', (err) => reject(err));
    });
    const addr = wss.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('Expected numeric server port');
    }

    wss.on('connection', (ws) => {
      const now = Date.now();
      const events = [
        { call_id: 'go-1', tool_name: 'wait_observe', arguments: { duration_ms: 1000, rationale: 'GAME_OVER: Defeat screen displayed.' } },
        { call_id: 'go-2', tool_name: 'attack_territory', arguments: { x: 0.5, y: 0.5, rationale: 'Reset counter on active tool' } },
        { call_id: 'go-3', tool_name: 'wait_observe', arguments: { duration_ms: 1000, rationale: 'GAME_OVER: Match ended.' } },
        { call_id: 'go-4', tool_name: 'wait_observe', arguments: { duration_ms: 1000, rationale: 'Game over modal still visible.' } },
      ];
      for (const evt of events) {
        ws.send(
          JSON.stringify({
            type: 'action_request',
            session_id: 'sess-go',
            frame_captured_at_ms: now,
            model_emitted_at_ms: now + 5,
            ...evt,
          }),
        );
      }
    });

    const actuator: BrowserActuator = {
      getViewportRect: vi.fn().mockResolvedValue({ left: 0, top: 0, width: 1280, height: 720 }),
      clickAt: vi.fn().mockResolvedValue(undefined),
      drag: vi.fn().mockResolvedValue(undefined),
      wheelAt: vi.fn().mockResolvedValue(undefined),
      pressKey: vi.fn().mockResolvedValue(undefined),
      holdKey: vi.fn().mockResolvedValue(undefined),
      clickDomSelector: vi.fn().mockResolvedValue(undefined),
      fillDomSelector: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const executor = new ActionExecutor({
      actuator,
      rateLimiter: new RateLimiter({
        maxApm: 180,
        burstCap: 10,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      }),
      sleep: () => Promise.resolve(),
    });

    const onGameOver = vi.fn();
    const orchestrator = new MatchOrchestrator({
      wsUrl: `ws://127.0.0.1:${addr.port}`,
      executor,
      telemetry: new TelemetryLogger({ logFilePath: logPath }),
      pingIntervalMs: 60_000,
      stopOnGameOverCount: 2,
      onGameOver,
    });

    await orchestrator.start();
    const deadline = Date.now() + 3000;
    while (onGameOver.mock.calls.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await orchestrator.stop();

    expect(onGameOver).toHaveBeenCalledTimes(1);
    expect(onGameOver).toHaveBeenCalledWith({
      consecutiveCount: 2,
      rationale: 'Game over modal still visible.',
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('polls readHud over /ws/actions and triggers onGameOver on consecutive HUD game_over polls', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-hudpoll-'));
    const logPath = path.join(tmpDir, 'hudpoll.jsonl');

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(wss);
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', (err) => reject(err));
    });
    const addr = wss.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('Expected numeric server port');
    }

    const receivedHud: Array<Record<string, unknown>> = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const rawText = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : typeof data === 'string'
            ? data
            : Buffer.concat(data as Buffer[]).toString('utf8');
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        if (parsed['type'] === 'hud_snapshot') {
          receivedHud.push(parsed);
        }
      });
    });

    const actuator: BrowserActuator = {
      getViewportRect: vi.fn().mockResolvedValue({ left: 0, top: 0, width: 1280, height: 720 }),
      clickAt: vi.fn().mockResolvedValue(undefined),
      drag: vi.fn().mockResolvedValue(undefined),
      wheelAt: vi.fn().mockResolvedValue(undefined),
      pressKey: vi.fn().mockResolvedValue(undefined),
      holdKey: vi.fn().mockResolvedValue(undefined),
      clickDomSelector: vi.fn().mockResolvedValue(undefined),
      fillDomSelector: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const executor = new ActionExecutor({
      actuator,
      rateLimiter: new RateLimiter({
        maxApm: 180,
        burstCap: 10,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      }),
    });

    let pollIdx = 0;
    const readHud = vi.fn(() => {
      pollIdx += 1;
      return Promise.resolve({
        type: 'hud_snapshot' as const,
        timestamp_ms: pollIdx * 100,
        panel_visible: pollIdx === 1,
        game_over: pollIdx >= 2,
        gold: 50_000,
        game_over_text: pollIdx >= 2 ? 'Victory!' : null,
      });
    });

    const onGameOver = vi.fn();
    const orchestrator = new MatchOrchestrator({
      wsUrl: `ws://127.0.0.1:${addr.port}`,
      executor,
      telemetry: new TelemetryLogger({ logFilePath: logPath }),
      pingIntervalMs: 60_000,
      hudPollIntervalMs: 25,
      stopOnGameOverCount: 3,
      readHud,
      onGameOver,
    });

    await orchestrator.start();
    const deadline = Date.now() + 3000;
    while (onGameOver.mock.calls.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await orchestrator.stop();

    expect(receivedHud.length).toBeGreaterThanOrEqual(3);
    expect(onGameOver).toHaveBeenCalledTimes(1);
    expect(onGameOver).toHaveBeenCalledWith({
      consecutiveCount: 2,
      rationale: 'Victory!',
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
