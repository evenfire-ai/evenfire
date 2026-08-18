/**
 * HookedLlmPort — the LLM-lane guardrail boundary (spec §7), an `LlmPort`
 * decorator wrapping the effective port **above failover** so contributors fire
 * once per logical request, not per fallback attempt.
 *
 * On the MAIN lane (`completeWithTools`):
 *   1. apply the first-party built-in request-shaping chain (`prompt-shaping`,
 *      `token-trim`);
 *   2. run installed `pre_call` hooks (each may rewrite the request or reject) —
 *      a `deny` returns a graceful refusal (finish_reason Stop) WITHOUT calling
 *      the model, so the turn completes with a message instead of erroring;
 *   3. dispatch the (possibly rewritten) request. When `moderate` hooks exist they
 *      run CONCURRENTLY with the model call (spec §7.1) — a moderation `deny`
 *      aborts the in-flight call via a linked `AbortSignal` (no tokens wasted) and
 *      returns a graceful refusal; the happy path proceeds to `post_call`;
 *   4. if the model call throws, run installed `on_error` hooks — a gated hook may
 *      `substitute` a safe text-only result (else the error surfaces);
 *   5. run installed `post_call` hooks over the result — each may redact content or
 *      drop tool_calls (never add them, N5), chained in `order`.
 * The aux/compaction lane (`complete`) runs the REDUCED set — no guardrail/PII
 * (spec §7.4) — a passthrough here.
 *
 * Response-capability enforcement (F4), system-prompt immutability (N4), and
 * subtractive actions (N5) are enforced inside `RemoteLlmHook`.
 */
import { aggregateDecision, guardrailDecisionsTotal, pickPresentationReason } from '../guardrails'
import type { Contributor, GuardrailsConfig } from '../guardrails'
import {
  type BuiltinStep,
  type RequestShaper,
  buildLlmBuiltinChain,
  buildLlmBuiltinSteps,
} from '../guardrails/llm/builtinChain'
import {
  type LlmLaneHookDeps,
  type LlmLaneHooks,
  buildLlmLaneHooks,
} from '../guardrails/llm/llmLaneHooks'
import type { LlmPort } from '../interfaces'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import {
  type CompletionRequest,
  type CompletionResponse,
  FinishReason,
  type GuardrailInputChange,
  type ToolCompletionRequest,
  type ToolCompletionResponse,
  type TurnGuardrailActivity,
} from '../types'

const EMPTY_HOOKS: LlmLaneHooks = { preCall: [], moderate: [], postCall: [], onError: [] }

/**
 * First-party refusal text keyed by the winning deny `reasonCode`. The hook's
 * own message (`audit.modelReason`) is UNTRUSTED — it comes from an out-of-process
 * container — so it is never surfaced to the user verbatim (§8.4); we map the
 * controlled reason code to a canned message instead.
 */
const REFUSAL_BY_REASON: Record<string, string> = {
  moderation_blocked: "I can't help with that — the request was flagged by a content policy.",
  jailbreak_blocked: "I can't comply with that request.",
  content_filtered: "I can't help with that request.",
  hook_unavailable:
    "I can't complete that request right now — a required safety check is unavailable. Please try again shortly.",
}
const DEFAULT_REFUSAL = "I can't help with that request."

/** Bounded set for the metric `reason_code` label — the hook's `body.code` is
 * attacker-influenced, so unknown codes collapse to `hook_deny` to keep the
 * label a fixed enum (no cardinality blow-up / label injection, spec §9). */
const KNOWN_REASON_CODES = new Set([
  'moderation_blocked',
  'jailbreak_blocked',
  'content_filtered',
  'hook_unavailable',
])
function boundedReason(reason?: string): string {
  return reason && KNOWN_REASON_CODES.has(reason) ? reason : 'hook_deny'
}
/** Sanitize an untrusted reason for a single-line log (strip CR/LF/TAB, cap length). */
function logSafeReason(reason?: string): string {
  return String(reason ?? 'unknown')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 80)
}

/**
 * A denied model call renders as a GRACEFUL assistant refusal — `finish_reason:
 * Stop` + refusal text — not a content-filter error. The turn then flows through
 * the normal text→response delivery path (the user gets a message, the task
 * completes) instead of failing as `LLM_CONTENT_FILTERED`. The refusal text is
 * first-party, selected by the winning deny `reasonCode` (spec §7.1/§8.4).
 */
function refusalResponse(reason?: string): ToolCompletionResponse {
  return {
    content: (reason && REFUSAL_BY_REASON[reason]) || DEFAULT_REFUSAL,
    tool_calls: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    finish_reason: FinishReason.Stop,
  }
}

