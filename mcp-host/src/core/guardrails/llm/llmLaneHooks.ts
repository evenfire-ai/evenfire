/**
 * LLM-lane installed hooks (spec §7.3/§8) — resolve `HookDescriptor`s into
 * `RemoteLlmHook`s grouped by lifecycle point, each with a concrete `/v1`
 * fetcher. Ordered by `descriptor.order` (spec §5). The chain is
 * built-ins → installed (§7.3), applied by `HookedLlmPort`.
 */
import { type FetchLike, createHookFetcher } from '../hooks/hookFetcher'
import { RemoteLlmHook } from '../hooks/remoteLlmHook'
import type { HookDescriptor } from '../hooks/types'

export interface LlmLaneHooks {
  preCall: RemoteLlmHook[]
  moderate: RemoteLlmHook[]
  postCall: RemoteLlmHook[]
  onError: RemoteLlmHook[]
}

export interface LlmLaneHookDeps {
  getAuthToken: () => string
  /** Injected for tests / a future SSRF-guarded remote transport. */
  fetchImpl?: FetchLike
  /** Per-point response caps (spec §5/§8.1). Defaults applied in `createHookFetcher`. */
  maxOutputBytes?: number
  maxRewriteBytes?: number
}

export function buildLlmLaneHooks(
  descriptors: HookDescriptor[] | undefined,
  deps: LlmLaneHookDeps
): LlmLaneHooks {
  const preCall: RemoteLlmHook[] = []
  const moderate: RemoteLlmHook[] = []
  const postCall: RemoteLlmHook[] = []
  const onError: RemoteLlmHook[] = []
  const ordered = (descriptors ?? []).slice().sort((a, b) => a.order - b.order)
  for (const d of ordered) {
    const hook = new RemoteLlmHook(
      d,
      createHookFetcher({
        getAuthToken: deps.getAuthToken,
        fetchImpl: deps.fetchImpl,
        maxOutputBytes: deps.maxOutputBytes,
        maxRewriteBytes: deps.maxRewriteBytes,
      })
    )
    if (d.lifecyclePoints.includes('pre_call')) preCall.push(hook)
    if (d.lifecyclePoints.includes('moderate')) moderate.push(hook)
    if (d.lifecyclePoints.includes('post_call')) postCall.push(hook)
    if (d.lifecyclePoints.includes('on_error')) onError.push(hook)
  }
  return { preCall, moderate, postCall, onError }
}
