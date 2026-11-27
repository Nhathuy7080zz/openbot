import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { ActuatorError, ViewportError } from '../errors/app-error.js';
import type { CanvasRect } from '../game/coordinate-mapper.js';
import type {
  BrowserActuator,
  ClickOptions,
  DragOptions,
  KeyHoldOptions,
  KeyModifier,
  KeyPressOptions,
  WheelOptions,
} from './actuator.js';

/**
 * Strictly read-only script for reading #game-input-overlay bounding rect via chrome-devtools-mcp.
 */
const OVERLAY_RECT_FUNCTION = `() => {
  const overlay = document.querySelector('#game-input-overlay');
  if (!overlay) return null;
  const rect = overlay.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}`;

const OverlayRectSchema = z.object({
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export interface McpToolCallResult {
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  readonly isError?: boolean;
}

export interface McpToolCaller {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface McpActuatorOptions {
  readonly client: McpToolCaller;
}

export interface McpConnectOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly browserUrl?: string;
}

function formatMcpKey(key: string, modifiers?: readonly KeyModifier[]): string {
  if (!modifiers || modifiers.length === 0) {
    return key;
  }
  return `${modifiers.join('+')}+${key}`;
}

function extractTextContent(result: McpToolCallResult): string {
  if (!result.content || result.content.length === 0) {
    return '';
  }
  return result.content
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text ?? '')
    .join('\n')
    .trim();
}

/**
 * chrome-devtools-mcp adapter wrapping @modelcontextprotocol/sdk baseline primitives.
 * Explicitly throws ActuatorError(UNSUPPORTED_PRIMITIVE) for canvas right-click, drag, wheel, and holdKey.
 */
export class McpActuator implements BrowserActuator {
  private readonly client: McpToolCaller;

  constructor(options: McpActuatorOptions) {
    this.client = options.client;
  }

  static async connect(options: McpConnectOptions = {}): Promise<McpActuator> {
    const command = options.command ?? 'npx';
    const browserUrl = options.browserUrl ?? 'http://127.0.0.1:9222';
    const args = options.args
      ? [...options.args]
      : ['-y', 'chrome-devtools-mcp@latest', `--browser-url=${browserUrl}`];

    const transport = new StdioClientTransport({
      command,
      args,
    });
    const client = new Client({
      name: 'openbot-mcp-actuator',
      version: '0.1.0',
    });

    try {
      await client.connect(transport);
    } catch (error) {
      throw new ActuatorError('Failed to connect to chrome-devtools-mcp', 'CONNECTION_ERROR', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return new McpActuator({
      client: {
        callTool: async (params) => {
          const result = await client.callTool(params);
          return result as McpToolCallResult;
        },
        close: async () => {
          await client.close();
        },
      },
    });
  }

  async getViewportRect(): Promise<CanvasRect> {
    const result = await this.invokeTool('evaluate_script', {
      function: OVERLAY_RECT_FUNCTION,
    });

    const rawText = extractTextContent(result);
    if (rawText.length === 0 || rawText === 'null') {
      throw new ViewportError('#game-input-overlay element not found or returned empty rect');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw new ViewportError('Failed to parse #game-input-overlay rect from MCP evaluate_script', {
        rawText,
      });
    }

    const validated = OverlayRectSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new ViewportError('Invalid #game-input-overlay rect returned by MCP', {
        issues: validated.error.issues,
      });
    }

    return validated.data;
  }

  async clickAt(x: number, y: number, options?: ClickOptions): Promise<void> {
    const button = options?.button ?? 'left';
    if (button !== 'left') {
      throw new ActuatorError(
        `chrome-devtools-mcp does not support canvas ${button}-click`,
        'UNSUPPORTED_PRIMITIVE',
        { button, x, y },
      );
    }
    if (options?.modifiers && options.modifiers.length > 0) {
      throw new ActuatorError(
        'chrome-devtools-mcp click_at does not support keyboard modifiers',
        'UNSUPPORTED_PRIMITIVE',
        { modifiers: options.modifiers, x, y },
      );
    }

    const args: Record<string, unknown> = { x, y };
    if (options?.clickCount === 2) {
      args['dblClick'] = true;
    }

    await this.invokeTool('click_at', args);
  }

  drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    _options?: DragOptions,
  ): Promise<void> {
    return Promise.reject(
      new ActuatorError(
        'chrome-devtools-mcp does not support coordinate drag',
        'UNSUPPORTED_PRIMITIVE',
        { fromX, fromY, toX, toY },
      ),
    );
  }

  wheelAt(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    _options?: WheelOptions,
  ): Promise<void> {
    return Promise.reject(
      new ActuatorError(
        'chrome-devtools-mcp does not support mouse wheel zoom',
        'UNSUPPORTED_PRIMITIVE',
        { x, y, deltaX, deltaY },
      ),
    );
  }

  async pressKey(key: string, options?: KeyPressOptions): Promise<void> {
    if (options?.holdMs !== undefined && options.holdMs > 0) {
      throw new ActuatorError(
        'chrome-devtools-mcp press_key does not support timed key holds',
        'UNSUPPORTED_PRIMITIVE',
        { key, holdMs: options.holdMs },
      );
    }

    await this.invokeTool('press_key', {
      key: formatMcpKey(key, options?.modifiers),
    });
  }

  holdKey(key: string, durationMs: number, _options?: KeyHoldOptions): Promise<void> {
    return Promise.reject(
      new ActuatorError(
        'chrome-devtools-mcp does not support sustained key holds',
        'UNSUPPORTED_PRIMITIVE',
        { key, durationMs },
      ),
    );
  }

  async clickDomSelector(selector: string): Promise<void> {
    await this.invokeTool('click', { selector });
  }

  async fillDomSelector(selector: string, value: string): Promise<void> {
    await this.invokeTool('fill', { selector, value });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async invokeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    try {
      const result = await this.client.callTool({ name, arguments: args });
      if (result.isError) {
        throw new ActuatorError(
          `MCP tool "${name}" returned an error`,
          'MCP_ERROR',
          { name, message: extractTextContent(result) },
        );
      }
      return result;
    } catch (error) {
      if (error instanceof ActuatorError) {
        throw error;
      }
      throw new ActuatorError(
        `MCP tool "${name}" failed`,
        'MCP_ERROR',
        {
          name,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}
