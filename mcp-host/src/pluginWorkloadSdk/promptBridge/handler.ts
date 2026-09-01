import { randomUUID } from 'crypto'
import { PluginWorkloadError, type PluginWorkloadProviderAttemptContext } from '../domain/errors'
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
import type {
  PluginWorkloadSdkBootstrapProof,
  PluginWorkloadSdkControlApiClient,
} from './controlApiClient'
import type { LlmBridge } from './llmBridge'

/**
 * promptBridge handler (plan §3.3): synchronous with bounded timeout.
 *
 *   1. Validate input (purpose enum, idempotency key pattern, content cap).
 *   2. Authorize through control-api via the anti-corruption layer.
 *   3. Call the co-located LLM bridge (provider bound to this mcp-host).
 *   4. Report physical and logical completion status back to the audit trail
 *      (idempotent and best-effort at the transport boundary).
 *   5. Return PromptBridgeResult — or a PluginWorkloadError (spec §15).
 *
 * v1 invariant: inference-only. No tools, no conversational session.
 */

const IDEMPOTENCY_KEY_RE = new RegExp(DEFAULT_IDEMPOTENCY_KEY_PATTERN)
const PURPOSE_SET = new Set<string>(PLUGIN_WORKLOAD_SDK_PURPOSES)
const MAX_METADATA_BYTES = 16 * 1024

/**
 * A provider response is already potentially billable when this acknowledgement
 * is sent. Preserve that response if the audit transport is unavailable; the
 * generation fence and maintenance sweep prevent the unfinished ledger row
 * from being retried as a fresh provider call. Usage is emitted once the
 * physical provider receipt is confirmed, even if the logical invocation ACK
 * must be retried, because usage binding is anchored to that immutable receipt.
 */
async function reportInvocationStatusBestEffort(
  client: PluginWorkloadSdkControlApiClient,
  invocationId: string,
  recipeNamespace: string,
  recipeName: string,
  status: 'complete' | 'failed' | 'provider_unavailable',
  attemptGeneration: number
): Promise<boolean> {
  try {
    await client.reportInvocationStatus(
      invocationId,
      recipeNamespace,
      recipeName,
      status,
      attemptGeneration
    )
    return true
  } catch {
    // Keep this log static. The request, provider response, and credentials
    // must not be copied into process logs while preserving the original error.
    console.warn('[PluginWorkloadSdk] invocation acknowledgement failed')
    return false
  }
}

