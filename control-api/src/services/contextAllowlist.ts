import { extractK8sError } from '../http/k8sError.js'
import type { K8sGateway } from '../k8s.js'
import { K8sNotFoundError } from './resourceService.js'

/** Shape of a Context CR as the allowlist writers read it. */
export type ContextAllowlistSnapshot = {
  metadata?: { name?: string; uid?: string; resourceVersion?: string }
  spec?: Record<string, unknown> & { contextId?: string; mcpServers?: string[] }
}

/**
 * Pure edit of `spec.mcpServers`. Returns the new list, or `null` when the current
 * list already satisfies the caller (no write is issued).
 */
export type ContextAllowlistEdit = (servers: readonly string[]) => string[] | null

/**
 * Same shape as the registry's historical inline error so its outcome classifier
 * (`statusCode` 503, string `code`) keeps treating it identically.
 */
export class ContextIdentityUnavailableError extends Error {
  readonly statusCode = 503
  readonly code = 'context_identity_unavailable'
  constructor(contextName: string) {
    super(`Context/${contextName} identity unavailable; refusing stale update`)
    this.name = 'ContextIdentityUnavailableError'
  }
}

/**
 * The Context status subresource moves the resourceVersion on every controller status
 * write, so a first-attempt 409 is routine and not evidence of a competing allowlist
 * writer. Three attempts absorb that churn while still surfacing a genuinely hot object.
 */
export const CONTEXT_ALLOWLIST_MAX_ATTEMPTS = 3

type AllowlistGateway = Pick<K8sGateway, 'getResource' | 'updateResource'>

function isConflict(err: unknown): boolean {
  return extractK8sError(err)?.status === 409
}

export function isNotFound(err: unknown): boolean {
  return err instanceof K8sNotFoundError || extractK8sError(err)?.status === 404
}

/**
 * Read-edit-write of one Context's `spec.mcpServers`, fenced on the uid AND
 * resourceVersion of the read it edited. A write without the resourceVersion replays
 * a stale list: an attach that read `[X]` before X's uninstall stripped it would put
 * X back. On 409 the Context is re-read and the edit recomputed from the fresh list,
 * never replayed.
 *
 * `initial` lets a caller that already listed the Context skip the first GET.
 * `onRead` observes every snapshot the edit is computed from (registry keeps the last
 * one as the before-image for its ambiguous-outcome readback).
 */
export async function editContextAllowlist(
  gateway: AllowlistGateway,
  target: { name: string; namespace?: string },
  edit: ContextAllowlistEdit,
  options: {
    initial?: ContextAllowlistSnapshot
    onRead?: (ctx: ContextAllowlistSnapshot) => void
    maxAttempts?: number
  } = {}
): Promise<{ changed: boolean }> {
  const { name, namespace } = target
  const maxAttempts = options.maxAttempts ?? CONTEXT_ALLOWLIST_MAX_ATTEMPTS
  for (let attempt = 1; ; attempt += 1) {
    const ctx =
      attempt === 1 && options.initial
        ? options.initial
        : ((namespace === undefined
            ? await gateway.getResource('contexts', name)
            : await gateway.getResource('contexts', name, namespace)) as ContextAllowlistSnapshot)
    options.onRead?.(ctx)
    const uid = ctx.metadata?.uid
    const resourceVersion = ctx.metadata?.resourceVersion
    if (
      typeof uid !== 'string' ||
      !uid ||
      typeof resourceVersion !== 'string' ||
      !resourceVersion
    ) {
      throw new ContextIdentityUnavailableError(name)
    }
    const next = edit(ctx.spec?.mcpServers ?? [])
    if (next === null) return { changed: false }
    const body = {
      metadata: { uid, resourceVersion },
      spec: {
        ...ctx.spec,
        contextId: ctx.spec?.contextId ?? name,
        mcpServers: next,
      } as Record<string, unknown>,
    }
    try {
      if (namespace === undefined) {
        await gateway.updateResource('contexts', name, body)
      } else {
        await gateway.updateResource('contexts', name, body, namespace)
      }
      return { changed: true }
    } catch (err) {
      if (isConflict(err) && attempt < maxAttempts) continue
      throw err
    }
  }
}

/** Adds `serverName` to the Context allowlist unless it is already there. */
export function attachServerToContext(
  gateway: AllowlistGateway,
  target: { name: string; namespace?: string },
  serverName: string,
  options: { onRead?: (ctx: ContextAllowlistSnapshot) => void } = {}
): Promise<{ changed: boolean }> {
  return editContextAllowlist(
    gateway,
    target,
    servers => (servers.includes(serverName) ? null : [...servers, serverName]),
    options
  )
}

/**
 * Removes `serverName` from every Context in `namespace` that allowlists it. A Context
 * deleted between the list and its write is already clean. Throws on the first Context
 * that cannot be written; the ones already stripped are returned through `onStripped`
 * so a partial run is reportable.
 */
export async function stripServerFromContexts(
  gateway: Pick<K8sGateway, 'listResource' | 'getResource' | 'updateResource'>,
  namespace: string,
  serverName: string,
  onStripped: (contextName: string) => void
): Promise<void> {
  const contexts = (await gateway.listResource('contexts', namespace)) as ContextAllowlistSnapshot[]
  for (const ctx of contexts) {
    const contextName = ctx.metadata?.name
    if (!contextName || !(ctx.spec?.mcpServers ?? []).includes(serverName)) continue
    try {
      const { changed } = await editContextAllowlist(
        gateway,
        { name: contextName, namespace },
        servers => (servers.includes(serverName) ? servers.filter(s => s !== serverName) : null),
        { initial: ctx }
      )
      if (changed) onStripped(contextName)
    } catch (err) {
      if (isNotFound(err)) continue
      throw err
    }
  }
}
