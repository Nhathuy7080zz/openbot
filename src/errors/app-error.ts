/**
 * Base application error carrying a machine-readable error code and HTTP-style status code.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when environment variables, CLI flags, or URLs fail schema validation.
 */
export class ConfigValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_VALIDATION_ERROR', 422, details);
  }
}

/**
 * Raised when a target URL violates the local/private matchmaking fair-play guard.
 */
export class FairPlayGuardError extends AppError {
  constructor(targetUrl: string, reason: string) {
    super(
      `Blocked target "${targetUrl}": ${reason}`,
      'FAIR_PLAY_GUARD_BLOCKED',
      403,
      { targetUrl, reason },
    );
  }
}

/**
 * Raised when an incoming Gemini tool call envelope or tool arguments fail schema validation.
 */
export class ToolValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'TOOL_VALIDATION_ERROR', 422, details);
  }
}

/**
 * Raised when the non-blocking token-bucket rate limiter has no available capacity.
 */
export class RateLimitExceededError extends AppError {
  constructor(
    public readonly retryAfterMs: number,
    message = `Rate limit exceeded; retry after ${retryAfterMs}ms`,
  ) {
    super(message, 'RATE_LIMIT_EXCEEDED', 429, { retryAfterMs });
  }
}

export type ActuatorErrorCode =
  | 'UNSUPPORTED_PRIMITIVE'
  | 'MCP_ERROR'
  | 'CDP_ERROR'
  | 'CONNECTION_ERROR'
  | 'ACTUATOR_ERROR';

/**
 * Raised when browser actuation fails or an actuator does not support a requested primitive.
 */
export class ActuatorError extends AppError {
  constructor(
    message: string,
    code: ActuatorErrorCode = 'ACTUATOR_ERROR',
    details?: unknown,
    statusCode: number = code === 'UNSUPPORTED_PRIMITIVE' ? 501 : 502,
  ) {
    super(message, code, statusCode, details);
  }
}

/**
 * Raised when normalized coordinates, pixel coordinates, or viewport rect dimensions are invalid.
 */
export class ViewportError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'VIEWPORT_ERROR', 422, details);
  }
}
