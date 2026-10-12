import type { DbClient } from '../db.js'
import { extractK8sError, k8sSafeFailureMessage } from '../http/k8sError.js'
import type { K8sGateway } from '../k8s.js'
import type { Logger } from '../observability/logger.js'
import { mcpServerUninstallTeardownFailuresTotal } from '../observability/metrics.js'
import { isNotFound, stripServerFromContexts } from '../services/contextAllowlist.js'
import { type SecretCleanupCapture, captureSecretForCleanup } from '../services/secretCleanup.js'
import type { DcrDeps } from './dcr.js'
import { teardownMcpServerOAuthState } from './mcpServerOAuthTeardown.js'
import { deleteOAuthGrantsForServer } from './store.js'

/**
 * Uninstall of one McpServer with every cleanup BEFORE the CR delete.
 *
 * Why this order: the CR's `metadata.uid` is the only identity that fences the OAuth
 * teardown and the Secret cleanup against a same-name reinstall. While the CR is
 * alive a failed step can be retried with the same uid, and a reinstall through an
 * install route cannot create its CR (the name is taken), so it cannot race the
 * Context strip either. Deleting the CR first — the previous order — made every
 * cleanup failure permanent: the retry found no CR, hence no uid, hence no teardown.
 *
 *   1. read the CR → uid + Secret snapshots          (404 → `not_found`, nothing touched)
 *   2. strip the name from every Context allowlist   (→ `contexts`)
 *   3. OAuth teardown fenced by the uid              (→ `dynamic_client` | `oauth_grants`)
 *   4. delete the snapshotted Secrets                (→ `secrets`)
 *   5. delete the CR fenced by the uid               (→ `mcp_server`)
 *   6. second grants purge by the uid — sweeps a grant a consent callback sealed with
 *      this uid between 3 and 5; a failure only counts and logs, because readers
 *      fenced on the live CR uid already treat such a row as inert.
 *
 * The first failing step stops the run and is reported as `incomplete` with the CR
 * still present, so repeating the same request completes it. The result is transport
 * neutral: each route maps it to its own HTTP contract.
 */

export type McpServerUninstallStage =
  | 'contexts'
  | 'dynamic_client'
  | 'oauth_grants'
  | 'secrets'
  | 'mcp_server'

export type McpServerUninstallResult =
  | { status: 'not_found' }
  | { status: 'completed'; crUid: string; deleted: string[]; crDeleteResponse: unknown }
  | {
      status: 'incomplete'
      pending: McpServerUninstallStage[]
      deleted: string[]
      /** Per-resource reason, for callers that report it (registry `warnings`). */
      failures: UninstallFailure[]
    }

export interface UninstallFailure {
  /** `Kind/name`, same vocabulary as `deleted`. */
  resource: string
  message: string
}

export type UninstallGateway = Pick<
  K8sGateway,
  | 'getResource'
  | 'listResource'
  | 'updateResource'
  | 'deleteResource'
  | 'getSecret'
  | 'deleteSecret'
>

export interface McpServerUninstallDeps {
  gateway: UninstallGateway
  db: DbClient
  encryptionKey: Buffer
  dcrDeps: DcrDeps
  /** Contexts live in their own namespace, never in the McpServer's. */
  contextsNamespace: string
  logger: Logger
  /**
   * Awaited after each accepted K8s delete, before the step counts as done. The
   * apiserver accepts a delete before finalizers run; a caller that must not report
   * success until the object is gone (registry) blocks here.
   */
  awaitDeletion?: (target: {
    kind: 'McpServer' | 'Secret'
    name: string
    namespace: string
  }) => Promise<void>
}

/** Both dependent Secrets of an McpServer, in their fixed cleanup order. */
export async function captureMcpServerSecrets(
  gateway: Pick<K8sGateway, 'getSecret'>,
  name: string,
  namespace: string,
  logger: Logger
): Promise<SecretCleanupCapture[]> {
  return [
    await captureSecretForCleanup(gateway, `${name}-credentials`, namespace, logger),
    // Pre-registered confidential remote installs create this Secret before the CR,
    // with no ownerReferences, so K8s GC never reaps it.
    await captureSecretForCleanup(gateway, `${name}-oauth-client`, namespace, logger, {
      requireManagedOwnership: true,
    }),
  ]
}

