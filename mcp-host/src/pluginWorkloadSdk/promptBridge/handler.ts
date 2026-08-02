import { randomUUID } from 'crypto'
import { PluginWorkloadError } from '../domain/errors'
import {
  DEFAULT_IDEMPOTENCY_KEY_PATTERN,
  DEFAULT_MAX_REQUEST_CONTENT_BYTES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  PLUGIN_WORKLOAD_SDK_PURPOSES,
  type PromptBridgeRequest,
  type PromptBridgeResult,
  type PromptBridgeTarget,
} from '../domain/types'
import {
  pluginSdkPromptBridgeDurationSeconds,
  pluginSdkPromptBridgeRequestsTotal,
  pluginSdkPromptBridgeTokensTotal,
} from '../metrics'
import type { PluginWorkloadSdkControlApiClient } from './controlApiClient'
import type { LlmBridge } from './llmBridge'

/**
 * promptBridge handler (plan §3.3): synchronous with bounded timeout.
 *
 *   1. Validate input (purpose enum, idempotency key pattern, content cap).
 *   2. Authorize through control-api via the anti-corruption layer.
 *   3. Call the co-located LLM bridge (provider bound to this mcp-host).
 *   4. Report completion status back to the audit trail (best-effort).
 *   5. Return PromptBridgeResult — or a PluginWorkloadError (spec §15).
 *
 * v1 invariant: inference-only. No tools, no conversational session.
 */

const IDEMPOTENCY_KEY_RE = new RegExp(DEFAULT_IDEMPOTENCY_KEY_PATTERN)
const PURPOSE_SET = new Set<string>(PLUGIN_WORKLOAD_SDK_PURPOSES)
const MAX_METADATA_BYTES = 16 * 1024

export interface PromptBridgeHandlerDeps {
  controlApiClient: PluginWorkloadSdkControlApiClient
  llmBridge: LlmBridge
  recipeNamespace: string
  recipeName: string
  promptTimeoutMs: number
  maxRequestContentBytes?: number
  /** Public provider/model identity from the live spec.agent binding. */
  getBootstrapTarget?: () => { provider: string; model: string } | null
  onUsage?: (usage: {
    provider: string
    model: string
    servedTarget: PromptBridgeTarget
    fallbackUsed: boolean
    attemptCount: number
    llmSecretName: string
    inputTokens: number
    outputTokens: number
    callerRef: string
    metadata?: Record<string, unknown>
  }) => void
}

