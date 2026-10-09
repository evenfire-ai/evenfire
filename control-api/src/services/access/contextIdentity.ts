/**
 * Context identity resolution (PR #1004 R2).
 *
 * A Context CR has two identifiers that are NOT interchangeable bare strings:
 * its resource name (`metadata.name`) and its wire id (`spec.contextId`). The
 * CRD requires both without requiring them to be equal.
 *
 *   - A Host's and an McpServer's `spec.contextRef` name the Context RESOURCE.
 *     host-context-controller reads it with
 *     `getNamespacedCustomObject({ name: contextRef })` and treats a 404 as "no
 *     servers", so a ref resolves by `metadata.name` only — never through
 *     another resource's `spec.contextId`.
 *   - A legacy `user_contexts.context_id` predates that contract and may hold
 *     either identifier, so it resolves by name first and otherwise by an
 *     UNAMBIGUOUS wire-id alias.
 *
 * Every reference resolves to at most one resource; allowlists are never
 * merged across resources, and an unresolved reference fails closed. The
 * indexes are built over the full listing before any lookup, so listing order
 * cannot change a result.
 */
import type { K8sGateway } from '../../k8s.js'

export interface ContextCR {
  metadata?: {
    name?: string
    namespace?: string
    deletionTimestamp?: string | null
  }
  spec?: { contextId?: string; mcpServers?: unknown[] }
}

/** Where a reference came from — this decides which identifiers it may match. */
export type ContextRefOrigin = 'host' | 'legacy' | 'server'

export interface ContextRefInput {
  ref: string
  origin: ContextRefOrigin
}

export type ContextResolutionFailure =
  | 'missing'
  | 'ineligible'
  | 'ambiguous_alias'
  | 'alias_collision'
  | 'duplicate_name'

export type ContextRefResolution =
  | {
      ref: string
      origin: ContextRefOrigin
      resource: ContextCR
      /** `contextResourceKey(resource)` — the resource's identity. */
      key: string
      matchedBy: 'name' | 'contextId'
    }
  | {
      ref: string
      origin: ContextRefOrigin
      resource: null
      reason: ContextResolutionFailure
    }

/** The map key for one reference. The same string from two origins stays two keys. */
export function refKey(input: ContextRefInput): string {
  return `${input.origin}:${input.ref}`
}

/** A Context resource's identity: its `metadata.name` within the listed namespace. */
export function contextResourceKey(ctx: ContextCR): string {
  return String(ctx.metadata?.name ?? '')
}

/** The trimmed, non-empty server names a Context allowlists in `spec.mcpServers`. */
export function allowedServerNames(ctx: ContextCR): Set<string> {
  const names = new Set<string>()
  const raw = ctx.spec?.mcpServers
  for (const name of Array.isArray(raw) ? raw : []) {
    if (typeof name === 'string' && name.trim()) names.add(name.trim())
  }
  return names
}

function contextName(ctx: ContextCR): string | null {
  const name = ctx.metadata?.name
  return typeof name === 'string' && name ? name : null
}

/**
 * A resource a reference may resolve to: named, not terminating, and in the
 * expected namespace (an absent namespace is the listed one).
 */
function isEligible(ctx: ContextCR, namespace: string): boolean {
  if (!contextName(ctx)) return false
  if (ctx.metadata?.deletionTimestamp) return false
  const ns = ctx.metadata?.namespace
  return ns === undefined || ns === null || ns === '' || ns === namespace
}

function push<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const list = index.get(key)
  if (list) list.push(value)
  else index.set(key, [value])
}

/**
 * Resolve each reference to at most one Context resource.
 *
 *   - `host` / `server`: by `metadata.name` only. One eligible match resolves;
 *     one ineligible match is `ineligible`; several are `duplicate_name`.
 *   - `legacy`: a name match shadows aliasing (eligible → resolved, ineligible
 *     → `ineligible`, several → `duplicate_name`); an eligible name match that
 *     another eligible resource also claims as its `spec.contextId` is an
 *     `alias_collision`. Without a name match, exactly one eligible
 *     `spec.contextId` match resolves; several are `ambiguous_alias`.
 *   - Anything else is `missing`.
 */
export function resolveContextRefs(
  contexts: readonly ContextCR[],
  refs: readonly ContextRefInput[],
  opts: { namespace: string }
): Map<string, ContextRefResolution> {
  const byName = new Map<string, ContextCR[]>()
  const byContextId = new Map<string, ContextCR[]>()
  for (const ctx of contexts) {
    const name = contextName(ctx)
    if (!name) continue
    push(byName, name, ctx)
    if (!isEligible(ctx, opts.namespace)) continue
    const contextId = ctx.spec?.contextId
    if (typeof contextId === 'string' && contextId) push(byContextId, contextId, ctx)
  }

  const out = new Map<string, ContextRefResolution>()
  for (const input of refs) {
    const { ref, origin } = input
    const fail = (reason: ContextResolutionFailure): ContextRefResolution => ({
      ref,
      origin,
      resource: null,
      reason,
    })
    const resolved = (
      resource: ContextCR,
      matchedBy: 'name' | 'contextId'
    ): ContextRefResolution => ({
      ref,
      origin,
      resource,
      key: contextResourceKey(resource),
      matchedBy,
    })

    let result: ContextRefResolution
    const named = byName.get(ref) ?? []
    if (named.length > 1) {
      result = fail('duplicate_name')
    } else if (named.length === 1) {
      const [match] = named
      if (!isEligible(match, opts.namespace)) {
        result = fail('ineligible')
      } else if (
        origin === 'legacy' &&
        (byContextId.get(ref) ?? []).some(aliased => aliased !== match)
      ) {
        result = fail('alias_collision')
      } else {
        result = resolved(match, 'name')
      }
    } else if (origin !== 'legacy') {
      result = fail('missing')
    } else {
      const aliased = byContextId.get(ref) ?? []
      if (aliased.length === 1) result = resolved(aliased[0], 'contextId')
      else if (aliased.length > 1) result = fail('ambiguous_alias')
      else result = fail('missing')
    }
    out.set(refKey(input), result)
  }
  return out
}

/**
 * List the Contexts of `namespace` once and resolve `refs` against them. No
 * I/O for no refs. A list failure propagates — callers decide whether an
 * outage degrades (catalog producers) or fails the request (admission).
 */
export async function loadContextResolution(
  gateway: K8sGateway,
  namespace: string,
  refs: readonly ContextRefInput[]
): Promise<Map<string, ContextRefResolution>> {
  if (refs.length === 0) return new Map()
  const listed = await gateway.listResource('contexts', namespace)
  const contexts = Array.isArray(listed) ? (listed as ContextCR[]) : []
  return resolveContextRefs(contexts, refs, { namespace })
}
