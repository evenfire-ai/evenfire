import { LlmErrorCode } from '../../core/errors'
import { type ChatMessage, FinishReason } from '../../core/types'
import { type SingleTurnProvider, createLLMProvider } from '../../llm'
import type { CodexAttemptContext } from '../../llm/codexSubscription'
import { type ClassifiedLike, type FailoverClass, classifyFailoverClass } from '../../llm/failover'
import { descriptorFor, isLlmProvider } from '../../llm/registryCore'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { PluginWorkloadError, type PluginWorkloadProviderAttemptContext } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'
import { readSdkOnlyCodexBinding, verifySdkOnlyCodexBindingHash } from '../sdkOnlyCodexBinding'
import type { BrokeredCredential } from './credentialBrokerClient'

class ClassifiedProviderError extends Error {
  constructor(
    readonly classified: ClassifiedLike,
    private readonly publicError: PluginWorkloadError
  ) {
    super(publicError.message)
    this.name = 'ClassifiedProviderError'
  }

  toPluginWorkloadError(): PluginWorkloadError {
    return this.publicError
  }

  get providerMayHaveExecuted(): boolean {
    return this.publicError.providerMayHaveExecuted
  }
}

export interface PromptBridgeCredentialResolver {
  resolve(input: {
    invocationId: string
    attemptGeneration: number
    target: PromptBridgeTarget
    credentialTicket: string
    providerAttemptId?: string
    providerAttemptIndex?: number
    timeoutMs?: number
  }): Promise<BrokeredCredential>
}

export interface PromptBridgeCredentialTicketIssuer {
  issue(input: {
    invocationId: string
    attemptGeneration: number
    target: PromptBridgeTarget
    policyRevision: number
    policyHash: string
  }): Promise<{
    credentialTicket: string
    providerAttemptId?: string
    providerAttemptIndex?: number
  }>
}

export interface PromptBridgeProviderAttemptReporter {
  report(input: {
    providerAttemptId: string
    providerAttemptIndex: number
    status: 'complete' | 'failed' | 'provider_unavailable' | 'skipped'
  }): Promise<void>
}

export interface LlmBridgeRequest {
  invocationId: string
  attemptGeneration: number
  targets: Array<{ target: PromptBridgeTarget }>
  policyRevision: number
  policyHash: string
  credentialTicketIssuer: PromptBridgeCredentialTicketIssuer
  providerAttemptReporter?: PromptBridgeProviderAttemptReporter
  /** SDK-only lane finalizes a successful physical attempt atomically in the handler. */
  /**
   * Physical-attempt acknowledgement ownership. SDK-only finalization owns
   * the served terminal receipt; workflow mode reports each attempt here.
   */
  acknowledgementMode?: 'per_attempt' | 'atomic_terminal_finalization'
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
  timeoutMs: number
  triggerOn?: FailoverClass[]
  recipeNamespace?: string
  recipeName?: string
  hostRef?: string
}

export interface LlmBridgeResult {
  model: string
  servedTarget: PromptBridgeTarget
  fallbackUsed: boolean
  attemptCount: number
  llmSecretName: string
  providerAttemptId?: string
  providerAttemptIndex?: number
  /**
   * Explicit physical-receipt ownership. `owned_by_finalizer` is a successful
   * SDK-only path, not a missing acknowledgement; `failed` means the receipt
   * transport failed after provider execution and must be fenced unknown.
   */
  providerAttemptAcknowledgement?: 'confirmed' | 'owned_by_finalizer' | 'failed'
  content: string
  usage: { inputTokens: number; outputTokens: number }
  finishReason: 'complete' | 'length' | 'content_filter'
}

/**
 * Provider execution is the source of truth for the caller's result. A lost
 * terminal acknowledgement must not turn a potentially billable completion
 * into a revivable failure. The caller receives the result together with an
 * explicit receipt flag; the handler then closes the logical invocation as
 * provider_unavailable when the physical receipt is unknown.
 */