export function validatePromptBridgeRequest(raw: unknown): PromptBridgeRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PluginWorkloadError('invalid_request', 'request body must be an object')
  }
  const body = raw as Record<string, unknown>

  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length === 0) {
    throw new PluginWorkloadError('invalid_request', 'idempotencyKey is required')
  }
  if (
    body.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey)
  ) {
    throw new PluginWorkloadError('invalid_request', 'idempotencyKey has an invalid format')
  }
  if (typeof body.purpose !== 'string' || !PURPOSE_SET.has(body.purpose)) {
    throw new PluginWorkloadError(
      'invalid_request',
      `purpose must be one of: ${PLUGIN_WORKLOAD_SDK_PURPOSES.join(', ')}`
    )
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new PluginWorkloadError('invalid_request', 'messages must be a non-empty array')
  }
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  for (const entry of body.messages) {
    const m = entry as Record<string, unknown>
    if (
      typeof m !== 'object' ||
      m === null ||
      typeof m.content !== 'string' ||
      !['system', 'user', 'assistant'].includes(m.role as string)
    ) {
      throw new PluginWorkloadError('invalid_request', 'messages entries must be { role, content }')
    }
    messages.push({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    })
  }

  // Validate optional fields: reject if provided with the wrong type.
  if (body.model !== undefined && typeof body.model !== 'string') {
    throw new PluginWorkloadError('invalid_request', 'model must be a string')
  }
  if (body.provider !== undefined && typeof body.provider !== 'string') {
    throw new PluginWorkloadError('invalid_request', 'provider must be a string')
  }
  if (body.targetRef !== undefined && typeof body.targetRef !== 'string') {
    throw new PluginWorkloadError('invalid_request', 'targetRef must be a string')
  }
  if (body.modelPolicyRef !== undefined && typeof body.modelPolicyRef !== 'string') {
    throw new PluginWorkloadError('invalid_request', 'modelPolicyRef must be a string')
  }
  if (body.maxTokens !== undefined && typeof body.maxTokens !== 'number') {
    throw new PluginWorkloadError('invalid_request', 'maxTokens must be a number')
  }
  if (body.temperature !== undefined && typeof body.temperature !== 'number') {
    throw new PluginWorkloadError('invalid_request', 'temperature must be a number')
  }
  if (
    body.metadata !== undefined &&
    (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
  ) {
    throw new PluginWorkloadError('invalid_request', 'metadata must be an object')
  }
  if (body.metadata !== undefined) {
    let metadataBytes: number
    try {
      metadataBytes = Buffer.byteLength(JSON.stringify(body.metadata), 'utf8')
    } catch {
      throw new PluginWorkloadError('invalid_request', 'metadata must be JSON-serializable')
    }
    if (metadataBytes > MAX_METADATA_BYTES) {
      throw new PluginWorkloadError('payload_too_large', 'metadata exceeds size limit')
    }
  }

  return {
    idempotencyKey: body.idempotencyKey as string,
    purpose: body.purpose as string,
    messages,
    model: typeof body.model === 'string' ? body.model : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
    targetRef: typeof body.targetRef === 'string' ? body.targetRef : undefined,
    modelPolicyRef: typeof body.modelPolicyRef === 'string' ? body.modelPolicyRef : undefined,
    maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    metadata:
      typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : undefined,
  }
}

export class PromptBridgeHandler {
  constructor(private readonly deps: PromptBridgeHandlerDeps) {}

  async handle(rawBody: unknown, callerRef: string): Promise<PromptBridgeResult> {
    const startedAt = process.hrtime.bigint()
    try {
      const result = await this.handleInner(rawBody, callerRef)
      pluginSdkPromptBridgeRequestsTotal.inc(
        { recipe: this.deps.recipeName, model: result.model, status: 'complete' },
        1
      )
      pluginSdkPromptBridgeTokensTotal.inc(
        { recipe: this.deps.recipeName, model: result.model, direction: 'input' },
        result.usage.inputTokens
      )
      pluginSdkPromptBridgeTokensTotal.inc(
        { recipe: this.deps.recipeName, model: result.model, direction: 'output' },
        result.usage.outputTokens
      )
      pluginSdkPromptBridgeDurationSeconds.observe(
        { recipe: this.deps.recipeName, model: result.model },
        Number(process.hrtime.bigint() - startedAt) / 1e9
      )
      return result
    } catch (err) {
      const status = err instanceof PluginWorkloadError ? err.code : 'internal_error'
      pluginSdkPromptBridgeRequestsTotal.inc(
        { recipe: this.deps.recipeName, model: 'unresolved', status },
        1
      )
      throw err
    }
  }

