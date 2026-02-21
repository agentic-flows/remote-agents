/**
 * Shared error types
 */

/**
 * Security error types for proper error handling
 */
export const SecurityErrorType = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  RATE_LIMITED: "RATE_LIMITED",
  INVALID_INPUT: "INVALID_INPUT",
  CSRF_VIOLATION: "CSRF_VIOLATION",
} as const;

export type SecurityErrorType = (typeof SecurityErrorType)[keyof typeof SecurityErrorType];

/**
 * Rate limit types
 */
export const RateLimitType = {
  LLM_CALLS: "LLM_CALLS",
  API_CALLS: "API_CALLS",
  MESSAGES: "MESSAGES",
} as const;

export type RateLimitType = (typeof RateLimitType)[keyof typeof RateLimitType];

/**
 * Rate limit error details
 */
export interface RateLimitErrorDetails {
  message: string;
  limitType: RateLimitType;
  limit?: number;
  period?: number;
  suggestions?: string[];
}

/**
 * Custom security error class
 */
export class SecurityError extends Error {
  public type: SecurityErrorType;
  public statusCode: number;

  constructor(type: SecurityErrorType, message: string, statusCode = 401) {
    super(message);
    this.name = "SecurityError";
    this.type = type;
    this.statusCode = statusCode;
  }
}

/**
 * Rate limit exceeded error
 */
export class RateLimitExceededError extends SecurityError {
  public details: RateLimitErrorDetails;
  public limitType: RateLimitType;
  public limit?: number;
  public period?: number;
  public suggestions?: string[];

  constructor(
    message: string,
    limitType: RateLimitType,
    limit?: number,
    period?: number,
    suggestions?: string[],
  ) {
    super(SecurityErrorType.RATE_LIMITED, message, 429);
    this.name = "RateLimitExceededError";
    this.limitType = limitType;
    this.limit = limit;
    this.period = period;
    this.suggestions = suggestions;
    this.details = {
      message,
      limitType,
      limit,
      period,
      suggestions,
    };
  }

  static fromRateLimitError(error: RateLimitErrorDetails): RateLimitExceededError {
    return new RateLimitExceededError(
      error.message,
      error.limitType,
      error.limit,
      error.period,
      error.suggestions,
    );
  }
}
