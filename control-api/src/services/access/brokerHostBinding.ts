import type { DbClient } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import { type McpHostControlClaims, isHccControlLineage } from '../../utils/auth/mcpHostJwtToken.js'
import { isK8sResourceNotFound } from './mcpInvocable.js'

/**
 * Binding of an OAuth-broker caller to the Host it runs for. The broker
 * (`user-token`, `grants/exists`) never trusts the request body for the
 * Context: it derives it from the authenticated Host, with the same relation
 * host-context-controller uses to hand mcp-servers to that Host (Context by
 * name, live, allowlist matched exactly). The broker must not be more
 * permissive than the controller that decides what the Host may reach.
 */

// DNS-1123 subdomain, the shape a k8s resource name takes. Checked before any
// apiserver read: a malformed name would otherwise surface a non-404 apiserver
// error, and an empty one would address the collection instead of an object.
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
export function isValidK8sName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && K8S_NAME_RE.test(name)
}

// Stricter than Postgres' `::uuid` cast (which also accepts braces and no
// hyphens): anything that passes here is guaranteed to cast, so a channel
// provider id or a test sender is a definitive denial, never a DB error.
const CANONICAL_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID_RE.test(value)
}

export type CallerLineage =
  | { kind: 'ok'; hostName: string; hostUid: string }
  | { kind: 'lineage' }
  | { kind: 'unauthenticated' }

/**
 * Synchronous caller checks. Lineage goes first so a workflow-recipe token gets
 * a definitive 403 instead of a 401 that would make it renew for nothing; an
 * HCC token without host_uid predates the claim and is sent to renew.
 */
export function checkBrokerCallerLineage(
  claims: McpHostControlClaims,
  cfg: { hostsNamespace: string }
): CallerLineage {
  if (!isHccControlLineage(claims, cfg.hostsNamespace)) return { kind: 'lineage' }
  if (typeof claims.host_uid !== 'string' || claims.host_uid.length === 0) {
    return { kind: 'unauthenticated' }
  }
  return { kind: 'ok', hostName: claims.hostRefs[0], hostUid: claims.host_uid }
}

type ObjectMeta = { name?: unknown; uid?: unknown; deletionTimestamp?: unknown }

export interface HostCR {
  metadata?: ObjectMeta
  spec?: { contextRef?: unknown }
}

export interface ContextCR {
  metadata?: ObjectMeta
  spec?: { contextId?: unknown; mcpServers?: unknown }
}

export interface ResolvedHostBinding {
  kind: 'ok'
  hostName: string
  /** The Host's Context, by name: the only Context the caller may act for. */
  contextName: string
  host: HostCR
  ctx: ContextCR
  allowlist: readonly string[]
}

export type HostBinding =
  | ResolvedHostBinding
  | { kind: 'denied' }
  | { kind: 'unavailable'; cause: unknown }

export type BrokerBindingGateway = Pick<K8sGateway, 'getResource'>

/** Not being deleted: the apiserver keeps a deleting object readable until finalizers run. */
export function isLive(meta: { deletionTimestamp?: unknown } | undefined): boolean {
  return meta?.deletionTimestamp === undefined || meta.deletionTimestamp === null
}

/**
 * Live Host → Context resolution. Namespaces are always explicit: without one
 * the gateway falls back to a cluster-wide list. Not-found and every failed
 * condition are a definitive denial; any other read error is `unavailable`, so
 * callers never forward an apiserver RBAC/availability error to the client.
 * A draining Host still resolves: its pod keeps serving until it is gone.
 */
export async function resolveBrokerHostBinding(
  gateway: BrokerBindingGateway,
  hostName: string,
  hostUid: string,
  cfg: { hostsNamespace: string; contextsNamespace: string }
): Promise<HostBinding> {
  let host: HostCR
  try {
    host = (await gateway.getResource('hosts', hostName, cfg.hostsNamespace)) as HostCR
  } catch (err) {
    return isK8sResourceNotFound(err) ? { kind: 'denied' } : { kind: 'unavailable', cause: err }
  }
  if (!host || !isLive(host.metadata) || host.metadata?.uid !== hostUid) return { kind: 'denied' }

  const contextRef = host.spec?.contextRef
  if (typeof contextRef !== 'string' || !isValidK8sName(contextRef)) return { kind: 'denied' }

  let ctx: ContextCR
  try {
    ctx = (await gateway.getResource('contexts', contextRef, cfg.contextsNamespace)) as ContextCR
  } catch (err) {
    return isK8sResourceNotFound(err) ? { kind: 'denied' } : { kind: 'unavailable', cause: err }
  }
  if (!ctx || ctx.metadata?.name !== contextRef || !isLive(ctx.metadata)) return { kind: 'denied' }

  const raw = ctx.spec?.mcpServers
  const allowlist = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { kind: 'ok', hostName, contextName: contextRef, host, ctx, allowlist }
}

/**
 * The admin API refuses a `spec.contextId` that differs from the Context's
 * name, but writers outside it (kubectl) and Contexts written before that rule
 * can still carry one. The broker keys nothing by contextId, so a mismatch is
 * only worth a warning: denying on it would silently cut OAuth for every Host
 * of that Context.
 */
export function hasContextIdMismatch(ctx: ContextCR): boolean {
  const contextId = ctx.spec?.contextId
  return typeof contextId === 'string' && contextId !== ctx.metadata?.name
}

// Host entry rule: an active user with the agent assigned directly or through
// any active team membership. rpc-proxy only counts the team of the current
// session; the broker never sees that session, so it accepts any active team
// (a superset, so nobody who can enter the Host loses their token).
// Context membership (`user_contexts`) deliberately does not count: it never
// admits a user to a Host, and counting it would let any Context member's
// identity be used from every Host of that Context.
const HOST_ACCESS_SQL = `
  SELECT 1
    FROM users u
   WHERE u.id = $1::uuid
     AND u.lifecycle_state = 'active'
     AND (
       EXISTS (SELECT 1 FROM user_agents ua WHERE ua.user_id = u.id AND ua.agent_name = $2)
       OR EXISTS (
         SELECT 1
           FROM team_members tm
           JOIN team_agents ta ON ta.team_id = tm.team_id
          WHERE tm.user_id = u.id
            AND tm.status = 'active'
            AND ta.agent_name = $2
       )
     )
   LIMIT 1`

/**
 * Whether `userId` may act through Host `hostName`. A non-canonical id is a
 * denial without touching the DB. Throws on a DB error so the caller decides
 * between fail-closed (token mint) and fail-open (existence sweep).
 */
export async function hostAccessForUser(
  db: Pick<DbClient, 'query'>,
  userId: string,
  hostName: string
): Promise<'allowed' | 'denied'> {
  if (!isCanonicalUuid(userId)) return 'denied'
  const result = await db.query(HOST_ACCESS_SQL, [userId, hostName])
  return (result.rowCount ?? 0) > 0 ? 'allowed' : 'denied'
}