async function reportProviderAttemptBestEffort(
  reporter: PromptBridgeProviderAttemptReporter | undefined,
  input: Parameters<PromptBridgeProviderAttemptReporter['report']>[0]
): Promise<boolean> {
  if (!reporter) return true
  try {
    await reporter.report(input)
    return true
  } catch {
    // Keep this log static. Provider responses and credential material must
    // never be copied into process logs while preserving the provider outcome.
    console.warn('[PluginWorkloadSdk] provider attempt acknowledgement failed')
    return false
  }
}

const DEFAULT_MAX_LLM_RESPONSE_BYTES = 1024 * 1024
// Authentication and quota failures are operator/configuration signals, not
// safe automatic failover triggers. Provider-unavailable and rate-limited are
// the only conservative defaults until an explicit grant-level policy exists.
const DEFAULT_PROMPT_BRIDGE_FAILOVER_CLASSES: readonly FailoverClass[] = [
  'provider_unavailable',
  'rate_limited',
]

function remainingTimeoutMs(deadlineAt: number): number {
  return deadlineAt - Date.now()
}

function captureSdkOnlyCodexAttemptContext(
  request: LlmBridgeRequest,
  target: PromptBridgeTarget,
  ticket: { providerAttemptId?: string; providerAttemptIndex?: number }
): CodexAttemptContext | null {
  const binding = readSdkOnlyCodexBinding()
  if (
    !binding ||
    !verifySdkOnlyCodexBindingHash(binding) ||
    binding.model !== target.model ||
    !ticket.providerAttemptId ||
    ticket.providerAttemptIndex === undefined
  ) {
    return null
  }
  return {
    invocationId: request.invocationId,
    attemptGeneration: request.attemptGeneration,
    providerAttemptIndex: ticket.providerAttemptIndex,
    pluginWorkloadSdkProviderAttemptId: ticket.providerAttemptId,
    policyRevision: binding.catalogRevision,
    policyHash: binding.bindingHash,
    ...(request.hostRef ? { hostRef: request.hostRef } : {}),
    ...(request.recipeNamespace ? { recipeNamespace: request.recipeNamespace } : {}),
    ...(request.recipeName ? { recipeName: request.recipeName } : {}),
  }
}

function providerOutcomeUnknownError(
  providerAttempt?: PluginWorkloadProviderAttemptContext
): PluginWorkloadError {
  return new PluginWorkloadError(
    'provider_unavailable',
    'provider execution outcome is unknown; retry with a new idempotency key after investigation',
    false,
    'outcome_unknown',
    true,
    providerAttempt
  )
}

/**
 * A ticket reserves the physical attempt before the broker resolves a
 * credential. Preserve that receipt when surfacing a pre-provider failure so
 * the SDK-only handler can close all three lifecycle records atomically. The
 * secret name is intentionally absent here: the broker failed before it could
 * prove which Secret was used.
 */
function withProviderAttemptContext(
  error: unknown,
  providerAttempt: PluginWorkloadProviderAttemptContext
): PluginWorkloadError {
  const publicError =
    error instanceof ClassifiedProviderError
      ? error.toPluginWorkloadError()
      : error instanceof PluginWorkloadError
        ? error
        : new PluginWorkloadError(
            'provider_unavailable',
            'provider credentials could not be resolved',
            false,
            'credential_unavailable',
            false
          )
  return new PluginWorkloadError(
    publicError.code,
    publicError.message,
    publicError.retryable,
    publicError.reason,
    publicError.providerMayHaveExecuted,
    providerAttempt
  )
}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  reason: 'timeout' | 'provider_unavailable' = 'timeout'
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new PluginWorkloadError(
      'provider_unavailable',
      'promptBridge request deadline elapsed before provider attempt',
      true,
      reason
    )
  }
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new PluginWorkloadError(
                'provider_unavailable',
                'promptBridge request deadline elapsed before provider attempt',
                true,
                reason
              )
            ),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function mapFinishReason(reason: FinishReason): LlmBridgeResult['finishReason'] {
  if (reason === FinishReason.Length) return 'length'
  if (reason === FinishReason.ContentFilter) return 'content_filter'
  return 'complete'
}

/**
 * Executes only the ordered target suffix authorized by control-api. Each
 * attempt redeems its own signed ticket and credential; credential/config
 * failures are terminal, while eligible provider failures alone advance to
 * the next authorized target.
 */