/**
 * Deletes every `ready` capture, fenced on its snapshot. A 404 is already clean.
 * Returns the names deleted and whether any delete failed; never throws.
 */
export async function deleteCapturedSecrets(
  gateway: Pick<K8sGateway, 'deleteSecret'>,
  captures: SecretCleanupCapture[],
  namespace: string,
  logger: Logger,
  awaitDeletion?: McpServerUninstallDeps['awaitDeletion']
): Promise<{ deleted: string[]; failures: UninstallFailure[] }> {
  const deleted: string[] = []
  const failures: UninstallFailure[] = []
  for (const capture of captures) {
    if (capture.status !== 'ready') {
      if (capture.status !== 'absent') {
        logger.warn(
          { secretName: capture.name, namespace, reason: capture.status },
          'Skipped McpServer Secret cleanup'
        )
      }
      continue
    }
    try {
      await gateway.deleteSecret(capture.name, namespace, capture.precondition)
      await awaitDeletion?.({ kind: 'Secret', name: capture.name, namespace })
      deleted.push(`Secret/${capture.name}`)
      logger.info({ secretName: capture.name, namespace }, 'Deleted McpServer Secret')
    } catch (err) {
      if (extractK8sError(err)?.status === 404) {
        logger.info({ secretName: capture.name, namespace }, 'McpServer Secret already gone')
        continue
      }
      failures.push({
        resource: `Secret/${capture.name}`,
        message: k8sSafeFailureMessage(err, 'unable to verify deletion'),
      })
      mcpServerUninstallTeardownFailuresTotal.inc({
        stage: capture.name.endsWith('-oauth-client') ? 'oauth_client_secret' : 'secrets',
      })
      logger.error(
        { secretName: capture.name, namespace, err },
        'McpServer Secret cleanup failed on uninstall'
      )
    }
  }
  return { deleted, failures }
}

function readCrUid(cr: unknown): string | undefined {
  const uid = (cr as { metadata?: { uid?: unknown } } | null)?.metadata?.uid
  return typeof uid === 'string' && uid ? uid : undefined
}

