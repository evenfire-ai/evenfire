/**
 * Provider-fallback (R5 F6) — workflow-step glue.
 *
 * Wraps the workflow's `SingleTurnProvider` (built in `WorkflowService.configure`)
 * with the reusable {@link FailoverEngine} so an eligible classified failure of
 * the primary model switches to the next ordered fallback and retries the SAME
 * request. This is the workflow analogue of the agent's
 * `core/adapters/failoverLlmPort.ts` and the promptBridge `LlmBridge` failover —
 * the SAME engine, classifier and policy parser, no re-implementation.
 *
 * The decorator is a `SingleTurnProvider` itself, so `executeStep` uses it
 * unchanged at its two call sites. It exposes {@link servedBy} so per-call usage
 * is attributed to the pair REALLY served (spec §3-R5.9) — a cross-provider
 * fallback must NOT meter under the primary's `(provider, model)`.
 *
 * TRANSPORT NOTE (phase limitation): the fallback credential travels resolved on
 * the WRC `configure` leg (`ConfigureRequest.llmPolicy.fallbacks[].apiKey`) —
 * the WRC secret broker resolves each slot and forwards it, because
 * `ConfigureRequest.apiKey` is mono-value (spec §3-R4.4). Bedrock/Vertex as a
 * workflow fallback stays blocked by that mono-credential transport + the
 * workflowrecipe enum (which excludes bedrock) — consistent with the R4 scope.
 */
import type {
  ChatMessage,
  CompletionResponse,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import type { SingleTurnProvider } from '../llm'
import {
  type ClassifiedLike,
  type FailoverClass,
  FailoverEngine,
  type LlmPolicy,
  type ModelPair,
  parseCooldownAndTriggers,
} from '../llm/failover'
import type { LlmProvider } from '../llm/registryCore'

/**
 * One fallback entry with its RESOLVED credential (the WRC broker resolved the
 * slot). Distinct from the CRD-level `FallbackEntry` (which carries a
 * `credentialSlot`, not a key) — this is the mcp-host-internal, key-bearing form.
 */
export interface ResolvedFallbackEntry {
  provider: string
  model: string
  apiKey: string
  llmSecretName?: string
}

/** The normalized workflow failover policy: the engine policy + resolved keys. */
export interface WorkflowLlmPolicy {
  cooldownSeconds: number
  triggerOn: FailoverClass[]
  fallbacks: ResolvedFallbackEntry[]
}

function parseResolvedFallback(raw: unknown): ResolvedFallbackEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.provider !== 'string' || rec.provider.length === 0) return null
  if (typeof rec.model !== 'string' || rec.model.length === 0) return null
  if (typeof rec.apiKey !== 'string' || rec.apiKey.length === 0) return null
  const entry: ResolvedFallbackEntry = {
    provider: rec.provider,
    model: rec.model,
    apiKey: rec.apiKey,
  }
  if (typeof rec.llmSecretName === 'string' && rec.llmSecretName.length > 0) {
    entry.llmSecretName = rec.llmSecretName
  }
  return entry
}

/**
 * Parse the `llmPolicy` block off a workflow `configure` request into a
 * {@link WorkflowLlmPolicy}, or `null` when no usable failover is configured
 * (absent / malformed / zero valid fallbacks) — `null` = byte-identical to a
 * plain single-provider configure. Mirrors `llm/failover/policy.ts:parseLlmPolicy`
 * but keeps the resolved `apiKey` each entry needs to build its provider.
 */
export function parseWorkflowLlmPolicy(raw: unknown): WorkflowLlmPolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>

  if (!Array.isArray(rec.fallbacks)) return null
  const fallbacks: ResolvedFallbackEntry[] = []
  for (const item of rec.fallbacks) {
    const entry = parseResolvedFallback(item)
    if (entry) fallbacks.push(entry)
  }
  if (fallbacks.length === 0) return null

  const { cooldownSeconds, triggerOn } = parseCooldownAndTriggers(rec)
  return { cooldownSeconds, triggerOn, fallbacks }
}

