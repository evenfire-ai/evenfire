/**
 * @clerum/grok-provider-attempt-contract — bounded Grok completion request,
 * canonical SHA-256 hashing, and safe ticket/receipt types.
 *
 * Sibling of @clerum/llm-provider-attempt-contract. Own LIMITS and origins.
 * Does not import Codex LIMITS. Pure module: no network, credentials, or Kubernetes.
 */

export declare const SCHEMA_VERSION: 'grok-completion-request.v1'
/**
 * V2 adds typed visual parts (`contentParts` on user messages). V2 shares the
 * V1 root field set; its body ceiling is `LIMITS.maxVisualRequestBodyBytes`,
 * and the non-image share of the body stays on `LIMITS.maxRequestBodyBytes`.
 */
export declare const SCHEMA_VERSION_V2: 'grok-completion-request.v2'
export declare const RECEIPT_SCHEMA_VERSION: 'grok-attempt-receipt.v1'
export declare const PROVIDER_ID: 'grok-subscription'
export declare const TICKET_TYP: 'grok-execution-ticket'
export declare const TRANSPORT_PROTOCOL_VERSION: 'grok-subscription-transport.v1'
export declare const COMPLETIONS_ORIGIN: 'https://cli-chat-proxy.grok.com/v1/responses'
export declare const CATALOG_ORIGIN: 'https://cli-chat-proxy.grok.com/v1/models'

export declare const LIMITS: {
  /** V1 ceiling, and the V2 ceiling for everything that is not image data. */
  readonly maxRequestBodyBytes: 8388608
  /** V2 request/envelope ceiling; covers image payloads plus the non-image share. */
  readonly maxVisualRequestBodyBytes: 36700160
  readonly maxMessages: 1024
  readonly maxToolCalls: 256
  readonly maxOutputTokens: 16384
  readonly maxDeadlineMs: 1800000
  readonly maxIdLength: 128
  readonly maxNestingDepth: 64
  /** Execution ticket TTL; control-api signs Grok tickets with it. */
  readonly executionTicketTtlMs: 60000
}

/**
 * Room for the runtime envelope around a request held to
 * `LIMITS.maxRequestBodyBytes`. Equal to the Codex contract's value, which
 * control-api and mcp-host share across both providers.
 */
export declare const ENVELOPE_ALLOWANCE_BYTES: 16384

/**
 * Budgets for V2 image parts, from the xAI documentation for api.x.ai/v1
 * (20 MiB per image; the 20-image, 20 MiB per-request budget is a local
 * product decision). cli-chat-proxy.grok.com/v1/responses is unmeasured for
 * images. There is no dimension or pixel limit.
 */
export declare const GROK_VISUAL_LIMITS: {
  readonly maxImages: 20
  readonly maxImageBytes: 20971520
  readonly maxTotalImageBytes: 20971520
}

/**
 * `size`: a byte budget refused (payload_too_large). `count`: the V2 image
 * count refused. Every other failure carries no kind.
 */
export type ContractLimitKind = 'size' | 'count'

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; kind?: ContractLimitKind }

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

export interface GrokMessagePartTextV2 {
  type: 'text'
  text: string
}

/**
 * Minimal provenance for a V2 image part. Closed union: an attachment that
 * arrived with a user message, or one produced by a tool call. It is hashed
 * with the rest of the part, never becomes model text and is never sent
 * upstream.
 */
export type GrokImageSourceV2 =
  | { kind: 'attachment'; attachmentId: string; messageId: string }
  | { kind: 'tool'; attachmentId: string; toolCallId: string }

export interface GrokMessagePartImageV2 {
  type: 'image'
  mimeType: 'image/jpeg' | 'image/png'
  /** Strict canonical base64 of a structurally valid PNG/JPEG container. */
  data: string
  source: GrokImageSourceV2
}

export type GrokMessagePartV2 = GrokMessagePartTextV2 | GrokMessagePartImageV2

/**
 * V2 message. `contentParts` is optional and only allowed on user messages.
 * When present, the text parts joined with `\n` must equal `content`
 * (an image-only message therefore carries `content: ''`). A parts array may
 * be text-only after compaction.
 */
export interface GrokMessageV2 {
  role: GrokMessageRole
  content: string
  contentParts?: GrokMessagePartV2[]
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

export interface GrokCompletionRequestV2 {
  schemaVersion: 'grok-completion-request.v2'
  requestId: string
  idempotencyKey: string
  provider: 'grok-subscription'
  model: string
  messages: GrokMessageV2[]
  tools?: GrokToolDefinitionV1[]
  generation?: GrokGenerationOptionsV1
  deadlineMs?: number
  transportHints?: GrokTransportHintsV1
}

export type GrokCompletionRequest = GrokCompletionRequestV1 | GrokCompletionRequestV2

/**
 * Exact body the control-api authorizer hands to the Grok proxy. The outer
 * `deadlineMs` is never emitted: a V2 request carries its deadline in
 * `request.deadlineMs`, already bound by the request hash.
 */
export interface GrokProxyEnvelope {
  executionTicket: string
  requestHash: string
  request: GrokCompletionRequest
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
/**
 * Byte ceiling for a request body, or for the envelope that carries it, applied
 * BEFORE parsing: 35 MiB for a document that declares
 * `grok-completion-request.v2`, `maxRequestBodyBytes` (8 MiB) for anything
 * else. Declaring V2 does not raise the budget for text or tool definitions —
 * the parser measures the body with every image payload blanked and keeps that
 * share on the `maxRequestBodyBytes` ceiling.
 */
export declare function requestBodyLimitBytes(request: unknown): number
/**
 * Byte length of an authorize document after every image payload inside
 * `body.request` is blanked. Wrapper fields stay on the non-image budget
 * even when the nested request declares V2.
 */
export declare function measureNonImageAuthorizeBytes(body: unknown): number
/**
 * Byte length of a proxy completion document after image payloads inside
 * `body.request` are blanked and `executionTicket` is omitted. The ticket is
 * issued after authorize, so it must not consume the non-image budget
 * that authorize already applied to the pre-ticket wrapper.
 */
export declare function measureNonImageCompletionBytes(body: unknown): number
export declare function parseGrokCompletionRequestV1(
  input: unknown
): ContractResult<GrokCompletionRequestV1>
export declare function parseGrokCompletionRequestV2(
  input: unknown
): ContractResult<GrokCompletionRequestV2>
export declare function parseGrokCompletionRequest(
  input: unknown
): ContractResult<GrokCompletionRequest>
export declare function hashGrokCompletionRequestV1(request: GrokCompletionRequestV1): string
export declare function hashGrokCompletionRequest(request: GrokCompletionRequest): string
/**
 * Canonical client hash: JSON wire round-trip, parseGrokCompletionRequest
 * (v1 or v2), then hashGrokCompletionRequest of the projection. Send
 * `request` together with `requestHash`. Never throws; invalid input returns
 * `{ ok: false }`.
 */
export declare function hashCanonicalGrokRequest(raw: unknown): ContractResult<{
  request: GrokCompletionRequest
  requestHash: string
}>
export declare function buildGrokProxyEnvelope(input: {
  executionTicket: string
  requestHash: string
  request: GrokCompletionRequest
}): ContractResult<GrokProxyEnvelope>
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
