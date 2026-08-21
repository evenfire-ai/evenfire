/**
 * @clerum/llm-provider-attempt-contract — bounded Codex completion request,
 * canonical SHA-256 hashing, and safe ticket/receipt types.
 *
 * Pure module: no network clients, no credential material, no Kubernetes.
 * Hashing uses the same lexicographic stableStringify semantics as
 * control-api/src/utils/stableStringify.ts. Non-finite numbers are rejected
 * before hashing (stringify would otherwise coerce them to null).
 */

export declare const SCHEMA_VERSION: 'codex-completion-request.v1'
export declare const RECEIPT_SCHEMA_VERSION: 'codex-attempt-receipt.v1'
export declare const PROVIDER_ID: 'codex-subscription'
export declare const TICKET_TYP: 'codex-execution-ticket'

export declare const LIMITS: {
  readonly maxRequestBodyBytes: 1048576
  readonly maxMessages: 128
  readonly maxTools: 32
  readonly maxOutputTokens: 16384
  readonly maxDeadlineMs: 300000
  readonly maxIdLength: 128
}

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

export type CodexMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface CodexAssistantToolCallV1 {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface CodexMessageV1 {
  role: CodexMessageRole
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: CodexAssistantToolCallV1[]
}

export interface CodexToolDefinitionV1 {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type CodexToolChoiceV1 = 'auto' | 'none' | 'required'

export interface CodexGenerationOptionsV1 {
  temperature?: number
  maxOutputTokens?: number
  toolChoice?: CodexToolChoiceV1
}

export interface CodexTransportHintsV1 {
  promptCacheKey?: string
}

export interface CodexCompletionRequestV1 {
  schemaVersion: 'codex-completion-request.v1'
  requestId: string
  idempotencyKey: string
  provider: 'codex-subscription'
  model: string
  messages: CodexMessageV1[]
  tools?: CodexToolDefinitionV1[]
  generation?: CodexGenerationOptionsV1
  deadlineMs?: number
  transportHints?: CodexTransportHintsV1
}

export type CodexExecutionTicketClaims = {
  jti: string
  typ: 'codex-execution-ticket'
  sub: string
  hostRef: string
  recipeNamespace?: string
  recipeName?: string
  invocationId: string
  attemptGeneration: number
  providerAttemptId: string
  providerAttemptIndex: number
  provider: 'codex-subscription'
  model: string
  requestHash: string
  policyRevision: number
  policyHash: string
  budgetReservationId: string
  connectionRevision: number
}

export type AuthorizeAttemptResponse = {
  providerAttemptId: string
  requestHash: string
  executionTicket: string
  expiresAt: string
}

/**
 * Gateway→proxy only. Never log, persist, or return this object to mcp-host
 * or the browser. The contract package does not parse it.
 */
export type RedeemAttemptResponse = {
  accessToken: string
  transport: CodexTransportMetadataV1
  expiryClass: 'short_lived' | 'upstream_managed'
  attemptReceipt: string
}

export type CodexTransportMetadataV1 = {
  protocolVersion: 'codex-subscription-transport.v1'
  completionsOrigin: 'https://chatgpt.com/backend-api/codex/responses'
  catalogOrigin: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0'
  operation: 'completion_stream' | 'completion_cancel' | 'connection_test'
  servedModel: string
  maxStreamDurationMs: number
}

export type CodexAttemptOutcome = 'success' | 'canceled' | 'error' | 'unknown'

export type CodexAttemptReceiptV1 = {
  schemaVersion: 'codex-attempt-receipt.v1'
  providerAttemptId: string
  requestHash: string
  outcome: CodexAttemptOutcome
  usage?: { inputTokens?: number; outputTokens?: number }
}

export declare function stableStringify(value: unknown): string
export declare function parseCodexCompletionRequestV1(
  input: unknown
): ContractResult<CodexCompletionRequestV1>
export declare function hashCodexCompletionRequestV1(
  request: CodexCompletionRequestV1
): string
export declare function computeCodexPolicyHash(input: {
  model: string
  catalogRevision: number
  credentialRevision: number
}): string
export declare function parseCodexExecutionTicketClaims(
  input: unknown
): ContractResult<CodexExecutionTicketClaims>
export declare function parseAuthorizeAttemptResponse(
  input: unknown
): ContractResult<AuthorizeAttemptResponse>
export declare function parseCodexAttemptReceiptV1(
  input: unknown
): ContractResult<CodexAttemptReceiptV1>