/**
 * Approximate request size for the pre_call diagnostic log: total chars across
 * message string content only. Sizes, never content (§8.4). Mirrors the hook's
 * own `messagesChars`, so mcp-host's `before→after` lines up with the hook's
 * reported `beforeChars/afterChars` when a rewrite lands.
 */
function approxRequestChars(req: ToolCompletionRequest): number {
  let n = 0
  for (const m of req.messages ?? []) {
    if (typeof m.content === 'string') n += m.content.length
  }
  return n
}

/**
 * Token estimate for the guardrail-input-transparency delta: `chars/4` over
 * NON-system message string content. Deliberately NOT the LLM-lane `countSync`:
 * for an Anthropic session that counter is a PROSE word-count heuristic, and
 * guardrails act on dense, whitespace-poor data (pasted JSON/CSV) where it badly
 * under-counts the original — enough to INVERT the delta's sign after a
 * compaction (a 53%-smaller CSV reads as +tokens). `chars/4` is the standard BPE
 * approximation — the same estimate mcp-host already uses for dense tool schemas
 * (`heuristicCountTools`) — and stays monotonic with what a compactor does, so
 * "reduced my input" never shows as an increase. Sync + no network.
 */
function estimateInputTokens(req: ToolCompletionRequest): number {
  let chars = 0
  for (const m of req.messages ?? []) {
    if (m.role === 'system') continue
    if (typeof m.content === 'string') chars += m.content.length
  }
  return Math.ceil(chars / 4)
}

/**
 * Best-effort per-LLM-call measurement of how much each guardrail source changed
 * the input, for the guardrail-input-transparency surface (spec §3). Uses the
 * injected token estimator over NON-system messages — the exact surface hooks may
 * touch (§3.3). Every count is guarded: an estimator fault sets `failed` and the
 * call is dropped with no emit. Measurement must NEVER affect a turn (§3.4).
 */
class GuardrailActivityMeter {
  private failed = false
  private tokensBefore = 0
  private running = 0
  private readonly changes = new Map<string, GuardrailInputChange>()

  constructor(
    private readonly count: (req: ToolCompletionRequest) => number,
    private readonly sink: (activity: TurnGuardrailActivity) => void
  ) {}

  /** Seed the before/running count from the request as it enters the chain. */
  begin(req: ToolCompletionRequest): void {
    try {
      this.tokensBefore = this.running = this.count(req)
    } catch {
      this.failed = true
    }
  }

  /**
   * Record that `sourceId` transformed the request. A no-op step (same object)
   * costs nothing and is skipped (§3.2). A step that changed the request but
   * produced a zero delta is still recorded as `changed` (D4 — e.g. a redactor).
   */
  record(
    before: ToolCompletionRequest,
    after: ToolCompletionRequest,
    sourceId: string,
    kind: 'builtin' | 'hook'
  ): void {
    if (this.failed || after === before) return
    let delta = 0
    try {
      const c = this.count(after)
      delta = c - this.running
      this.running = c
    } catch {
      this.failed = true
      return
    }
    // A source acts at most once per LLM call, so `calls` is 1 here; the
    // ConversationManager sums it across the turn's calls (§2.3).
    this.changes.set(sourceId, { sourceId, kind, deltaTokens: delta, changed: true, calls: 1 })
  }

  /** Emit this call's record to the sink. No-op on failure or when nothing acted. */
  emit(): void {
    if (this.failed || this.changes.size === 0) return
    try {
      this.sink({
        tokensBefore: this.tokensBefore,
        tokensAfter: this.running,
        changes: [...this.changes.values()],
        llmCalls: 1,
      })
    } catch {
      /* best-effort telemetry — a sink fault must never affect the turn */
    }
  }
}

