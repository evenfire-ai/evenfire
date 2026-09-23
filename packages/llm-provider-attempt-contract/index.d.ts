/**
 * @clerum/llm-provider-attempt-contract — bounded Codex completion request,
 * canonical SHA-256 hashing, and safe ticket/receipt types.
 *
 * Pure module: no network clients, no credential material, no Kubernetes.
 * Hashing uses the same lexicographic stableStringify semantics as
 * control-api/src/utils/stableStringify.ts. Non-finite numbers are rejected
 * before hashing (stringify would otherwise coerce them to null).
 *
 * Two request versions share one dispatcher and one hash:
 * `codex-completion-request.v1` (text messages, unchanged) and
 * `codex-completion-request.v2` (the same closed root plus optional ordered
 * `contentParts` on user messages). V2 shares the V1 root field set on
 * purpose: it is not a looser schema.
 *
 * Two size ceilings, one policy: V1 keeps the 1 MiB body ceiling, and V2 raises
 * it to 24 MiB so one exceptional 2048-px image larger than 10 MiB still fits
 * after base64. Everything a caller writes that is not image data — content,
 * tool definitions, ids — stays on the 1 MiB budget in both versions, and
 * `requestBodyLimitBytes` is the number a pre-parse HTTP body cap should use.
 */

export declare const SCHEMA_VERSION: 'codex-completion-request.v1'
export declare const SCHEMA_VERSION_V2: 'codex-completion-request.v2'
export declare const RECEIPT_SCHEMA_VERSION: 'codex-attempt-receipt.v1'
export declare const PROVIDER_ID: 'codex-subscription'
export declare const TICKET_TYP: 'codex-execution-ticket'

export declare const LIMITS: {
  /** V1 ceiling, and the V2 ceiling for everything that is not image data. */
  readonly maxRequestBodyBytes: 1048576
  /** V2 request/envelope ceiling; covers image payloads plus the V1 share. */
  readonly maxVisualRequestBodyBytes: 25165824
  readonly maxMessages: 1024
  readonly maxToolCalls: 256
  readonly maxOutputTokens: 16384
  readonly maxDeadlineMs: 1800000
  readonly maxIdLength: 128
  readonly maxNestingDepth: 64
}

/**
 * Conservative local safety/product budgets for V2 image parts. These are
 * deliberately not upstream facts: the frozen ChatGPT endpoint is not
 * certified by these numbers. `typical*` is the usual 2048 JPEG/PNG target;
 * `max*` is the hard ceiling so one poorly compressed 2048 PNG may exceed
 * 10 MiB. Model vision capability is owned by issue #654 / PR #669.
 */
export declare const VISUAL_LIMITS: {
  readonly maxImages: 20,
  readonly typicalImageBytes: 5242880
  readonly typicalTotalImageBytes: 9437184
  readonly typicalEnvelopeBytes: 14680064
  readonly maxImageBytes: 16777216
  readonly maxTotalImageBytes: 16777216
  readonly maxImageDimension: 2048
  readonly maxImagePixels: 4194304
}

export type ContractLimitKind = 'size' | 'range' | 'count' | 'depth'

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; kind?: ContractLimitKind }

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

export interface CodexMessagePartTextV2 {
  type: 'text'
  text: string
}

/**
 * Minimal provenance for a V2 image part. Closed union: an attachment that
 * arrived with a user message, or one produced by a tool call. It is hashed
 * with the rest of the part and never becomes model text.
 */
export type CodexImageSourceV2 =
  | { kind: 'attachment'; attachmentId: string; messageId: string }
  | { kind: 'tool'; attachmentId: string; toolCallId: string }

export interface CodexMessagePartImageV2 {
  type: 'image'
  mimeType: 'image/jpeg' | 'image/png'
  /** Strict canonical base64 of a structurally valid PNG/JPEG container. */
  data: string
  source: CodexImageSourceV2
}