export async function uninstallMcpServer(
  deps: McpServerUninstallDeps,
  target: { name: string; namespace: string }
): Promise<McpServerUninstallResult> {
  const { gateway, logger } = deps
  const { name, namespace } = target
  const deleted: string[] = []
  const incomplete = (
    stage: McpServerUninstallStage[],
    failures: UninstallFailure[]
  ): McpServerUninstallResult => ({ status: 'incomplete', pending: stage, deleted, failures })

  // 1 · CR identity + Secret snapshots.
  let cr: unknown
  try {
    cr = await gateway.getResource('mcpservers', name, namespace)
  } catch (err) {
    if (isNotFound(err)) return { status: 'not_found' }
    throw err
  }
  const crUid = readCrUid(cr)
  if (!crUid) {
    // Every cleanup below is fenced by this uid, so without it nothing can run safely.
    mcpServerUninstallTeardownFailuresTotal.inc({ stage: 'mcp_server' })
    logger.error(
      { serverName: name, namespace, reason: 'cr_uid_missing' },
      'McpServer read returned no metadata.uid; a real apiserver always sets it, so this ' +
        'points at a non-apiserver gateway or a broken proxy — retrying will not resolve it'
    )
    return incomplete(
      ['mcp_server'],
      [{ resource: `McpServer/${name}`, message: 'identity unavailable' }]
    )
  }
  const secretCaptures = await captureMcpServerSecrets(gateway, name, namespace, logger)
  // A Secret that cannot be read, or read without the uid/resourceVersion its delete
  // must be fenced on, would be orphaned once the CR is gone. Stop before any
  // mutation so the retry re-captures it.
  const unfenceable = secretCaptures.filter(
    c => c.status === 'read-failed' || c.status === 'identity-unavailable'
  )
  if (unfenceable.length > 0) {
    mcpServerUninstallTeardownFailuresTotal.inc({ stage: 'secrets' })
    return incomplete(
      ['secrets'],
      unfenceable.map(c => ({
        resource: `Secret/${c.name}`,
        message: c.status === 'read-failed' ? 'unable to verify identity' : 'identity unavailable',
      }))
    )
  }

  // 2 · Context allowlists.
  try {
    await stripServerFromContexts(gateway, deps.contextsNamespace, name, contextName => {
      deleted.push(`Context/${contextName} (removed from allowlist)`)
      logger.info({ serverName: name, contextName }, 'Removed MCP server from Context allowlist')
    })
  } catch (err) {
    mcpServerUninstallTeardownFailuresTotal.inc({ stage: 'contexts' })
    logger.error({ serverName: name, err }, 'Context allowlist cleanup failed on uninstall')
    return incomplete(
      ['contexts'],
      [
        {
          resource: 'Context allowlists',
          message: k8sSafeFailureMessage(err, 'unable to update safely'),
        },
      ]
    )
  }

  // 3 · OAuth state of THIS installation.
  const teardown = await teardownMcpServerOAuthState(
    deps.db,
    deps.encryptionKey,
    deps.dcrDeps,
    { namespace, name, crUid },
    logger
  )
  if (teardown.dynamicClient === 'done') deleted.push(`DynamicClient/${name}`)
  if (teardown.grants === 'done') deleted.push(`OAuthGrants/${name}`)
  const oauthPending: McpServerUninstallStage[] = []
  const oauthFailures: UninstallFailure[] = []
  if (teardown.dynamicClient === 'failed') {
    oauthPending.push('dynamic_client')
    oauthFailures.push({ resource: `DynamicClient/${name}`, message: 'revocation failed' })
  }
  if (teardown.grants === 'failed') {
    oauthPending.push('oauth_grants')
    oauthFailures.push({ resource: `OAuthGrants/${name}`, message: 'purge failed' })
  }
  if (oauthPending.length > 0) return incomplete(oauthPending, oauthFailures)

  // 4 · Secrets, fenced on the step-1 snapshots.
  const secrets = await deleteCapturedSecrets(
    gateway,
    secretCaptures,
    namespace,
    logger,
    deps.awaitDeletion
  )
  deleted.push(...secrets.deleted)
  if (secrets.failures.length > 0) return incomplete(['secrets'], secrets.failures)

  // 5 · The CR itself, fenced on the uid every cleanup above was bound to.
  let crDeleteResponse: unknown
  try {
    crDeleteResponse = await gateway.deleteResource('mcpservers', name, namespace, { uid: crUid })
    await deps.awaitDeletion?.({ kind: 'McpServer', name, namespace })
  } catch (err) {
    mcpServerUninstallTeardownFailuresTotal.inc({ stage: 'mcp_server' })
    logger.error({ serverName: name, namespace, err }, 'McpServer delete failed on uninstall')
    return incomplete(
      ['mcp_server'],
      [
        {
          resource: `McpServer/${name}`,
          message: k8sSafeFailureMessage(err, 'unable to verify deletion'),
        },
      ]
    )
  }
  deleted.push(`McpServer/${name}`)

  // 6 · Late-sealed grants of this uid.
  try {
    const purged = await deleteOAuthGrantsForServer(deps.db, {
      recipeNamespace: namespace,
      recipeName: name,
      crUid,
    })
    if (purged > 0) {
      logger.info(
        { serverName: name, namespace, count: purged },
        'Purged OAuth grants sealed after the uninstall teardown'
      )
    }
  } catch (err) {
    mcpServerUninstallTeardownFailuresTotal.inc({ stage: 'oauth_grants_post_delete' })
    logger.error(
      { serverName: name, namespace, err },
      'Post-delete OAuth grants purge failed on uninstall'
    )
  }

  return { status: 'completed', crUid, deleted, crDeleteResponse }
}
