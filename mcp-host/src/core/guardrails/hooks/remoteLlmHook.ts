/**
 * RemoteLlmHook (spec §8) — calls an installed hook over the `/v1` protocol and
 * maps its response to an LLM-lane `Contributor`, enforcing the security
 * invariants on the RESPONSE (the hook is an untrusted out-of-process container):
 *
 *  - Response-capability enforcement (F4, §8.1): a `reject` from a hook without
 *    `may_deny` downgrades to `no_decision`; a `patch` without `may_rewrite` is
 *    dropped; a `recover` without `may_substitute_result` is dropped.
 *  - System prompt is immutable to installed hooks (N4, §8.1): a `pre_call`
 *    patch may edit only NON-system messages + params — system-role messages in
 *    the patch are dropped.
 *  - Actions come only from the model (N5, §8.1): an `on_error recover` is
 *    TEXT-ONLY (no tool_calls); a `post_call` transform may drop tool_calls but
 *    never introduce them.
 *  - Fail-posture (§8.6): an unavailable hook degrades per its `failMode`
 *    (closed → deny `hook_unavailable`; open → no contribution).
 *
 * Phase 3 increment 1: pre_call / moderate / on_error mapping + invariants,
 * fetcher-injected. Content projection (§8.4) and the concrete fetcher land next.
 */
import { FinishReason } from '../../types'
import type {
  ChatMessage,
  ToolCall,
  ToolCompletionRequest,
  ToolCompletionResponse,
} from '../../types'
import type { Capability, Contributor } from '../types'
import { type HookBreakerRegistry, defaultBreakerRegistry } from './hookBreaker'
import { projectForHook } from './hookProjection'
import type { HookDescriptor, HookFetcher, HookHttpResult, LifecyclePoint } from './types'

type LlmContributor = Contributor<ToolCompletionRequest, ToolCompletionResponse>

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** Strip system-role messages from a hook's messages patch (N4 — system prompt is first-party). */
function stripSystemRole(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(m => m.role !== 'system')
}

/** Stable, key-sorted serialization so a tool-call's argument digest is order-independent. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** Identity + argument digest — the key that decides whether a tool_call is the model's own (N5). */
function toolCallDigest(tc: { name?: unknown; arguments?: unknown }): string {
  return `${typeof tc.name === 'string' ? tc.name : ''}:${stableStringify(tc.arguments)}`
}

/** Content-filtered stand-in returned when a fail-closed redactor is unavailable (§8.6). */
function filteredPostResponse(usage: ToolCompletionResponse['usage']): ToolCompletionResponse {
  return {
    content: 'This response was withheld by a content guardrail policy.',
    tool_calls: null,
    usage,
    finish_reason: FinishReason.ContentFilter,
  }
}

export class RemoteLlmHook {
  constructor(
    private readonly descriptor: HookDescriptor,
    private readonly fetch: HookFetcher,
    /** Shared so a trip survives the per-task rebuild of this instance (§8.6). */
    private readonly breakers: HookBreakerRegistry = defaultBreakerRegistry,
    /** Injectable clock for deterministic breaker tests. */
    private readonly now: () => number = () => Date.now()
  ) {}

  private has(cap: Capability): boolean {
    return this.descriptor.capabilities.includes(cap)
  }

  /** Identity of the breaker state (per hook pod+path), shared across tasks (§8.6). */
  private breakerKey(): string {
    return `${this.descriptor.endpoint}${this.descriptor.path}`
  }

  /**
   * The circuit breaker is honored only for an advisory hook that opted into
   * `breaker` mode (§8.6): a deny-authoritative (`may_deny`) hook always dials
   * strict so it can never be tripped into failing open.
   */
  private breakerEngaged(): boolean {
    return this.descriptor.onUnavailable?.mode === 'breaker' && !this.has('may_deny')
  }

