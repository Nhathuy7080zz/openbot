import { describe, expect, it, vi } from 'vitest';
import { ActuatorError, ViewportError } from '../../src/errors/app-error.js';
import { CdpActuator, type CdpClientLike, type CdpDispatchKeyEventParams, type CdpDispatchMouseEventParams } from '../../src/browser/cdp-actuator.js';
import { PUBLIC_HUD_READ_EXPRESSION } from '../../src/browser/hud-reader.js';
import { FallbackActuator } from '../../src/browser/fallback-actuator.js';
import { McpActuator, type McpToolCallResult, type McpToolCaller } from '../../src/browser/mcp-actuator.js';

function createMockMcpCaller(
  customCallTool?: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<McpToolCallResult>,
) {
  const callToolMock = vi.fn(
    (params: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolCallResult> => {
      if (customCallTool) {
        return customCallTool(params);
      }
      if (params.name === 'evaluate_script') {
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ left: 0, top: 0, width: 1280, height: 720 }),
            },
          ],
        });
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    },
  );
  const closeMock = vi.fn(() => Promise.resolve());
  const caller: McpToolCaller = {
    callTool: callToolMock,
    close: closeMock,
  };

  return { caller, callToolMock, closeMock };
}

function createMockCdpClient() {
  const mouseEvents: CdpDispatchMouseEventParams[] = [];
  const keyEvents: CdpDispatchKeyEventParams[] = [];
  const evaluateExpressions: string[] = [];

  const dispatchMouseEventMock = vi.fn((params: CdpDispatchMouseEventParams) => {
    mouseEvents.push(params);
    return Promise.resolve();
  });
  const dispatchKeyEventMock = vi.fn((params: CdpDispatchKeyEventParams) => {
    keyEvents.push(params);
    return Promise.resolve();
  });
  const getLayoutMetricsMock = vi.fn(() =>
    Promise.resolve({
      cssLayoutViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY: 0 },
    }),
  );
  const evaluateMock = vi.fn((params: { expression: string; returnByValue?: boolean }) => {
    evaluateExpressions.push(params.expression);
    return Promise.resolve({
      result: {
        type: 'object',
        value: { left: 10, top: 20, width: 1200, height: 700 },
      },
    });
  });

  const client: CdpClientLike = {
    Input: {
      dispatchMouseEvent: dispatchMouseEventMock,
      dispatchKeyEvent: dispatchKeyEventMock,
    },
    Page: {
      getLayoutMetrics: getLayoutMetricsMock,
    },
    Runtime: {
      evaluate: evaluateMock,
    },
    close: vi.fn(() => Promise.resolve()),
  };

  return {
    client,
    mouseEvents,
    keyEvents,
    evaluateExpressions,
    dispatchMouseEventMock,
    getLayoutMetricsMock,
    evaluateMock,
  };
}