export class LlmBridge {
  private readonly breakers = new Map<string, CircuitBreaker>()
  private static readonly MAX_TARGET_BREAKERS = 512

  constructor(
    private readonly credentials: PromptBridgeCredentialResolver,
    private readonly opts: {
      maxResponseBytes?: number
      /** Creates an isolated breaker for each effective provider target. */
      createBreaker?: (target: PromptBridgeTarget) => CircuitBreaker
      createProvider?: typeof createLLMProvider
    } = {}
  ) {
    // Breaker state is intentionally keyed by the complete target identity.
    // A provider/model/credential-slot policy can change while the mcp-host
    // remains alive, so targetRef alone is not sufficient isolation.
  }

  private breakerKey(target: PromptBridgeTarget): string {
    return [
      target.targetRef,
      target.provider,
      target.model,
      target.credentialSlot,
      target.connectionRef ?? '',
    ].join('\u0000')
  }

  private breakerFor(target: PromptBridgeTarget): CircuitBreaker {
    const key = this.breakerKey(target)
    const existing = this.breakers.get(key)
    if (existing) return existing

    const breaker = this.opts.createBreaker?.(target) ?? new CircuitBreaker()
    // A recipe policy is bounded, but the policy can be edited repeatedly over
    // the lifetime of a host. Keep this process-local cache bounded as well.
    if (this.breakers.size >= LlmBridge.MAX_TARGET_BREAKERS) {
      const oldest = this.breakers.keys().next().value
      if (typeof oldest === 'string') this.breakers.delete(oldest)
    }
    this.breakers.set(key, breaker)
    return breaker
  }

