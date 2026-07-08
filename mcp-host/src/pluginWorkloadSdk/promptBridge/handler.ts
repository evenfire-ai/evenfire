import { randomUUID } from 'crypto'
import { PluginWorkloadError } from '../domain/errors'
import {
  DEFAULT_IDEMPOTENCY_KEY_PATTERN,
  DEFAULT_MAX_REQUEST_CONTENT_BYTES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  PLUGIN_WORKLOAD_SDK_PURPOSES,
  type PromptBridgeRequest,
  type PromptBridgeResult,
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

export interface PromptBridgeHandlerDeps {
  controlApiClient: PluginWorkloadSdkControlApiClient
  llmBridge: LlmBridge
  recipeNamespace: string
  recipeName: string
  promptTimeoutMs: number
  maxRequestContentBytes?: number
  resolveDefaultModel?: () => string | null
  onUsage?: (usage: {
    model: string
    inputTokens: number
    outputTokens: number
    callerRef: string
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

  return {
    idempotencyKey: body.idempotencyKey as string,
    purpose: body.purpose as string,
    messages,
    model: typeof body.model === 'string' ? body.model : undefined,
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
    const fallbackModel =
      request.model === undefined && request.modelPolicyRef === undefined
        ? this.deps.resolveDefaultModel?.()?.trim() || undefined
        : undefined

    const authorized = await this.deps.controlApiClient.authorizePromptBridge({
      recipeNamespace: this.deps.recipeNamespace,
      recipeName: this.deps.recipeName,
      callerRef,
      model: request.model ?? fallbackModel,
      modelPolicyRef: request.modelPolicyRef,
      purpose: request.purpose,
      idempotencyKey: request.idempotencyKey,
      messages: request.messages,
      correlationId,
    })

    try {
      const completion = await this.deps.llmBridge.complete({
        model: authorized.model,
        messages: request.messages,
        maxTokens: clampMaxTokens(request.maxTokens, authorized.maxOutputTokens),
        temperature: request.temperature ?? authorized.modelPolicy?.temperature,
        timeoutMs: this.deps.promptTimeoutMs,
      })

      this.deps.onUsage?.({
        model: completion.model,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        callerRef,
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

function clampMaxTokens(
  requested: number | undefined,
  grantCap: number | null
): number | undefined {
  if (grantCap === null) return requested
  if (requested === undefined) return grantCap
  return Math.min(requested, grantCap)
}
