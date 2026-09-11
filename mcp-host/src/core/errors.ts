/**
 * Typed error hierarchy for the Clerum agent architecture.
 *
 * Each layer has its own error class with typed error codes
 * for programmatic handling at layer boundaries.
 *
 * Phase 1: Error definitions only — no runtime changes.
 */

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

// ─── LLM Errors ─────────────────────────────────────────────

export enum LlmErrorCode {
  ApiCallFailed = 'LLM_API_CALL_FAILED',
  InvalidResponse = 'LLM_INVALID_RESPONSE',
  ContextLengthExceeded = 'LLM_CONTEXT_LENGTH_EXCEEDED',
  ContentFiltered = 'LLM_CONTENT_FILTERED',
  ModelNotAvailable = 'LLM_MODEL_NOT_AVAILABLE',
  InsufficientQuota = 'LLM_INSUFFICIENT_QUOTA',
  RateLimited = 'LLM_RATE_LIMITED',
  AuthenticationFailed = 'LLM_AUTHENTICATION_FAILED',
  ModelOverloaded = 'LLM_MODEL_OVERLOADED',
}

export class LlmError extends AgentError {
  constructor(
    message: string,
    public readonly provider: string,
    code: LlmErrorCode,
    /** True when the caller may safely retry the entire request after a delay. */
    public readonly retryable: boolean,
    cause?: Error,
    /**
     * Additive diagnostics (spec 02, Pieza A). The provider HTTP status and the
     * provider-native error code/type that produced `code`, threaded from
     * `ClassifiedError` down to `TaskError`. Optional so existing call sites
     * (positional, all args before these) remain unchanged.
     */
    public readonly httpStatus?: number,
    public readonly providerCode?: string
  ) {
    super(message, code, cause)
    this.name = 'LlmError'
  }
}

// ─── Tool Errors ────────────────────────────────────────────

export enum ToolErrorCode {
  NotFound = 'TOOL_NOT_FOUND',
  ExecutionFailed = 'TOOL_EXECUTION_FAILED',
  Timeout = 'TOOL_TIMEOUT',
  InvalidParams = 'TOOL_INVALID_PARAMS',
  ApprovalDenied = 'TOOL_APPROVAL_DENIED',
}

export class ToolError extends AgentError {
  constructor(
    message: string,
    public readonly toolName: string,
    code: ToolErrorCode,
    cause?: Error
  ) {
    super(message, code, cause)
    this.name = 'ToolError'
  }
}

// ─── Safety Errors ──────────────────────────────────────────

export enum SafetyErrorCode {
  InputBlocked = 'SAFETY_INPUT_BLOCKED',
  ParamsRejected = 'SAFETY_PARAMS_REJECTED',
  SanitizationFailed = 'SAFETY_SANITIZATION_FAILED',
}

export class SafetyError extends AgentError {
  constructor(message: string, code: SafetyErrorCode, cause?: Error) {
    super(message, code, cause)
    this.name = 'SafetyError'
  }
}

// ─── Conversation Errors ────────────────────────────────────

export enum ConversationErrorCode {
  InvalidTransition = 'CONV_INVALID_TRANSITION',
  NotFound = 'CONV_NOT_FOUND',
  ConcurrentMutation = 'CONV_CONCURRENT_MUTATION',
  OwnershipMismatch = 'CONV_OWNERSHIP_MISMATCH',
}

export class ConversationError extends AgentError {
  constructor(message: string, code: ConversationErrorCode, cause?: Error) {
    super(message, code, cause)
    this.name = 'ConversationError'
  }
}