export type CodexMessagePartV2 = CodexMessagePartTextV2 | CodexMessagePartImageV2

/**
 * V2 message. `contentParts` is optional and only allowed on user messages.
 * When present, the text parts joined with `\n` must equal `content`
 * (an image-only message therefore carries `content: ''`), so the textual and
 * part projections cannot contradict each other. A parts array may be
 * text-only after compaction; it does not have to keep an image.
 */
export interface CodexMessageV2 {
  role: CodexMessageRole
  content: string
  contentParts?: CodexMessagePartV2[]
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

export interface CodexCompletionRequestV2 {
  schemaVersion: 'codex-completion-request.v2'
  requestId: string
  idempotencyKey: string
  provider: 'codex-subscription'
  model: string
  messages: CodexMessageV2[]
  tools?: CodexToolDefinitionV1[]
  generation?: CodexGenerationOptionsV1
  deadlineMs?: number
  transportHints?: CodexTransportHintsV1
}

export type CodexCompletionRequest = CodexCompletionRequestV1 | CodexCompletionRequestV2

/**
 * Exact body the control-api authorizer hands to the Codex proxy. The outer
 * `deadlineMs` is never emitted: a V2 request carries its deadline in
 * `request.deadlineMs`, already bound by the request hash.
 */
export interface CodexProxyEnvelope {
  executionTicket: string
  requestHash: string
  request: CodexCompletionRequest
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
  connectionId?: string
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
/**
 * Byte ceiling for a request body, or for the envelope that carries it, applied
 * BEFORE parsing: 24 MiB for a document that declares
 * `codex-completion-request.v2`, 1 MiB for anything else. Declaring V2 does not
 * raise the budget for text or tool definitions — the parser measures the body
 * with every image payload blanked and keeps that share on the 1 MiB ceiling.
 */
export declare function requestBodyLimitBytes(request: unknown): number
/**
 * Byte length of an authorize document after every image payload inside
 * `body.request` is blanked. Wrapper fields stay on the 1 MiB non-image
 * budget even when the nested request declares V2.
 */
export declare function measureNonImageAuthorizeBytes(body: unknown): number
/**
 * Byte length of a proxy completion document after image payloads inside
 * `body.request` are blanked and `executionTicket` is omitted. The ticket is
 * issued after authorize, so it must not consume the 1 MiB non-image budget
 * that authorize already applied to the pre-ticket wrapper.
 */
export declare function measureNonImageCompletionBytes(body: unknown): number
/** Closed identifier used by request ids, ticket claims, and authorize ids. */
export declare function isBoundedId(value: unknown): value is string
export declare function parseCodexCompletionRequestV1(
  input: unknown
): ContractResult<CodexCompletionRequestV1>
export declare function parseCodexCompletionRequestV2(
  input: unknown
): ContractResult<CodexCompletionRequestV2>
export declare function parseCodexCompletionRequest(
  input: unknown
): ContractResult<CodexCompletionRequest>
export declare function hashCodexCompletionRequestV1(request: CodexCompletionRequestV1): string
export declare function hashCodexCompletionRequest(request: CodexCompletionRequest): string
/**
 * Canonical client hash: JSON wire round-trip, parseCodexCompletionRequest
 * (v1 or v2), then hashCodexCompletionRequest of the projection. Send
 * `request` together with `requestHash`. Never throws; invalid input returns
 * `{ ok: false }`.
 */
export declare function hashCanonicalCodexRequest(raw: unknown): ContractResult<{
  request: CodexCompletionRequest
  requestHash: string
}>
export declare function buildCodexProxyEnvelope(input: {
  executionTicket: string
  requestHash: string
  request: CodexCompletionRequest
}): ContractResult<CodexProxyEnvelope>
export declare function computeCodexPolicyHash(input: {
  model: string
  catalogRevision: number
  credentialRevision: number
  connectionKey?: string
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
