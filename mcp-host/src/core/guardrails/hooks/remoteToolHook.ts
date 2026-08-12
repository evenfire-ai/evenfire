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
}