describe('McpActuator, CdpActuator, and FallbackActuator', () => {
  it('McpActuator wraps baseline primitives and rejects unsupported primitives with UNSUPPORTED_PRIMITIVE', async () => {
    const { caller, callToolMock, closeMock } = createMockMcpCaller();
    const mcp = new McpActuator({ client: caller });

    const rect = await mcp.getViewportRect();
    expect(rect).toEqual({ left: 0, top: 0, width: 1280, height: 720 });
    const firstCallArg = callToolMock.mock.calls[0]?.[0];
    expect(firstCallArg?.name).toBe('evaluate_script');
    expect(String(firstCallArg?.arguments?.['function'])).toContain('#game-input-overlay');

    await mcp.clickAt(300, 400);
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'click_at',
      arguments: { x: 300, y: 400 },
    });

    await mcp.pressKey('Digit1');
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'press_key',
      arguments: { key: 'Digit1' },
    });

    await mcp.clickDomSelector('single-player-modal');
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'click',
      arguments: { selector: 'single-player-modal' },
    });

    await mcp.fillDomSelector('#lobbyIdInput', 'ABCD');
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'fill',
      arguments: { selector: '#lobbyIdInput', value: 'ABCD' },
    });

    await expect(mcp.clickAt(100, 100, { button: 'right' })).rejects.toMatchObject({
      name: 'ActuatorError',
      code: 'UNSUPPORTED_PRIMITIVE',
    });
    await expect(mcp.drag(0, 0, 100, 100)).rejects.toThrow(ActuatorError);
    await expect(mcp.wheelAt(100, 100, 0, -120)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PRIMITIVE',
    });
    await expect(mcp.holdKey('KeyW', 300)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PRIMITIVE',
    });

    await mcp.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('CdpActuator restricts Runtime.evaluate strictly to #game-input-overlay and dispatches Input events', async () => {
    const { client, mouseEvents, keyEvents, evaluateExpressions } = createMockCdpClient();
    const cdp = new CdpActuator({
      client,
      sleep: () => Promise.resolve(),
      moveSteps: 3,
    });

    const rect = await cdp.getViewportRect();
    expect(rect).toEqual({ left: 10, top: 20, width: 1200, height: 700 });
    expect(evaluateExpressions).toHaveLength(1);
    expect(evaluateExpressions[0]).toContain('#game-input-overlay');
    expect(evaluateExpressions[0]).toContain('getBoundingClientRect');

    await cdp.clickAt(500, 300, { button: 'right' });
    expect(mouseEvents.some((e) => e.type === 'mousePressed' && e.button === 'right')).toBe(true);
    expect(mouseEvents.some((e) => e.type === 'mouseReleased' && e.button === 'right')).toBe(true);

    await cdp.drag(100, 100, 400, 400, { steps: 4 });
    const movedDuringDrag = mouseEvents.filter((e) => e.type === 'mouseMoved');
    expect(movedDuringDrag.length).toBeGreaterThanOrEqual(4);

    await cdp.wheelAt(600, 350, 0, -240);
    expect(mouseEvents.some((e) => e.type === 'mouseWheel' && e.deltaY === -240)).toBe(true);

    await cdp.pressKey('Shift+KeyR');
    expect(keyEvents).toHaveLength(2);
    expect(keyEvents[0]).toMatchObject({ type: 'keyDown', code: 'KeyR', modifiers: 8 });
    expect(keyEvents[1]).toMatchObject({ type: 'keyUp', code: 'KeyR', modifiers: 8 });

    await expect(cdp.clickDomSelector('#btn')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PRIMITIVE',
    });
    await expect(cdp.fillDomSelector('#input', 'val')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PRIMITIVE',
    });
  });

  it('CdpActuator falls back to Page.getLayoutMetrics when overlay missing and throws ViewportError on invalid dimensions', async () => {
    const { client, evaluateMock, getLayoutMetricsMock } = createMockCdpClient();
    evaluateMock.mockImplementation(() =>
      Promise.resolve({ result: { type: 'object', value: null } }),
    );
    const cdp = new CdpActuator({ client });

    const rect = await cdp.getViewportRect();
    expect(rect).toEqual({ left: 0, top: 0, width: 1280, height: 720 });

    getLayoutMetricsMock.mockImplementation(() =>
      Promise.resolve({
        cssLayoutViewport: { clientWidth: 0, clientHeight: 0, pageX: 0, pageY: 0 },
      }),
    );
    await expect(cdp.getViewportRect()).rejects.toThrow(ViewportError);
  });

  it('FallbackActuator routes unsupported primitives to CDP and auto-switches clicks when MCP p95 exceeds budget', async () => {
    let nowMs = 0;
    const { caller, callToolMock } = createMockMcpCaller((params) => {
      if (params.name === 'click_at') {
        nowMs += 210;
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    });
    const mcp = new McpActuator({ client: caller });
    const { client: cdpClient, mouseEvents } = createMockCdpClient();
    const cdp = new CdpActuator({
      client: cdpClient,
      sleep: () => Promise.resolve(),
      moveSteps: 1,
    });

    const fallback = new FallbackActuator({
      mcp,
      cdp,
      mcpLatencyBudgetMs: 150,
      minSamplesForSwitch: 3,
      now: () => nowMs,
    });

    await fallback.clickAt(50, 60, { button: 'right' });
    expect(mouseEvents.some((e) => e.button === 'right')).toBe(true);

    await fallback.clickAt(100, 100);
    await fallback.clickAt(110, 110);
    await fallback.clickAt(120, 120);

    expect(fallback.getStatus().activeClickTransport).toBe('cdp');

    const mcpCallsBefore = callToolMock.mock.calls.length;
    await fallback.clickAt(130, 130);
    const mcpCallsAfter = callToolMock.mock.calls.length;
    expect(mcpCallsAfter).toBe(mcpCallsBefore);
    expect(mouseEvents.some((e) => e.x === 130 && e.y === 130)).toBe(true);
  });

  it('FallbackActuator auto-switches on MCP click error and runs benchmarkLatency', async () => {
    let nowMs = 0;
    const { caller } = createMockMcpCaller((params) => {
      if (params.name === 'click_at') {
        nowMs += 180;
        return Promise.reject(new Error('MCP IPC timeout'));
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    });
    const mcp = new McpActuator({ client: caller });
    const { client: cdpClient, mouseEvents, dispatchMouseEventMock } = createMockCdpClient();
    dispatchMouseEventMock.mockImplementation((params: CdpDispatchMouseEventParams) => {
      nowMs += 5;
      mouseEvents.push(params);
      return Promise.resolve();
    });
    const cdp = new CdpActuator({
      client: cdpClient,
      sleep: () => Promise.resolve(),
      moveSteps: 1,
    });

    const fallback = new FallbackActuator({
      mcp,
      cdp,
      mcpLatencyBudgetMs: 150,
      now: () => nowMs,
    });

    await fallback.clickAt(200, 220);
    expect(fallback.getStatus().activeClickTransport).toBe('cdp');
    expect(mouseEvents.some((e) => e.x === 200 && e.y === 220)).toBe(true);

    const bench = await fallback.benchmarkLatency(4);
    expect(bench.samples).toBe(4);
    expect(bench.mcp.errors).toBe(4);
    expect(bench.cdp.errors).toBe(0);
    expect(bench.cdp.p95Ms).toBeLessThan(150);
    expect(bench.recommendedTransport).toBe('cdp');

    await fallback.close();
  });

  it('handles MCP/CDP edge cases: modifiers, double-clicks, error propagation, and FallbackActuator pass-throughs', async () => {
    const { caller: badMcpCaller, callToolMock: badCallTool } = createMockMcpCaller();
    const badMcp = new McpActuator({ client: badMcpCaller });

    await badMcp.clickAt(10, 20, { clickCount: 2 });
    expect(badCallTool).toHaveBeenCalledWith({
      name: 'click_at',
      arguments: { x: 10, y: 20, dblClick: true },
    });
    await badMcp.pressKey('KeyR', { modifiers: ['Shift'] });
    expect(badCallTool).toHaveBeenCalledWith({
      name: 'press_key',
      arguments: { key: 'Shift+KeyR' },
    });

    await expect(badMcp.clickAt(10, 20, { modifiers: ['Control'] })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PRIMITIVE',
    });
    await expect(badMcp.pressKey('KeyW', { holdMs: 200 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PRIMITIVE',
    });

    badCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'null' }],
    });
    await expect(badMcp.getViewportRect()).rejects.toThrow(ViewportError);

    badCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{bad-json' }],
    });
    await expect(badMcp.getViewportRect()).rejects.toThrow(ViewportError);

    badCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ left: 0, top: 0, width: 0, height: 10 }) }],
    });
    await expect(badMcp.getViewportRect()).rejects.toThrow(ViewportError);

    badCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'tool crashed' }],
    });
    await expect(badMcp.clickAt(1, 2)).rejects.toMatchObject({ code: 'MCP_ERROR' });

    // CDP edge cases
    const {
      client: cdpClient,
      keyEvents,
      mouseEvents,
      dispatchMouseEventMock,
      evaluateMock,
    } = createMockCdpClient();
    const cdp = new CdpActuator({
      client: cdpClient,
      sleep: () => Promise.resolve(),
      moveSteps: 2,
    });
    await cdp.clickAt(50, 50, { modifiers: ['Control'] });
    await cdp.clickAt(150, 150);
    expect(mouseEvents.some((e) => e.type === 'mouseMoved' && e.x === 100 && e.y === 100)).toBe(true);
    await cdp.holdKey('Space', 100);
    await cdp.pressKey('Digit5');
    await cdp.pressKey('Enter');
    expect(keyEvents.some((e) => e.code === 'Space' && e.windowsVirtualKeyCode === 32)).toBe(true);
    expect(keyEvents.some((e) => e.code === 'Digit5')).toBe(true);
    expect(keyEvents.some((e) => e.code === 'Enter')).toBe(true);

    evaluateMock.mockRejectedValueOnce(new Error('Eval crashed'));
    await expect(cdp.getViewportRect()).rejects.toMatchObject({ code: 'CDP_ERROR' });

    dispatchMouseEventMock.mockRejectedValueOnce(new Error('Mouse crashed'));
    await expect(cdp.wheelAt(10, 10, 0, -100)).rejects.toMatchObject({ code: 'CDP_ERROR' });

    await cdp.close();

    // FallbackActuator healthy MCP path + pass-throughs
    let nowMs = 0;
    const { caller: fastCaller } = createMockMcpCaller(() => {
      nowMs += 10;
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify({ left: 0, top: 0, width: 800, height: 600 }) }],
      });
    });
    const fastMcp = new McpActuator({ client: fastCaller });
    const { client: healthyCdpClient, evaluateMock: healthyEvaluateMock } = createMockCdpClient();
    const healthyCdp = new CdpActuator({
      client: healthyCdpClient,
      sleep: () => Promise.resolve(),
    });
    const fallback = new FallbackActuator({
      mcp: fastMcp,
      cdp: healthyCdp,
      mcpLatencyBudgetMs: 150,
      now: () => nowMs,
    });

    expect(await fallback.getViewportRect()).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    await fallback.drag(0, 0, 50, 50);
    await fallback.wheelAt(100, 100, 0, 120);
    await fallback.pressKey('KeyM');
    await fallback.pressKey('KeyW', { holdMs: 150 });
    await fallback.holdKey('KeyA', 200);
    await fallback.clickDomSelector('host-lobby-modal');
    await fallback.fillDomSelector('#lobbyIdInput', 'XYZ');

    const healthyBench = await fallback.benchmarkLatency(3);
    expect(healthyBench.recommendedTransport).toBe('mcp');
    fallback.resetAutoSwitch();
    expect(fallback.getStatus().sampleCount).toBe(0);

    // Public HUD reading through CdpActuator & FallbackActuator
    healthyEvaluateMock.mockResolvedValueOnce({
      result: {
        type: 'object',
        value: {
          panelVisible: true,
          gameOver: false,
          goldText: '120K',
          troopsText: '30K',
          maxTroopsText: '90K',
          troopRateText: '+900/s',
          attackRatioText: '30',
          matchTimerText: '01:15',
          gameOverText: null,
        },
      },
    });
    const hud = await fallback.readPublicHud();
    expect(hud?.gold).toBe(120_000);
    expect(hud?.attack_ratio_pct).toBe(30);
    expect(healthyEvaluateMock).toHaveBeenCalledWith({
      expression: PUBLIC_HUD_READ_EXPRESSION,
      returnByValue: true,
    });

    healthyEvaluateMock.mockRejectedValueOnce(new Error('transient eval err'));
    expect(await healthyCdp.readPublicHud()).toBeNull();
  });
});