  /**
   * Transport with the quarantine gate (§8.2) and the §8.6 circuit breaker.
   *
   * A quarantined hook (e.g. digest mismatch) never reaches the network — every
   * call reports `unavailable`, so each point's §8.6 fail-posture applies. When a
   * `breaker`-mode advisory hook has tripped, calls likewise short-circuit to
   * `unavailable` WITHOUT dialing for the cooldown window, so a down hook is not
   * re-dialed (and re-timed-out) on every request. Every branch reports
   * `unavailable` — never a silent allow.
   */
  private async fetchGuarded(args: {
    point: LifecyclePoint
    descriptor: HookDescriptor
    body: unknown
  }): Promise<HookHttpResult> {
    if (this.descriptor.quarantined) {
      return { status: 0, body: undefined, unavailable: true }
    }
    const engaged = this.breakerEngaged()
    if (engaged && this.breakers.isOpen(this.breakerKey(), this.now())) {
      // Breaker open: skip the dial (and its timeout); report unavailable.
      return { status: 0, body: undefined, unavailable: true }
    }
    const res = await this.fetch(args)
    if (engaged) {
      const policy = this.descriptor.onUnavailable!
      if (res.unavailable) {
        const tripped = this.breakers.recordFailure(
          this.breakerKey(),
          policy.failureThreshold,
          policy.cooldownMs,
          this.now()
        )
        if (tripped) {
          console.warn(
            `[Guardrails] hook ${this.descriptor.id} breaker tripped after ${policy.failureThreshold} failures; ` +
              `failing open for ${policy.cooldownMs}ms`
          )
        }
      } else {
        this.breakers.recordSuccess(this.breakerKey())
      }
    }
    return res
  }

  private handles(point: LifecyclePoint): boolean {
    return this.descriptor.lifecyclePoints.includes(point)
  }

  /** Fail-posture (§8.6): closed → deny `hook_unavailable`; open → no contribution. */
  private onUnavailable(): LlmContributor | null {
    if (this.descriptor.failMode === 'closed' && this.has('may_deny')) {
      return this.contribution('deny', 'hook_unavailable')
    }
    // Fail-open, or a non-deny-authoritative hook: no contribution (advisory).
    return null
  }

  private contribution(
    decision: LlmContributor['decision'],
    reasonCode: string,
    extra: Partial<LlmContributor> = {}
  ): LlmContributor {
    return {
      phase: extra.phase ?? 'pre',
      source: 'hook',
      sourceId: this.descriptor.id,
      decision,
      reasonCode,
      ...extra,
    }
  }

  /** `pre_call` (spec §8.1): reject → deny (gated), continue+patch → rewrite (gated), else allow. */
  async preCall(request: ToolCompletionRequest): Promise<LlmContributor | null> {
    if (!this.handles('pre_call')) return null
    const res = await this.fetchGuarded({
      point: 'pre_call',
      descriptor: this.descriptor,
      body: projectForHook(this.descriptor, 'pre_call', { request }),
    })
    // §8.1: non-200 or unavailable → fail-mode (never a silent allow).
    if (res.unavailable || res.status !== 200) return this.onUnavailable()

    const body = isRecord(res.body) ? res.body : {}
    if (body.action === 'reject') {
      // F4: only honored with may_deny; otherwise downgrade to no_decision.
      const decision = this.has('may_deny') ? 'deny' : 'no_decision'
      return this.contribution(decision, String(body.code ?? 'content_filtered'), {
        audit: { modelReason: typeof body.message === 'string' ? body.message : undefined },
      })
    }
    if (body.action === 'continue') {
      const patch = isRecord(body.patch) ? body.patch : undefined
      if (patch && this.has('may_rewrite')) {
        return this.contribution('allow', 'shaped', { rewrite: this.applyPatch(request, patch) })
      }
      return null // continue with no honored patch → no contribution (allow).
    }
    // A 200 with no valid action is non-conforming (§8.1) → fail-mode.
    return this.onUnavailable()
  }

  /** Apply a `pre_call` patch: NON-system messages + params only (N4). */
  private applyPatch(
    request: ToolCompletionRequest,
    patch: Record<string, unknown>
  ): ToolCompletionRequest {
    const next: ToolCompletionRequest = { ...request }
    if (Array.isArray(patch.messages)) {
      // N4: the system prompt is immutable to installed hooks — neither added nor
      // REMOVED. The patch replaces only the non-system messages; the original
      // system prefix is spliced back so a hook can't drop it by omission (on the
      // legacy path the system prompt lives inside `messages`; on the tiered path
      // there is none here and it rides `systemPromptParts`, preserved by the spread).
      const originalSystem = request.messages.filter(m => m.role === 'system')
      next.messages = [...originalSystem, ...stripSystemRole(patch.messages as ChatMessage[])]
    }
    const params = isRecord(patch.params) ? patch.params : undefined
    if (params) {
      if (typeof params.temperature === 'number') next.temperature = params.temperature
      if (typeof params.max_tokens === 'number') next.max_tokens = params.max_tokens
      if (
        params.tool_choice === 'auto' ||
        params.tool_choice === 'none' ||
        params.tool_choice === 'required'
      ) {
        next.tool_choice = params.tool_choice
      }
    }
    return next
  }

