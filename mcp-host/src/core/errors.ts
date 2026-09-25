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
  InvalidAttachment = 'LLM_INVALID_ATTACHMENT',
  ApiCallFailed = 'LLM_API_CALL_FAILED',
  InvalidResponse = 'LLM_INVALID_RESPONSE',
  ContextLengthExceeded = 'LLM_CONTEXT_LENGTH_EXCEEDED',
  ContentFiltered = 'LLM_CONTENT_FILTERED',
  ModelNotAvailable = 'LLM_MODEL_NOT_AVAILABLE',
  InsufficientQuota = 'LLM_INSUFFICIENT_QUOTA',
  RateLimited = 'LLM_RATE_LIMITED',
  AuthenticationFailed = 'LLM_AUTHENTICATION_FAILED',
  ModelOverloaded = 'LLM_MODEL_OVERLOADED',
  /**
   * Issue #720 — no control-plane process answered one hop of a subscription
   * turn. mcp-host sets it from the JSON code `control_plane_unavailable`,
   * never from an HTTP status. That code comes from a connect-phase failure
   * (refused, unresolvable or timed-out connect) to the authorize gateway or a
   * subscription proxy, from a proxy that could not reach control-api on
   * redeem, or from the 503 JSON body the authorize and rpc gateways answer in
   * place of their own 502. Retryable, with the failover class
   * `provider_unavailable`; only the label differs from
   * {@link LlmErrorCode.ModelOverloaded}.
   */
  ControlPlaneUnavailable = 'LLM_CONTROL_PLANE_UNAVAILABLE',
  /**
   * Issue #720 — a subscription proxy reported `upstream_rejected`: the
   * provider answered a 4xx the proxy has no specific code for (Grok 402/403
   * entitlement, 404, 409, 422). The same request gets the same answer, so it
   * is not retryable and never fails over.
   */
  UpstreamRejected = 'LLM_UPSTREAM_REJECTED',
  /** One model response asked for more tool calls than the provider contract allows. */
  ToolCallLimitExceeded = 'LLM_TOOL_CALL_LIMIT_EXCEEDED',
  /**
   * The provider proxy cut one attempt at its total stream duration cap.
   * Terminal: a retry would spend the same budget again, so it is never
   * retryable and never failover-eligible. Idle silence is a different code
   * (`provider_unavailable`), which stays retryable.
   */
  StreamDurationExceeded = 'LLM_STREAM_DURATION_EXCEEDED',
  /**
   * Issue #654 — the selected (provider, model) is known NOT to accept the
   * image carried by this attempt (model evidence `unsupported`, selection
   * policy denial, or a transport path whose serializer would drop it).
   * Terminal: never retryable, never failover-eligible
   * (`classifyFailoverClass` returns null for it).
   */
  ImageInputUnsupported = 'LLM_IMAGE_INPUT_UNSUPPORTED',
  /**
   * Issue #654 — a required datum for the image decision is missing, stale or
   * not yet valid (no evidence, malformed metadata, expired `validUntil`).
   * Terminal for the same reasons as {@link LlmErrorCode.ImageInputUnsupported};
   * text-only requests are unaffected and are never classified with this code.
   */
  ImageInputUnknown = 'LLM_IMAGE_INPUT_UNKNOWN',
  /**
   * Issue #654 — a piggybacked per-session model selection lost the
   * compare-and-swap against the persisted revision, or carried a revision the
   * Host cannot interpret. It says nothing about image capability: the client
   * re-reads the current selection and sends again, so it is RETRYABLE.
   */
  ModelSelectionConflict = 'LLM_MODEL_SELECTION_CONFLICT',
  /**
   * Issue #654 — a piggybacked per-session model selection names a model this
   * Host's allowlist no longer admits. Terminal: retrying the same pick cannot
   * succeed, the user must choose another model.
   */
  ModelNotAllowed = 'LLM_MODEL_NOT_ALLOWED',
}

/**
 * Issue #666 — rejections of an inline `kind:'file'` attachment at admission.
 * All terminal: resending the same bytes cannot succeed. No code rejects a file
 * for its type; an unreadable class is admitted and reported as `reader:'none'`.
 */
export enum FileAttachmentErrorCode {
  /** Shape, encoding, declared size or file name is invalid. */
  Invalid = 'FILE_ATTACHMENT_INVALID',
  /** The decoded file exceeds `CLERUM_ATTACHMENT_FILE_MAX_BYTES`. */
  TooLarge = 'FILE_ATTACHMENT_TOO_LARGE',
  /** The recomputed sha256 differs from the declared digest. */
  DigestMismatch = 'FILE_ATTACHMENT_DIGEST_MISMATCH',
}

/**
 * Issue #666 — structured file references on an incoming message.
 * `SchemaVersionUnsupported` and `Invalid` reject the message (terminal).
 * `CheckFailed` rejects it because the Host could not ask gfsc about the
 * references. The remaining codes name an availability the Host resolved; the
 * message is still admitted and the reference is listed with that availability
 * in the turn.
 */
export enum FileReferenceErrorCode {
  /** The reference declares a `schemaVersion` this Host does not implement. */
  SchemaVersionUnsupported = 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED',
  /** Shape, count or GFS identity of the reference is invalid. */
  Invalid = 'FILE_REFERENCE_INVALID',
  NotFound = 'FILE_REFERENCE_NOT_FOUND',
  Denied = 'FILE_REFERENCE_DENIED',
  /** The file changed since the reference was taken. */
  Stale = 'FILE_REFERENCE_STALE',
  NotAFile = 'FILE_REFERENCE_NOT_A_FILE',
  TooLarge = 'FILE_REFERENCE_TOO_LARGE',
  /** The Host cannot serve this reference (no `gfs.read` scope, or not a GFS source). */
  Unsupported = 'FILE_REFERENCE_UNSUPPORTED',
  /**
   * gfsc could not be asked, or its answer could not be used: retryable only
   * when the failure was transient (timeout, network, 429, 5xx).
   */
  CheckFailed = 'FILE_REFERENCE_CHECK_FAILED',
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