export class HookedLlmPort implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly shapeMainLane: RequestShaper,
    private readonly hooks: LlmLaneHooks = EMPTY_HOOKS,
    /**
     * Guardrail-input-transparency (spec §5.1): the built-ins as individually
     * addressable steps (so each is measured), plus a per-LLM-call activity sink.
     * Both undefined in tests / no-config → measurement is off and the request is
     * shaped via `shapeMainLane` exactly as before.
     */
    private readonly builtinSteps?: BuiltinStep[],
    private readonly onGuardrailActivity?: (activity: TurnGuardrailActivity) => void,
    /**
     * Token estimator for the transparency delta. Defaults to the `chars/4`
     * dense-content estimate; injectable so tests can supply a deterministic (or
     * throwing) counter.
     */
    private readonly countInputTokens: (req: ToolCompletionRequest) => number = estimateInputTokens
  ) {}

  modelName(): string {
    return this.inner.modelName()
  }

  getTokenCounter(): TokenCounter {
    const counter = this.inner.getTokenCounter?.()
    if (!counter) {
      throw new Error('[HookedLlmPort] inner port has no token counter — wiring bug')
    }
    return counter
  }

  /** Aux/compaction lane (spec §7.4): reduced set — passthrough. */
  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.inner.complete(request)
  }

  /**
   * A guardrail deny → graceful refusal. Records the block on
   * `guardrailDecisionsTotal` (the LLM lane bypasses the boundary's own
   * recordDecision, so without this a deny would be invisible to telemetry) and
   * logs it, then returns the first-party refusal completion.
   */
  private denyRefusal(
    contribs: ReadonlyArray<Contributor<ToolCompletionRequest, ToolCompletionResponse>>,
    point: 'pre_call' | 'moderate'
  ): ToolCompletionResponse {
    const reason = pickPresentationReason(contribs, 'deny')
    guardrailDecisionsTotal.inc({
      lane: 'llm',
      decision: 'deny',
      source: 'hook',
      execution_mode: point === 'moderate' ? 'concurrent' : 'blocking',
      phase: 'pre',
      outcome: 'denied',
      reason_code: boundedReason(reason),
    })
    console.warn(`[HookedLlmPort] ${point} deny — refusing turn (reason=${logSafeReason(reason)})`)
    return refusalResponse(reason)
  }

  /** Main lane (spec §7): built-ins → pre_call → dispatch (moderation concurrent with the call). */
  async completeWithTools(request: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    // Guardrail-input-transparency (spec §3): measure per source only when a sink
    // is wired. `meter` is null in tests / no-config, so the fast path is untouched.
    const meter = this.onGuardrailActivity
      ? new GuardrailActivityMeter(this.countInputTokens, this.onGuardrailActivity)
      : null

    // Built-ins: when measuring, apply each step individually so its delta is
    // attributed (equivalent to `shapeMainLane`). Otherwise take the composed
    // fast path unchanged.
    let req: ToolCompletionRequest
    if (meter && this.builtinSteps) {
      meter.begin(request)
      req = request
      for (const step of this.builtinSteps) {
        const before = req
        req = step.shape(req)
        meter.record(before, req, step.sourceId, 'builtin')
      }
    } else {
      req = this.shapeMainLane(request)
      meter?.begin(req)
    }

    // pre_call runs first — it shapes the request the model + moderation both see,
    // and a reject blocks the call outright (no tokens spent).
    const preContribs: Array<Contributor<ToolCompletionRequest, ToolCompletionResponse>> = []
    for (const hook of this.hooks.preCall) {
      const preReq = req
      const c = await hook.preCall(req)
      if (c) {
        preContribs.push(c)
        if (c.rewrite) req = c.rewrite // already system-role-stripped + capability-gated (N4/F4)
      }
      // Transparency: a may_rewrite hook that replaced the request is a source.
      if (meter && c?.rewrite) meter.record(preReq, req, hook.id, 'hook')
      // Diagnostic (content-free, sizes only per §8.4): log only the meaningful,
      // low-frequency outcomes — a rewrite that was APPLIED (with before→after
      // chars, which should match the hook's own reported before/after), a deny,
      // or a non-standard contribution (e.g. a reject downgraded to no_decision
      // when the hook lacks may_deny). The common no-op — a hook that returned
      // `continue` with nothing to do — is deliberately NOT logged: it fires on
      // every tool-loop iteration, and the hook's own logs already record the
      // dial. Sizes are measured only when a rewrite lands, so the no-op path
      // stays free.
      if (c?.rewrite) {
        const before = approxRequestChars(preReq)
        const after = approxRequestChars(req)
        console.log(
          `[HookedLlmPort] pre_call ${hook.id}: applied rewrite ${before}→${after} chars (Δ${before - after})`
        )
      } else if (c?.decision === 'deny') {
        console.log(
          `[HookedLlmPort] pre_call ${hook.id}: deny (reason=${logSafeReason(c.reasonCode)})`
        )
      } else if (c) {
        console.log(`[HookedLlmPort] pre_call ${hook.id}: ${c.decision} (no rewrite)`)
      }
    }
    if (aggregateDecision(preContribs) === 'deny') return this.denyRefusal(preContribs, 'pre_call')

    // Emit the per-call transparency record only for a dispatched (non-denied)
    // turn — a deny changes nothing about the input the model sees (§2.2).
    meter?.emit()

    return this.hooks.moderate.length === 0
      ? this.dispatch(req)
      : this.dispatchWithConcurrentModeration(req)
  }

  /** No moderation hooks: call → on_error → post_call. */
  private async dispatch(req: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    let response: ToolCompletionResponse
    try {
      response = await this.inner.completeWithTools(req)
    } catch (err) {
      return this.recoverOrThrow(req, err)
    }
    return this.applyPostCall(req, response)
  }

  /**
   * §7.1 latency optimization: run the model call and all `moderate` hooks
   * concurrently over the same request. A moderation `deny` aborts the in-flight
   * call via a linked `AbortSignal` (no tokens wasted) and returns a filtered
   * response; otherwise the happy path (`call ok` AND all moderation pass)
   * proceeds to `post_call`. Wall-clock is `max(call, moderation)`, not their sum.
   */
  private async dispatchWithConcurrentModeration(
    req: ToolCompletionRequest
  ): Promise<ToolCompletionResponse> {
    const controller = new AbortController()
    const callReq = this.linkAbort(req, controller)

    // The model call is wrapped so it never rejects — if moderation denies first we
    // return without awaiting it, and a discarded resolved promise raises no
    // unhandled-rejection warning.
    const modelOutcome = this.inner.completeWithTools(callReq).then(
      response => ({ ok: true as const, response }),
      error => ({ ok: false as const, error })
    )
    // Keep the contributions (not just the verdict) so a deny can carry its
    // reason code into the graceful refusal message.
    const moderationContribs = Promise.all(
      this.hooks.moderate.map(hook => hook.moderate(req))
    ).then(cs => cs.filter((c): c is NonNullable<typeof c> => c != null))

    const contribs = await moderationContribs
    if (aggregateDecision(contribs) === 'deny') {
      controller.abort() // cancel the in-flight call (§7.1)
      return this.denyRefusal(contribs, 'moderate')
    }

    const outcome = await modelOutcome
    if (!outcome.ok) return this.recoverOrThrow(req, outcome.error)
    return this.applyPostCall(req, outcome.response)
  }

  /** Link the caller's abort signal (task cancel) into ours so either can cancel the call. */
  private linkAbort(
    req: ToolCompletionRequest,
    controller: AbortController
  ): ToolCompletionRequest {
    const caller = req.signal
    if (caller) {
      if (caller.aborted) controller.abort()
      else caller.addEventListener('abort', () => controller.abort(), { once: true })
    }
    return { ...req, signal: controller.signal }
  }

  /**
   * on_error (spec §8.1): a gated hook may substitute a safe text-only result;
   * first substitute wins. No hook recovers → the error surfaces unchanged.
   */
  private async recoverOrThrow(
    req: ToolCompletionRequest,
    err: unknown
  ): Promise<ToolCompletionResponse> {
    for (const hook of this.hooks.onError) {
      const c = await hook.onError(req, err)
      if (c?.substitute) return c.substitute
    }
    throw err
  }

  /** post_call (spec §8.1): redact/subtract over the result, chained in `order`. */
  private async applyPostCall(
    req: ToolCompletionRequest,
    response: ToolCompletionResponse
  ): Promise<ToolCompletionResponse> {
    let out = response
    for (const hook of this.hooks.postCall) {
      const c = await hook.postCall(req, out)
      if (c?.substitute) out = c.substitute
    }
    return out
  }
}