export interface PromptBridgeHandlerDeps {
  controlApiClient: PluginWorkloadSdkControlApiClient
  llmBridge: LlmBridge
  recipeNamespace: string
  recipeName: string
  promptTimeoutMs: number
  maxRequestContentBytes?: number
  /** Public provider/model identity from the live spec.agent binding. */
  getBootstrapTarget?: () => { provider: string; model: string } | null
  /** SDK-only atomic accounting boundary; workflow mode keeps the legacy reporter. */
  finalizePromptBridge?: (input: {
    invocationId: string
    attemptGeneration: number
    providerAttemptId: string
    providerAttemptIndex: number
    status: 'complete' | 'failed' | 'provider_unavailable'
    reason: string
    target: PromptBridgeTarget
    usage?: {
      llmSecretName: string
      callerRef: string
      fallbackUsed: boolean
      attemptCount: number
      inputTokens: number
      outputTokens: number
    }
  }) => Promise<unknown>
  onUsage?: (usage: {
    invocationId: string
    attemptGeneration: number
    provider: string
    model: string
    servedTarget: PromptBridgeTarget
    fallbackUsed: boolean
    attemptCount: number
    providerAttemptId?: string
    providerAttemptIndex?: number
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

  /**
   * Verify the live Control API policy without issuing a provider request.
   * WRC uses this during eager bootstrap so Pod Ready cannot masquerade as a
   * validated SDK binding when the grant/default target is stale.
   */
  verifyBootstrapV2(
    expectedProvider: string,
    expectedModel: string
  ): Promise<PluginWorkloadSdkBootstrapProof> {
    return this.deps.controlApiClient.verifyPromptBridgeBootstrapV2(expectedProvider, expectedModel)
  }

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
    await this.deps.controlApiClient.ensurePromptBridgeCapabilities()
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
    if (!authorized.replay && !authorized.providerCallRequired) {
      throw unexpectedAuthorizationResponse()
    }
    if (authorized.replay && !authorized.providerCallRequired) {
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
    let unknownProviderAttempt: PluginWorkloadProviderAttemptContext | undefined
    try {
      const completion = await this.deps.llmBridge.complete({
        invocationId: authorized.invocationId,
        attemptGeneration: authorized.attemptGeneration,
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
              attemptGeneration: authorized.attemptGeneration,
              target: input.target,
              policyRevision: input.policyRevision,
              policyHash: input.policyHash,
            }),
        },
        providerAttemptReporter: {
          report: async input =>
            this.deps.controlApiClient.reportProviderAttemptStatus({
              invocationId: authorized.invocationId,
              recipeNamespace: this.deps.recipeNamespace,
              recipeName: this.deps.recipeName,
              attemptGeneration: authorized.attemptGeneration,
              providerAttemptId: input.providerAttemptId,
              providerAttemptIndex: input.providerAttemptIndex,
              status: input.status,
            }),
        },
        acknowledgementMode: this.deps.finalizePromptBridge
          ? 'atomic_terminal_finalization'
          : 'per_attempt',
        maxTokens: clampMaxTokens(request.maxTokens, authorized.maxOutputTokens),
        temperature: request.temperature ?? authorized.modelPolicy?.temperature,
        timeoutMs: this.deps.promptTimeoutMs,
        recipeNamespace: this.deps.recipeNamespace,
        recipeName: this.deps.recipeName,
        hostRef: `${this.deps.recipeNamespace}/${this.deps.recipeName}`,
      })

      const providerAttemptAcknowledgement =
        completion.providerAttemptAcknowledgement ?? 'confirmed'
      const providerAttemptAcknowledged = providerAttemptAcknowledgement === 'confirmed'
      const providerAttemptId = completion.providerAttemptId
      const providerAttemptIndex = completion.providerAttemptIndex
      if (
        this.deps.finalizePromptBridge &&
        (typeof providerAttemptId !== 'string' ||
          typeof providerAttemptIndex !== 'number' ||
          !Number.isInteger(providerAttemptIndex) ||
          providerAttemptIndex < 1)
      ) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'provider attempt receipt is missing from the SDK-only completion',
          false,
          'configuration'
        )
      }
      if (
        this.deps.finalizePromptBridge &&
        typeof providerAttemptId === 'string' &&
        typeof providerAttemptIndex === 'number' &&
        Number.isInteger(providerAttemptIndex) &&
        providerAttemptIndex >= 1
      ) {
        try {
          await this.deps.finalizePromptBridge({
            invocationId: authorized.invocationId,
            attemptGeneration: authorized.attemptGeneration,
            providerAttemptId,
            providerAttemptIndex,
            status: 'complete',
            reason:
              providerAttemptAcknowledgement === 'failed'
                ? 'provider_completion_acknowledgement_failed'
                : 'provider_completed',
            target: completion.servedTarget,
            usage: {
              llmSecretName: completion.llmSecretName,
              callerRef,
              fallbackUsed: completion.fallbackUsed,
              attemptCount: completion.attemptCount,
              inputTokens: completion.usage.inputTokens,
              outputTokens: completion.usage.outputTokens,
            },
          })
        } catch {
          // Returning provider content before durable finalization would hide
          // a possible spend. Surface an explicit unknown outcome instead.
          try {
            await this.deps.controlApiClient.reportProviderAttemptStatus({
              invocationId: authorized.invocationId,
              recipeNamespace: this.deps.recipeNamespace,
              recipeName: this.deps.recipeName,
              attemptGeneration: authorized.attemptGeneration,
              providerAttemptId,
              providerAttemptIndex,
              status: 'provider_unavailable',
            })
          } catch {
            // The finalizer remains the source of truth. This best-effort
            // physical close only prevents a failed finalizer from leaving a
            // receipt open until the lease sweeper.
            console.warn('[PluginWorkloadSdk] provider attempt recovery failed')
          }
          throw new PluginWorkloadError(
            'provider_unavailable',
            'provider result could not be durably finalized; retry with a new idempotency key after investigation',
            false,
            'outcome_unknown',
            true,
            {
              providerAttemptId,
              providerAttemptIndex,
              target: completion.servedTarget,
              attemptCount: completion.attemptCount,
              fallbackUsed: completion.fallbackUsed,
              llmSecretName: completion.llmSecretName,
            }
          )
        }
      } else {
        await reportInvocationStatusBestEffort(
          this.deps.controlApiClient,
          authorized.invocationId,
          this.deps.recipeNamespace,
          this.deps.recipeName,
          providerAttemptAcknowledged ? 'complete' : 'provider_unavailable',
          authorized.attemptGeneration
        )
      }

      if (!this.deps.finalizePromptBridge && providerAttemptAcknowledged) {
        // A confirmed physical completion is enough for receipt binding. If
        // the logical invocation ACK is lost, the usage reporter can still
        // retry against the durable provider-attempt receipt; suppressing the
        // event here would silently lose metering after a successful call.
        this.deps.onUsage?.({
          invocationId: authorized.invocationId,
          attemptGeneration: authorized.attemptGeneration,
          provider: completion.servedTarget.provider,
          model: completion.model,
          servedTarget: completion.servedTarget,
          fallbackUsed: completion.fallbackUsed,
          attemptCount: completion.attemptCount,
          ...(completion.providerAttemptId
            ? { providerAttemptId: completion.providerAttemptId }
            : {}),
          ...(completion.providerAttemptIndex !== undefined
            ? { providerAttemptIndex: completion.providerAttemptIndex }
            : {}),
          llmSecretName: completion.llmSecretName,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          callerRef,
          ...(request.metadata ? { metadata: request.metadata } : {}),
        })
      }

      // Preserve a real provider response even when its physical receipt was
      // not acknowledged. The invocation was closed as provider_unavailable
      // above, so the idempotency key cannot be revived into a second call.
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
      unknownProviderAttempt = err instanceof PluginWorkloadError ? err.providerAttempt : undefined
      let providerAttemptFinalized = false
      if (this.deps.finalizePromptBridge && unknownProviderAttempt) {
        try {
          const finalizationStatus =
            err instanceof PluginWorkloadError && err.providerMayHaveExecuted
              ? 'provider_unavailable'
              : 'failed'
          await this.deps.finalizePromptBridge({
            invocationId: authorized.invocationId,
            attemptGeneration: authorized.attemptGeneration,
            providerAttemptId: unknownProviderAttempt.providerAttemptId,
            providerAttemptIndex: unknownProviderAttempt.providerAttemptIndex,
            status: finalizationStatus,
            reason:
              err instanceof PluginWorkloadError && err.reason ? err.reason : 'outcome_unknown',
            target: unknownProviderAttempt.target,
          })
          providerAttemptFinalized = true
        } catch {
          console.warn('[PluginWorkloadSdk] provider spend finalization failed')
        }
      }
      // The public error code is deliberately not the idempotency decision.
      // A broker/configuration failure uses `provider_unavailable` as the
      // safe workload-facing code, but `providerMayHaveExecuted=false` proves
      // that this invocation did not reach a provider and can be revived with
      // the same key after the operator repairs the credential/policy. Only a
      // positive/ambiguous execution signal permanently fences the key.
      const status =
        err instanceof PluginWorkloadError && err.providerMayHaveExecuted
          ? 'provider_unavailable'
          : 'failed'
      if (!this.deps.finalizePromptBridge || !unknownProviderAttempt || !providerAttemptFinalized) {
        await reportInvocationStatusBestEffort(
          this.deps.controlApiClient,
          authorized.invocationId,
          this.deps.recipeNamespace,
          this.deps.recipeName,
          status,
          authorized.attemptGeneration
        )
      }
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
