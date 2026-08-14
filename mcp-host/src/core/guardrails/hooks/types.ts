/**
 * Installed-hook delivery types (spec §8) — Phase 3.
 *
 * A `RemoteLlmHook` calls an installed hook over the `/v1` protocol and maps its
 * response to a lane `Contributor`, enforcing the response-capability + action
 * invariants (spec §8.1). The HTTP transport is injected (`HookFetcher`) so the
 * mapping is testable without real networking; the concrete fetcher (in-cluster
 * fetch for image/service, SSRF-guarded egress for remote) is a later increment.
 */
import type { Capability } from '../types'

/** The `/v1` lifecycle endpoints (spec §8.1) — LLM lane + tool lane. */
export type LifecyclePoint =
  | 'pre_call'
  | 'moderate'
  | 'post_call'
  | 'on_error'
  | 'pre_tool_use'
  | 'post_tool_use'

/** A resolved installed hook: its endpoint + admin-granted grants (from the LlmHook CR + Host block). */
export interface HookDescriptor {
  /** LlmHook CR name (spec §8.2 hook resolution). */
  id: string
  /** Base endpoint (image/service Service URL, or a remote https:// URL). */
  endpoint: string
  /** API path on the endpoint; calls go to `{endpoint}{path}/v1/{point}` (spec §8.1/§8.2). */
  path: string
  lifecyclePoints: readonly LifecyclePoint[]
  /** Admin-granted capabilities (spec §4.3/§5); enforced on the RESPONSE (§8.1). */
  capabilities: readonly Capability[]
  /** Fail-posture when the hook is unavailable (spec §8.6). */
  failMode: 'open' | 'closed'
  order: number
  /**
   * True for a `remote` (external) target dialed over the public internet. Such
   * calls MUST go through the SSRF-guarded transport (reject private/metadata
   * ranges, DNS-pin). In-cluster `image`/`service` targets resolve to
   * cluster-private IPs and are NOT external, so they bypass that guard.
   */
  external?: boolean
  /**
   * True when the hook resolved but is NOT trusted to run — e.g. its reconciled
   * image digest no longer matches the admin-pinned reference (§8.2). Every
   * `/v1` call short-circuits to "unavailable" so the hook's fail-posture (§8.6)
   * applies: a `may_deny` (fail-closed) hook DENIES; an advisory hook contributes
   * nothing (skip). Never silently allows.
   */
  quarantined?: boolean
}

/** Result of one `/v1` HTTP call. `unavailable` = 5xx / timeout / connection error / malformed body (spec §8.1). */
export interface HookHttpResult {
  status: number
  body: unknown
  unavailable: boolean
}

/** Injected transport: POST the redacted body to `{endpoint}{path}/v1/{point}` and return the parsed result. */
export type HookFetcher = (args: {
  point: LifecyclePoint
  descriptor: HookDescriptor
  body: unknown
}) => Promise<HookHttpResult>