  /** `moderate` (spec §8.1): 2xx = pass (no contribution); 4xx = deny (gated). */
  async moderate(request: ToolCompletionRequest): Promise<LlmContributor | null> {
    if (!this.handles('moderate')) return null
    const res = await this.fetchGuarded({
      point: 'moderate',
      descriptor: this.descriptor,
      body: projectForHook(this.descriptor, 'moderate', { request }),
    })
    if (res.unavailable) return this.onUnavailable()
    if (res.status >= 200 && res.status < 300) return null // pass

    const body = isRecord(res.body) ? res.body : {}
    const decision = this.has('may_deny') ? 'deny' : 'no_decision'
    return this.contribution(decision, String(body.code ?? 'moderation_blocked'), {
      audit: { modelReason: typeof body.message === 'string' ? body.message : undefined },
    })
  }

  /**
   * `post_call` (spec §8.1): transform the model-visible result — may redact
   * `content` or DROP `tool_calls`, but NEVER introduce a `tool_call` absent from
   * the model's own output (N5, digest-checked). Gated by `may_substitute_result`
   * (it changes the caller-visible result, not the authoritative action flow, §4.3).
   * A fail-closed redactor that's unavailable withholds the un-redacted body (§8.6).
   */
  async postCall(
    request: ToolCompletionRequest,
    response: ToolCompletionResponse
  ): Promise<LlmContributor | null> {
    if (!this.handles('post_call')) return null
    const res = await this.fetchGuarded({
      point: 'post_call',
      descriptor: this.descriptor,
      body: projectForHook(this.descriptor, 'post_call', { response }),
    })
    // §8.6: a fail-closed redactor that can't run must NOT leak the un-redacted body.
    if (res.unavailable || res.status !== 200) {
      if (this.descriptor.failMode === 'closed' && this.has('may_substitute_result')) {
        return this.contribution('allow', 'post_hook_unavailable', {
          phase: 'post',
          substitute: filteredPostResponse(response.usage),
        })
      }
      return null
    }

    const body = isRecord(res.body) ? res.body : {}
    const patched = isRecord(body.response) ? body.response : undefined
    if (!patched || !this.has('may_substitute_result')) return null

    // N5: the result may keep only tool_calls the model itself emitted. We intersect
    // the hook's kept digests with the ORIGINAL calls, so returned entries are always
    // the model's own objects — a hook can drop, never add or rewrite, a call.
    let toolCalls = response.tool_calls
    if (Array.isArray(patched.tool_calls)) {
      const kept = new Set(patched.tool_calls.filter(isRecord).map(toolCallDigest))
      const filtered = (response.tool_calls ?? []).filter((tc: ToolCall) =>
        kept.has(toolCallDigest(tc))
      )
      toolCalls = filtered.length > 0 ? filtered : null
    }

    const substitute: ToolCompletionResponse = {
      content: typeof patched.content === 'string' ? patched.content : response.content,
      tool_calls: toolCalls,
      usage: response.usage,
      finish_reason: response.finish_reason,
    }
    return this.contribution('allow', 'post_transformed', { phase: 'post', substitute })
  }

  /**
   * `on_error` (spec §8.1): `recover` → a TEXT-ONLY substitute (N5 — no tool_calls),
   * gated by may_substitute_result; otherwise no recovery (the error surfaces).
   */
  async onError(request: ToolCompletionRequest, error: unknown): Promise<LlmContributor | null> {
    if (!this.handles('on_error')) return null
    const res = await this.fetchGuarded({
      point: 'on_error',
      descriptor: this.descriptor,
      body: projectForHook(this.descriptor, 'on_error', { request, error }),
    })
    // Recovery only on a proper 200 `recover`; anything else = no recovery (error surfaces).
    if (res.unavailable || res.status !== 200) return null

    const body = isRecord(res.body) ? res.body : {}
    if (body.action !== 'recover' || !this.has('may_substitute_result')) return null

    const resp = isRecord(body.response) ? body.response : {}
    // N5: recovery is text-only — a substitute never introduces tool_calls.
    const substitute: ToolCompletionResponse = {
      content: typeof resp.content === 'string' ? resp.content : '',
      tool_calls: null,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      finish_reason: FinishReason.Stop,
    }
    return this.contribution('allow', 'recovered', { phase: 'post', substitute })
  }
}