  private async handleInner(rawBody: unknown, callerRef: string): Promise<PromptBridgeResult> {
    const request = validatePromptBridgeRequest(rawBody)

    const totalBytes = request.messages.reduce(
      (sum, m) => sum + Buffer.byteLength(m.content, 'utf8'),
      0
    )
    const cap = this.deps.maxRequestContentBytes ?? DEFAULT_MAX_REQUEST_CONTENT_BYTES
    if (totalBytes > cap) {
      throw new PluginWorkloadError('payload_too_large', `messages content exceeds ${cap} bytes`)
    }

    const correlationId = randomUUID()
    const bootstrapTarget = this.deps.getBootstrapTarget?.()
    if (this.deps.getBootstrapTarget && !bootstrapTarget) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'mcp-host LLM bootstrap is not ready',
        true
      )
    }
    const authorized = await this.deps.controlApiClient.authorizePromptBridge({
      recipeNamespace: this.deps.recipeNamespace,
      recipeName: this.deps.recipeName,
      callerRef,
      ...(bootstrapTarget
        ? {
            bootstrapProvider: bootstrapTarget.provider,
            bootstrapModel: bootstrapTarget.model,
          }
        : {}),
      model: request.model,
      provider: request.provider,
      targetRef: request.targetRef,
      modelPolicyRef: request.modelPolicyRef,
      purpose: request.purpose,
      idempotencyKey: request.idempotencyKey,
      messages: request.messages,
      ...(request.metadata ? { metadata: request.metadata } : {}),
      correlationId,
    })

    // A successful replay is never sent to a provider again. The current
    // audit API does not persist completion content, so surface a stable
    // conflict instead of creating a duplicate billable call.
    if (authorized.replay && authorized.status !== 'failed') {
      throw new PluginWorkloadError(
        'idempotency_conflict',
        'idempotent invocation already exists; no provider call was repeated',
        false
      )
    }

    const selected = authorized.authorizedTargets[0]
    if (!selected || !sameTarget(selected, authorized.selectedTarget)) {
      throw unexpectedAuthorizationResponse()
    }
    try {
      const completion = await this.deps.llmBridge.complete({
        invocationId: authorized.invocationId,
        targets: authorized.authorizedTargets.map(target => ({ target })),
        messages: request.messages,
        policyRevision: authorized.policyRevision,
        policyHash: authorized.policyHash,
        credentialTicketIssuer: {
          issue: async input =>
            this.deps.controlApiClient.reissuePromptBridgeCredentialTicket({
              recipeNamespace: this.deps.recipeNamespace,
              recipeName: this.deps.recipeName,
              invocationId: input.invocationId,
              target: input.target,
              policyRevision: input.policyRevision,
              policyHash: input.policyHash,
            }),
        },
        maxTokens: clampMaxTokens(request.maxTokens, authorized.maxOutputTokens),
        temperature: request.temperature ?? authorized.modelPolicy?.temperature,
        timeoutMs: this.deps.promptTimeoutMs,
      })

      this.deps.onUsage?.({
        provider: completion.servedTarget.provider,
        model: completion.model,
        servedTarget: completion.servedTarget,
        fallbackUsed: completion.fallbackUsed,
        attemptCount: completion.attemptCount,
        llmSecretName: completion.llmSecretName,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        callerRef,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      })

      await this.deps.controlApiClient.reportInvocationStatus(
        authorized.invocationId,
        this.deps.recipeNamespace,
        this.deps.recipeName,
        'complete'
      )

      return {
        invocationId: authorized.invocationId,
        model: completion.model,
        servedTarget: completion.servedTarget,
        fallbackUsed: completion.fallbackUsed,
        policyRevision: authorized.policyRevision,
        usage: completion.usage,
        content: completion.content,
        finishReason: completion.finishReason,
        correlationId,
        createdAt: new Date().toISOString(),
      }
    } catch (err) {
      const status =
        err instanceof PluginWorkloadError && err.code === 'provider_unavailable'
          ? 'provider_unavailable'
          : 'failed'
      await this.deps.controlApiClient.reportInvocationStatus(
        authorized.invocationId,
        this.deps.recipeNamespace,
        this.deps.recipeName,
        status
      )
      throw err
    }
  }
}

function sameTarget(a: PromptBridgeTarget, b: PromptBridgeTarget): boolean {
  return (
    a.targetRef === b.targetRef &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.credentialSlot === b.credentialSlot
  )
}

function unexpectedAuthorizationResponse(): PluginWorkloadError {
  return new PluginWorkloadError(
    'provider_unavailable',
    'control-api returned an inconsistent authorized target set',
    false
  )
}

function clampMaxTokens(
  requested: number | undefined,
  grantCap: number | null
): number | undefined {
  if (grantCap === null) return requested
  if (requested === undefined) return grantCap
  return Math.min(requested, grantCap)
}
