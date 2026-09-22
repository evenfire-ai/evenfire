/**
 * @clerum/grok-provider-attempt-contract — bounded Grok completion request,
 * canonical SHA-256 hashing, and safe ticket/receipt types.
 *
 * Sibling of @clerum/llm-provider-attempt-contract. Own LIMITS and origins.
 * Does not import Codex LIMITS. Pure module: no network, credentials, or Kubernetes.
 */

export declare const SCHEMA_VERSION: 'grok-completion-request.v1'
export declare const RECEIPT_SCHEMA_VERSION: 'grok-attempt-receipt.v1'
export declare const PROVIDER_ID: 'grok-subscription'
export declare const TICKET_TYP: 'grok-execution-ticket'
export declare const TRANSPORT_PROTOCOL_VERSION: 'grok-subscription-transport.v1'
export declare const COMPLETIONS_ORIGIN: 'https://cli-chat-proxy.grok.com/v1/responses'
export declare const CATALOG_ORIGIN: 'https://cli-chat-proxy.grok.com/v1/models'

export declare const LIMITS: {
  readonly maxRequestBodyBytes: 1048576
  readonly maxMessages: 1024
  readonly maxToolCalls: 256
  readonly maxOutputTokens: 16384
  readonly maxDeadlineMs: 300000
  readonly maxIdLength: 128
  readonly maxNestingDepth: 64
}

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

export type GrokMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface GrokAssistantToolCallV1 {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface GrokMessageV1 {
  role: GrokMessageRole
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: GrokAssistantToolCallV1[]
}

export interface GrokToolDefinitionV1 {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type GrokToolChoiceV1 = 'auto' | 'none' | 'required'

export interface GrokGenerationOptionsV1 {
  temperature?: number
  maxOutputTokens?: number
  toolChoice?: GrokToolChoiceV1
}

export interface GrokTransportHintsV1 {
  promptCacheKey?: string
}

export interface GrokCompletionRequestV1 {
  schemaVersion: 'grok-completion-request.v1'
  requestId: string
  idempotencyKey: string
  provider: 'grok-subscription'
  model: string
  messages: GrokMessageV1[]
  tools?: GrokToolDefinitionV1[]
  generation?: GrokGenerationOptionsV1
  deadlineMs?: number
  transportHints?: GrokTransportHintsV1
}

export type GrokExecutionTicketClaims = {
  jti: string
  typ: 'grok-execution-ticket'
  sub: string
  hostRef: string
  recipeNamespace?: string
  recipeName?: string
  invocationId: string
  attemptGeneration: number
  providerAttemptId: string
  providerAttemptIndex: number
  provider: 'grok-subscription'
  model: string
  requestHash: string
  policyRevision: number
  policyHash: string
  budgetReservationId: string
  connectionRevision: number
  connectionId?: string
}

export type AuthorizeAttemptResponse = {
  providerAttemptId: string
  requestHash: string
  executionTicket: string
  expiresAt: string
}

export type RedeemAttemptResponse = {
  accessToken: string
  transport: GrokTransportMetadataV1
  expiryClass: 'short_lived' | 'upstream_managed'
  attemptReceipt: string
}

export type GrokTransportMetadataV1 = {
  protocolVersion: 'grok-subscription-transport.v1'
  completionsOrigin: 'https://cli-chat-proxy.grok.com/v1/responses'
  catalogOrigin: 'https://cli-chat-proxy.grok.com/v1/models'
  operation: 'completion_stream' | 'completion_cancel' | 'connection_test'
  servedModel: string
  maxStreamDurationMs: number
}

export type GrokAttemptOutcome = 'success' | 'canceled' | 'error' | 'unknown'

export type GrokAttemptReceiptV1 = {
  schemaVersion: 'grok-attempt-receipt.v1'
  providerAttemptId: string
  requestHash: string
  outcome: GrokAttemptOutcome
  usage?: { inputTokens?: number; outputTokens?: number }
}

export declare function stableStringify(value: unknown): string
export declare function parseGrokCompletionRequestV1(
  input: unknown
): ContractResult<GrokCompletionRequestV1>
export declare function hashGrokCompletionRequestV1(request: GrokCompletionRequestV1): string
/**
 * Canonical client hash: JSON wire round-trip, parseGrokCompletionRequestV1,
 * then hashGrokCompletionRequestV1 of the projection. Send `request` together
 * with `requestHash`. Never throws; invalid input returns `{ ok: false }`.
 */
export declare function hashCanonicalGrokRequest(raw: unknown): ContractResult<{
  request: GrokCompletionRequestV1
  requestHash: string
}>
export declare function computeGrokPolicyHash(input: {
  model: string
  catalogRevision: number
  credentialRevision: number
  connectionKey: string
}): string
export declare function parseGrokExecutionTicketClaims(
  input: unknown
): ContractResult<GrokExecutionTicketClaims>
export declare function parseAuthorizeAttemptResponse(
  input: unknown
): ContractResult<AuthorizeAttemptResponse>
export declare function parseGrokAttemptReceiptV1(
  input: unknown
): ContractResult<GrokAttemptReceiptV1>