/** Internal carrier: a failed attempt + its failover classification. */
class WorkflowAttemptError extends Error {
  constructor(
    readonly classified: ClassifiedLike,
    readonly original: unknown
  ) {
    super('[FailoverProvider] attempt error')
    this.name = 'WorkflowAttemptError'
  }
}

/** How the decorator builds a fallback provider on demand (or `null` = skip). */
export type FallbackProviderBuilder = (entry: ResolvedFallbackEntry) => SingleTurnProvider | null

export interface FailoverSingleTurnProviderOptions {
  primary: SingleTurnProvider
  primaryPair: ModelPair
  policy: WorkflowLlmPolicy
  buildFallback: FallbackProviderBuilder
  /** Structured-WARN sink for each switch (no secrets). */
  onSwitch?: (event: { from: ModelPair; to: ModelPair; reason: FailoverClass }) => void
}

/**
 * A `SingleTurnProvider` that transparently fails over across the primary +
 * ordered fallbacks. Optional cache methods are intentionally omitted — the
 * workflow step loop never calls them (it uses the plain
 * `completeSingleTurn` / `completeSingleTurnWithTools` surface).
 */
export class FailoverSingleTurnProvider implements SingleTurnProvider {
  private readonly engine: FailoverEngine
  private readonly fallbackCache = new Map<number, SingleTurnProvider | null>()

  constructor(private readonly o: FailoverSingleTurnProviderOptions) {
    this.engine = new FailoverEngine(
      {
        cooldownSeconds: o.policy.cooldownSeconds,
        triggerOn: o.policy.triggerOn,
        fallbacks: o.policy.fallbacks.map(f => ({ provider: f.provider, model: f.model })),
      } satisfies LlmPolicy,
      { onSwitch: o.onSwitch }
    )
    this.engine.noteServedPrimary(o.primaryPair)
  }

  getProviderType(): LlmProvider {
    return this.o.primary.getProviderType()
  }

  classifyError(err: unknown) {
    return this.o.primary.classifyError(err)
  }

  /** The pair currently serving (for per-call usage attribution). */
  servedBy(): ModelPair {
    const served = this.engine.servedBy()
    return served
      ? { provider: served.provider, model: served.model }
      : { provider: this.o.primaryPair.provider, model: this.o.primaryPair.model }
  }

  completeSingleTurn(
    messages: ChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    return this.run(options?.signal, provider => provider.completeSingleTurn(messages, options))
  }

  completeSingleTurnWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ): Promise<ToolCompletionResponse> {
    return this.run(options?.signal, provider =>
      provider.completeSingleTurnWithTools(messages, tools, options)
    )
  }

  private providerFor(index: number): SingleTurnProvider | null {
    if (this.fallbackCache.has(index)) return this.fallbackCache.get(index) ?? null
    const built = this.o.buildFallback(this.o.policy.fallbacks[index])
    this.fallbackCache.set(index, built)
    return built
  }

  private async run<T>(
    signal: AbortSignal | undefined,
    call: (provider: SingleTurnProvider) => Promise<T>
  ): Promise<T> {
    try {
      return await this.engine.run(
        this.o.primaryPair,
        target => {
          const provider =
            target.kind === 'primary' ? this.o.primary : this.providerFor(target.index)
          if (!provider) return null
          return async () => {
            try {
              return await call(provider)
            } catch (err) {
              // A cooperative abort (step deadline / caller cancel) is NOT a
              // provider fault: propagate the ORIGINAL error so the engine
              // neither switches nor cools the primary down (classifier → null).
              if (signal?.aborted) throw err
              const classified = provider.classifyError(err)
              throw new WorkflowAttemptError(
                { code: classified.code, retryable: classified.retryable },
                err
              )
            }
          }
        },
        err => (err instanceof WorkflowAttemptError ? err.classified : null)
      )
    } catch (err) {
      // Rethrow the ORIGINAL provider error so executeStep's existing error
      // handling (auth sanitization, length recovery) sees the real shape.
      throw err instanceof WorkflowAttemptError ? err.original : err
    }
  }
}

/** Type guard so the WorkflowService can read the served pair for metering. */
export function isFailoverProvider(
  provider: SingleTurnProvider
): provider is FailoverSingleTurnProvider {
  return provider instanceof FailoverSingleTurnProvider
}