/**
 * Wrap the effective (post-failover) port with the LLM-lane guardrails when any
 * built-ins OR installed hooks are configured; otherwise return it unchanged
 * (no-config compatibility, spec §5 — no extra decorator layer when unused).
 */
export function maybeWrapHookedLlmPort(
  port: LlmPort,
  config: GuardrailsConfig | undefined,
  deps: Partial<LlmLaneHookDeps> & {
    /** Per-LLM-call guardrail-input-transparency sink (spec §5.1). */
    onGuardrailActivity?: (activity: TurnGuardrailActivity) => void
  } = {}
): LlmPort {
  const hasBuiltins = !!config?.builtins && config.builtins.length > 0
  const hooks = buildLlmLaneHooks(config?.hookDescriptors, {
    getAuthToken: deps.getAuthToken ?? (() => ''),
    fetchImpl: deps.fetchImpl,
    // Per-point response caps from the admin limits block (§5); defaults in the fetcher.
    maxOutputBytes: config?.limits?.maxHookOutputBytes,
    maxRewriteBytes: config?.limits?.maxHookRewriteBytes,
  })
  const hasHooks =
    hooks.preCall.length > 0 ||
    hooks.moderate.length > 0 ||
    hooks.postCall.length > 0 ||
    hooks.onError.length > 0
  if (!hasBuiltins && !hasHooks) return port
  return new HookedLlmPort(
    port,
    buildLlmBuiltinChain(config?.builtins),
    hooks,
    buildLlmBuiltinSteps(config?.builtins),
    deps.onGuardrailActivity
  )
}