  async complete(request: LlmBridgeRequest): Promise<LlmBridgeResult> {
    if (request.targets.length === 0) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'no authorized provider target',
        false,
        'configuration'
      )
    }
    const triggerOn = new Set(request.triggerOn ?? DEFAULT_PROMPT_BRIDGE_FAILOVER_CLASSES)
    const deadlineAt = Date.now() + request.timeoutMs
    let lastProviderError: ClassifiedProviderError | null = null

    for (const [index, authorized] of request.targets.entries()) {
      if (!isLlmProvider(authorized.target.provider)) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'authorized provider configuration is unavailable',
          false,
          'configuration'
        )
      }

      const breaker = this.breakerFor(authorized.target)
      const oauthBroker =
        isLlmProvider(authorized.target.provider) &&
        descriptorFor(authorized.target.provider).authMode === 'oauth-broker'
      if (oauthBroker) {
        const skippedOrReserved = await this.completeOauthBrokerTarget({
          authorized,
          index,
          request,
          breaker,
          triggerOn,
          deadlineAt,
        })
        if (skippedOrReserved.kind === 'error') {
          lastProviderError = skippedOrReserved.error
          if (skippedOrReserved.terminal) {
            throw skippedOrReserved.error.toPluginWorkloadError()
          }
          continue
        }
        return skippedOrReserved.result
      }
      if (!breaker.allow()) {
        // A circuit-open target still consumes an ordered, auditable physical
        // attempt. Reserve and close it as `skipped` before advancing; without
        // this ledger row Control API would correctly reject the next target
        // as an out-of-order fallback.
        const skippedTicket = await withinDeadline(
          () =>
            request.credentialTicketIssuer.issue({
              invocationId: request.invocationId,
              attemptGeneration: request.attemptGeneration,
              target: authorized.target,
              policyRevision: request.policyRevision,
              policyHash: request.policyHash,
            }),
          remainingTimeoutMs(deadlineAt),
          'timeout'
        )
        if (skippedTicket.providerAttemptId && skippedTicket.providerAttemptIndex !== undefined) {
          await reportProviderAttemptBestEffort(request.providerAttemptReporter, {
            providerAttemptId: skippedTicket.providerAttemptId,
            providerAttemptIndex: skippedTicket.providerAttemptIndex,
            status: 'skipped',
          })
        }
        const error = new ClassifiedProviderError(
          { code: LlmErrorCode.ApiCallFailed, retryable: true },
          new PluginWorkloadError(
            'provider_unavailable',
            'LLM provider is temporarily unavailable',
            true,
            'provider_unavailable'
          )
        )
        lastProviderError = error
        const failureClass = classifyFailoverClass(
          error.classified.code,
          error.classified.retryable
        )
        const eligible = failureClass !== null && triggerOn.has(failureClass)
        if (!eligible || index === request.targets.length - 1) throw error.toPluginWorkloadError()
        continue
      }

      // Ticket redemption is deliberately inside the attempt loop. This value
      // is held only for the provider call and is never exposed in SDK output.
      const ticket = await withinDeadline(
        () =>
          request.credentialTicketIssuer.issue({
            invocationId: request.invocationId,
            attemptGeneration: request.attemptGeneration,
            target: authorized.target,
            policyRevision: request.policyRevision,
            policyHash: request.policyHash,
          }),
        remainingTimeoutMs(deadlineAt),
        'timeout'
      )
      let credential: BrokeredCredential
      try {
        credential = await withinDeadline(
          () =>
            this.credentials.resolve({
              invocationId: request.invocationId,
              attemptGeneration: request.attemptGeneration,
              target: authorized.target,
              credentialTicket: ticket.credentialTicket,
              ...(ticket.providerAttemptId ? { providerAttemptId: ticket.providerAttemptId } : {}),
              ...(ticket.providerAttemptIndex !== undefined
                ? { providerAttemptIndex: ticket.providerAttemptIndex }
                : {}),
              timeoutMs: remainingTimeoutMs(deadlineAt),
            }),
          remainingTimeoutMs(deadlineAt),
          'timeout'
        )
      } catch (error) {
        // A ticket has already reserved a physical attempt by this point. Do
        // not leave that row in_progress until the lease sweep when the broker
        // rejects the Secret read; close it before surfacing the terminal
        // credential/configuration failure to the caller.
        if (ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined) {
          // A ticket has already reserved a physical attempt, so every
          // pre-provider credential/configuration failure must close that
          // attempt as `failed`, regardless of the logical finalizer mode.
          // Otherwise the logical invocation closes while the physical ledger
          // remains reserved/in_progress forever.
          await reportProviderAttemptBestEffort(request.providerAttemptReporter, {
            providerAttemptId: ticket.providerAttemptId,
            providerAttemptIndex: ticket.providerAttemptIndex,
            status: 'failed',
          })
        }
        // Preserve the reserved receipt in every mode. Atomic SDK-only
        // finalization owns the logical/spend outcome, so dropping this
        // context would close only the physical row and lose `not_executed`.
        if (ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined) {
          throw withProviderAttemptContext(error, {
            providerAttemptId: ticket.providerAttemptId,
            providerAttemptIndex: ticket.providerAttemptIndex,
            target: authorized.target,
            attemptCount: index + 1,
            fallbackUsed: index > 0,
          })
        }
        throw error
      }

      try {
        const completion = await this.attempt(
          credential,
          { ...request, timeoutMs: remainingTimeoutMs(deadlineAt) },
          breaker
        )
        let providerAttemptAcknowledgement: 'confirmed' | 'owned_by_finalizer' | 'failed' =
          'confirmed'
        if (
          request.acknowledgementMode !== 'atomic_terminal_finalization' &&
          ticket.providerAttemptId &&
          ticket.providerAttemptIndex !== undefined
        ) {
          const acknowledged = await reportProviderAttemptBestEffort(
            request.providerAttemptReporter,
            {
              providerAttemptId: ticket.providerAttemptId,
              providerAttemptIndex: ticket.providerAttemptIndex,
              status: 'complete',
            }
          )
          providerAttemptAcknowledgement = acknowledged ? 'confirmed' : 'failed'
        } else if (request.acknowledgementMode === 'atomic_terminal_finalization') {
          // The handler's atomic finalizer is the sole owner of the served
          // terminal receipt. Reporting `complete` here would double-close
          // the same physical attempt and can double-apply usage.
          providerAttemptAcknowledgement = 'owned_by_finalizer'
        }
        return {
          ...completion,
          servedTarget: authorized.target,
          fallbackUsed: index > 0,
          attemptCount: index + 1,
          llmSecretName: credential.llmSecretName,
          ...(ticket.providerAttemptId ? { providerAttemptId: ticket.providerAttemptId } : {}),
          ...(ticket.providerAttemptIndex !== undefined
            ? { providerAttemptIndex: ticket.providerAttemptIndex }
            : {}),
          providerAttemptAcknowledgement,
        }
      } catch (error) {
        const providerMayHaveExecuted =
          (error instanceof PluginWorkloadError && error.providerMayHaveExecuted) ||
          (error instanceof ClassifiedProviderError && error.providerMayHaveExecuted)
        let providerAttemptAcknowledgement: 'confirmed' | 'owned_by_finalizer' | 'failed' =
          'confirmed'
        if (ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined) {
          const acknowledged = await reportProviderAttemptBestEffort(
            request.providerAttemptReporter,
            {
              providerAttemptId: ticket.providerAttemptId,
              providerAttemptIndex: ticket.providerAttemptIndex,
              status:
                error instanceof ClassifiedProviderError || providerMayHaveExecuted
                  ? 'provider_unavailable'
                  : 'failed',
            }
          )
          providerAttemptAcknowledgement = acknowledged ? 'confirmed' : 'failed'
        }
        const providerAttemptContext =
          ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined
            ? {
                providerAttemptId: ticket.providerAttemptId,
                providerAttemptIndex: ticket.providerAttemptIndex,
                target: authorized.target,
                attemptCount: index + 1,
                fallbackUsed: index > 0,
                llmSecretName: credential.llmSecretName,
              }
            : undefined
        if (providerAttemptAcknowledgement === 'failed') {
          // Once execution may have started, a failed receipt is not a safe
          // failover signal. Closing the logical invocation as terminal
          // provider_unavailable prevents the same idempotency key from
          // reviving into a second billable provider call.
          throw providerOutcomeUnknownError(providerAttemptContext)
        }
        if (!(error instanceof ClassifiedProviderError)) {
          if (providerMayHaveExecuted) {
            throw providerOutcomeUnknownError(providerAttemptContext)
          }
          // Provider construction/configuration failed before execution. Carry
          // the receipt so SDK-only finalization can atomically mark it
          // not_executed and leave the idempotency key revivable.
          throw providerAttemptContext
            ? withProviderAttemptContext(error, providerAttemptContext)
            : error
        }
        lastProviderError = error
        const failureClass = classifyFailoverClass(
          error.classified.code,
          error.classified.retryable
        )
        const eligible = failureClass !== null && triggerOn.has(failureClass)
        if (!eligible || index === request.targets.length - 1) {
          throw providerAttemptContext
            ? withProviderAttemptContext(error.toPluginWorkloadError(), providerAttemptContext)
            : error.toPluginWorkloadError()
        }
      }
    }

    throw (
      lastProviderError?.toPluginWorkloadError() ??
      new PluginWorkloadError(
        'provider_unavailable',
        'authorized providers are unavailable',
        true,
        'provider_unavailable'
      )
    )
  }

  private async completeOauthBrokerTarget(input: {
    authorized: { target: PromptBridgeTarget }
    index: number
    request: LlmBridgeRequest
    breaker: CircuitBreaker
    triggerOn: Set<FailoverClass>
    deadlineAt: number
  }): Promise<
    | { kind: 'result'; result: LlmBridgeResult }
    | { kind: 'error'; error: ClassifiedProviderError; terminal: boolean }
  > {
    const { authorized, index, request, breaker, triggerOn, deadlineAt } = input
    const ticket = await withinDeadline(
      () =>
        request.credentialTicketIssuer.issue({
          invocationId: request.invocationId,
          attemptGeneration: request.attemptGeneration,
          target: authorized.target,
          policyRevision: request.policyRevision,
          policyHash: request.policyHash,
        }),
      remainingTimeoutMs(deadlineAt),
      'timeout'
    )
    const providerAttemptContext =
      ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined
        ? {
            providerAttemptId: ticket.providerAttemptId,
            providerAttemptIndex: ticket.providerAttemptIndex,
            target: authorized.target,
            attemptCount: index + 1,
            fallbackUsed: index > 0,
          }
        : undefined

    if (!breaker.allow()) {
      if (ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined) {
        await reportProviderAttemptBestEffort(request.providerAttemptReporter, {
          providerAttemptId: ticket.providerAttemptId,
          providerAttemptIndex: ticket.providerAttemptIndex,
          status: 'skipped',
        })
      }
      const error = new ClassifiedProviderError(
        { code: LlmErrorCode.ApiCallFailed, retryable: true },
        new PluginWorkloadError(
          'provider_unavailable',
          'LLM provider is temporarily unavailable',
          true,
          'provider_unavailable',
          false,
          providerAttemptContext
        )
      )
      const failureClass = classifyFailoverClass(error.classified.code, error.classified.retryable)
      const eligible = failureClass !== null && triggerOn.has(failureClass)
      return { kind: 'error', error, terminal: !eligible || index === request.targets.length - 1 }
    }

    const captured = captureSdkOnlyCodexAttemptContext(request, authorized.target, ticket)
    if (!captured) {
      if (ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined) {
        await reportProviderAttemptBestEffort(request.providerAttemptReporter, {
          providerAttemptId: ticket.providerAttemptId,
          providerAttemptIndex: ticket.providerAttemptIndex,
          status: 'failed',
        })
      }
      const error = new ClassifiedProviderError(
        { code: LlmErrorCode.ApiCallFailed, retryable: true },
        new PluginWorkloadError(
          'provider_unavailable',
          'Codex execution binding is missing after reserving the SDK attempt',
          true,
          'provider_unavailable',
          false,
          providerAttemptContext
        )
      )
      const failureClass = classifyFailoverClass(error.classified.code, error.classified.retryable)
      const eligible = failureClass !== null && triggerOn.has(failureClass)
      return { kind: 'error', error, terminal: !eligible || index === request.targets.length - 1 }
    }

    try {
      const completion = await this.attempt(
        { target: authorized.target, keys: {}, llmSecretName: '' },
        { ...request, timeoutMs: remainingTimeoutMs(deadlineAt) },
        breaker,
        captured
      )
      return {
        kind: 'result',
        result: {
          ...completion,
          servedTarget: authorized.target,
          fallbackUsed: index > 0,
          attemptCount: index + 1,
          llmSecretName: '',
          providerAttemptId: ticket.providerAttemptId,
          providerAttemptIndex: ticket.providerAttemptIndex,
          providerAttemptAcknowledgement: 'owned_by_finalizer',
        },
      }
    } catch (error) {
      if (
        error instanceof ClassifiedProviderError &&
        (error.classified.providerCode === 'budget_denied' ||
          error.classified.providerCode === 'no_grant' ||
          error.classified.providerCode === 'host_binding_mismatch' ||
          error.classified.providerCode === 'insufficient_scope' ||
          error.classified.code === LlmErrorCode.AuthenticationFailed)
      ) {
        if (ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined) {
          await reportProviderAttemptBestEffort(request.providerAttemptReporter, {
            providerAttemptId: ticket.providerAttemptId,
            providerAttemptIndex: ticket.providerAttemptIndex,
            status: 'failed',
          })
        }
        return {
          kind: 'error',
          error,
          terminal: true,
        }
      }
      if (ticket.providerAttemptId && ticket.providerAttemptIndex !== undefined) {
        const providerMayHaveExecuted =
          (error instanceof PluginWorkloadError && error.providerMayHaveExecuted) ||
          (error instanceof ClassifiedProviderError && error.providerMayHaveExecuted)
        await reportProviderAttemptBestEffort(request.providerAttemptReporter, {
          providerAttemptId: ticket.providerAttemptId,
          providerAttemptIndex: ticket.providerAttemptIndex,
          status: providerMayHaveExecuted ? 'provider_unavailable' : 'failed',
        })
      }
      if (!(error instanceof ClassifiedProviderError)) {
        throw providerAttemptContext
          ? withProviderAttemptContext(error, providerAttemptContext)
          : error
      }
      const failureClass = classifyFailoverClass(error.classified.code, error.classified.retryable)
      const eligible = failureClass !== null && triggerOn.has(failureClass)
      return {
        kind: 'error',
        error,
        terminal: !eligible || index === request.targets.length - 1,
      }
    }
  }

  private async attempt(
    credential: BrokeredCredential,
    request: LlmBridgeRequest,
    breaker: CircuitBreaker,
    capturedCodexAttemptContext?: CodexAttemptContext
  ): Promise<
    Pick<
      LlmBridgeResult,
      'model' | 'content' | 'usage' | 'finishReason' | 'providerAttemptId' | 'providerAttemptIndex'
    >
  > {
    if (request.timeoutMs <= 0) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'promptBridge request deadline elapsed before provider attempt',
        true,
        'timeout'
      )
    }
    const factory = this.opts.createProvider ?? createLLMProvider
    const providerId = credential.target.provider
    if (!isLlmProvider(providerId)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'authorized provider configuration is unavailable',
        false,
        'configuration'
      )
    }
    const provider: SingleTurnProvider | null = factory(
      credential.keys,
      {
        provider: providerId,
        name: credential.target.model,
      },
      capturedCodexAttemptContext ? { capturedCodexAttemptContext } : undefined
    )
    if (!provider) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'authorized provider credentials are unavailable',
        false,
        'credential_unavailable'
      )
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    try {
      const response = await provider.completeSingleTurn(request.messages as ChatMessage[], {
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        signal: controller.signal,
      })
      breaker.record(true)
      const maxBytes = this.opts.maxResponseBytes ?? DEFAULT_MAX_LLM_RESPONSE_BYTES
      if (Buffer.byteLength(response.content, 'utf8') > maxBytes) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'provider returned a response that cannot be safely recorded',
          false,
          'outcome_unknown',
          true
        )
      }
      const inputTokens = response.usage?.input_tokens ?? 0
      const outputTokens = response.usage?.output_tokens ?? 0
      const brokerBacked = descriptorFor(providerId).authMode === 'oauth-broker'
      if (
        (!brokerBacked && response.usage_reported === false) ||
        inputTokens < 0 ||
        outputTokens < 0 ||
        !Number.isInteger(inputTokens) ||
        !Number.isInteger(outputTokens)
      ) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'provider returned invalid usage',
          false,
          'outcome_unknown',
          true
        )
      }
      return {
        model: credential.target.model,
        content: response.content,
        usage: { inputTokens, outputTokens },
        finishReason: mapFinishReason(response.finish_reason),
        ...(typeof response.providerAttemptId === 'string' && response.providerAttemptId
          ? { providerAttemptId: response.providerAttemptId }
          : {}),
        ...(typeof response.providerAttemptIndex === 'number' &&
        Number.isInteger(response.providerAttemptIndex) &&
        response.providerAttemptIndex >= 1
          ? { providerAttemptIndex: response.providerAttemptIndex }
          : {}),
      }
    } catch (error) {
      if (error instanceof PluginWorkloadError) throw error
      breaker.record(false)
      if (controller.signal.aborted) {
        throw new ClassifiedProviderError(
          { code: LlmErrorCode.ApiCallFailed, retryable: true },
          new PluginWorkloadError(
            'provider_unavailable',
            'LLM provider did not respond within the request timeout',
            true,
            'timeout',
            true
          )
        )
      }
      const classified = provider.classifyError(error)
      const reason =
        classifyFailoverClass(classified.code, classified.retryable) ?? 'provider_unavailable'
      throw new ClassifiedProviderError(
        {
          code: classified.code,
          retryable: classified.retryable,
          ...(classified.providerCode ? { providerCode: classified.providerCode } : {}),
        },
        new PluginWorkloadError(
          'provider_unavailable',
          `LLM provider error: ${classified.code}`,
          classified.retryable,
          reason,
          // This branch runs only after the provider call was entered. Even a
          // provider-declared auth/rate-limit response is not proof that no
          // billable work occurred, so it must remain fenced as an ambiguous
          // physical outcome rather than reviving the idempotency key.
          true
        )
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
