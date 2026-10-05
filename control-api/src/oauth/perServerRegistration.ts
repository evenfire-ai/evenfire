import type { DbClient } from '../db.js'
import type { McpServerOAuthSubject } from './callback.js'
import { getDynamicClientBinding } from './dynamicClientStore.js'
import { buildRemoteRedirectUri, isValidInstallNonce } from './remoteCallback.js'

/**
 * How a per-server remote client is registered at its AS, which decides the shape of
 * its redirect URI: a DCR client registered `/remote/<serverName>/<installNonce>`, a
 * pre-registered one `/remote/<serverName>`.
 */
export type PerServerRegistration =
  | { mode: 'pre-registered' }
  | { mode: 'dcr'; installNonce: string }

/**
 * Resolve the registration of a per-server remote server, shared by the authorize-URL
 * mint and the callback so the URI sent to the AS and the one accepted back cannot
 * disagree.
 *
 * The mode comes from the CR, never from whether a `dynamic_clients` row exists: a CR
 * with both secret refs is pre-registered; anything else is DCR and must have a row.
 * Deriving it from the row would let a public CR without refs (written by GitOps, or
 * whose row was deleted) be treated as pre-registered and accept a nonce-less URI —
 * a public pre-registered client, which the per-server variant cannot protect because
 * its codes stay redeemable after a same-name reinstall.
 *
 * A DCR registration is only returned for a row bound to this very CR (`cr_uid`), with
 * a valid nonce and the CR's client id. A pending row, a legacy row without a nonce, or
 * a row of a previous installation of the same name yields null: consent fails closed.
 */
export async function resolvePerServerRegistration(
  db: DbClient,
  subject: Pick<McpServerOAuthSubject, 'namespace' | 'decl' | 'crUid'>,
  serverName: string
): Promise<PerServerRegistration | null> {
  if (subject.decl.secretSource?.kind === 'k8s-secret') return { mode: 'pre-registered' }
  if (subject.crUid === undefined) return null
  const row = await getDynamicClientBinding(db, {
    serverNamespace: subject.namespace,
    serverName,
  })
  if (!row || row.crUid !== subject.crUid || row.clientId !== subject.decl.id) return null
  if (!isValidInstallNonce(row.installId)) return null
  return { mode: 'dcr', installNonce: row.installId }
}

/** The per-server redirect URI of a resolved registration. Throws like its builder. */
export function buildPerServerRedirectUri(
  origin: string,
  serverName: string,
  registration: PerServerRegistration
): string {
  return registration.mode === 'dcr'
    ? buildRemoteRedirectUri({
        origin,
        variant: 'per-server',
        mode: 'dcr',
        serverName,
        installNonce: registration.installNonce,
      })
    : buildRemoteRedirectUri({ origin, variant: 'per-server', mode: 'pre-registered', serverName })
}
