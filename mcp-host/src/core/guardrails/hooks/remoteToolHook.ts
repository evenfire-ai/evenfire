/**
 * RemoteToolHook (spec §6.2/§8) — calls an installed `PreToolUse` hook over the
 * `/v1` protocol and maps its response to a tool-lane `Contributor`, enforcing
 * the response-capability invariant (F4, §8.1): a `deny` from a hook without
 * `may_deny` downgrades to `no_decision`; an `updatedInput` without `may_rewrite`
 * is dropped. Fail-posture per `failMode` (§8.6).
 *
 * `pre_tool_use` request body = `{ tool, arguments }` (the resolved identity +
 * args); response = `{ decision?, reasonCode?, updatedInput?, additionalContext? }`.
 * Phase 3 increment: PreToolUse; PostToolUse (post-execution result transform)
 * is a later increment.
 */
import type { ToolIdentity } from '../tool/provenance'
import type { Capability, Contributor } from '../types'
import type { HookDescriptor, HookFetcher } from './types'

type ToolContributor = Contributor<Record<string, unknown>, string>

/** The model-visible portion of a tool result a `post_tool_use` hook may redact (spec §6.2). */
export interface ToolResultView {
  content: string
  isError: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

export class RemoteToolHook {
  constructor(
    private readonly descriptor: HookDescriptor,
    private readonly fetch: HookFetcher
  ) {}

  private has(cap: Capability): boolean {
    return this.descriptor.capabilities.includes(cap)
  }

  private onUnavailable(): ToolContributor | null {
    if (this.descriptor.failMode === 'closed' && this.has('may_deny')) {
      return this.contribution('deny', 'hook_unavailable')
    }
    return null
  }

  private contribution(
    decision: ToolContributor['decision'],
    reasonCode: string,
    extra: Partial<ToolContributor> = {}
  ): ToolContributor {
    return {
      phase: 'pre',
      source: 'hook',
      sourceId: this.descriptor.id,
      decision,
      reasonCode,
      ...extra,
    }
  }

  /** `pre_tool_use` (spec §6.2): deny → deny (gated), updatedInput → rewrite (gated), else allow. */
  async preToolUse(
    identity: ToolIdentity,
    args: Record<string, unknown>
  ): Promise<ToolContributor | null> {
    if (!this.descriptor.lifecyclePoints.includes('pre_tool_use')) return null
    const res = await this.fetch({
      point: 'pre_tool_use',
      descriptor: this.descriptor,
      body: { tool: identity, arguments: args },
    })
    // §8.1: non-200 or unavailable → fail-mode (never a silent allow).
    if (res.unavailable || res.status !== 200) return this.onUnavailable()

    const body = isRecord(res.body) ? res.body : {}
    if (body.decision === 'deny') {
      const decision = this.has('may_deny') ? 'deny' : 'no_decision'
      return this.contribution(decision, String(body.reasonCode ?? 'hook_denied'), {
        audit: { modelReason: typeof body.reasonCode === 'string' ? body.reasonCode : undefined },
      })
    }
    // updatedInput = full args replacement; only honored with may_rewrite (F4).
    if (isRecord(body.updatedInput) && this.has('may_rewrite')) {
      return this.contribution('allow', 'hook_rewrite', { rewrite: body.updatedInput })
    }
    return null // allow / no honored action → no contribution.
  }

  /**
   * `post_tool_use` (spec §6.2 / §10 #3): bounded, model-visible-only REDACTION of
   * a tool result. Gated by `may_rewrite` — `may_substitute_result` is LLM-lane-only
   * (§10 #3), so the tool lane rewrites the result `content` rather than substituting
   * a caller-visible result. `is_error` is preserved (redaction never flips
   * success/failure). A fail-closed redactor that's unavailable withholds the
   * un-redacted content (§8.6). Returns the redacted view, or `null` for no change.
   */
  async postToolUse(
    identity: ToolIdentity,
    args: Record<string, unknown>,
    result: ToolResultView
  ): Promise<ToolResultView | null> {
    if (!this.descriptor.lifecyclePoints.includes('post_tool_use')) return null
    const res = await this.fetch({
      point: 'post_tool_use',
      descriptor: this.descriptor,
      body: {
        tool: identity,
        arguments: args,
        result: { content: result.content, is_error: result.isError },
      },
    })
    // §8.6: a fail-closed redactor that can't run must NOT leak the un-redacted result.
    if (res.unavailable || res.status !== 200) {
      if (this.descriptor.failMode === 'closed' && this.has('may_rewrite')) {
        return {
          content: 'This tool result was withheld by a content guardrail policy.',
          isError: result.isError,
        }
      }
      return null
    }

    const body = isRecord(res.body) ? res.body : {}
    const patched = isRecord(body.updatedResult) ? body.updatedResult : undefined
    if (!patched || !this.has('may_rewrite')) return null
    // Redaction is content-only; is_error stays authoritative.
    return {
      content: typeof patched.content === 'string' ? patched.content : result.content,
      isError: result.isError,
    }
  }
}
