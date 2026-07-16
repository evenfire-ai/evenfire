import { config } from '../config.js'
import { pool } from '../db.js'
import type { DbClient } from '../db.js'
import {
  decryptOAuthSecret,
  deriveOAuthEncryptionKey,
  encryptOAuthSecret,
} from '../oauth/encryption.js'

/**
 * Thrown when no voucher signing key/kid is resolvable (route maps to 500
 * registry_voucher_unavailable). Authoritative home is here so
 * `resolveVoucherSigningMaterial` can throw it without importing
 * registryVoucher.ts (which would cycle). registryVoucher.ts re-exports it so
 * existing importers keep their path.
 */
export class VoucherUnavailableError extends Error {
  constructor() {
    super('registry_voucher_unavailable')
    this.name = 'VoucherUnavailableError'
  }
}

export interface RegistryConnectionRow {
  deploymentId: string
  keyId: string
  publicKeyPem: string
  privateKeyPem: string
  clientId: string | null
  clientSecret: string | null
  orgName: string | null
  requestedOrgName: string
  contactEmail: string
  status: 'pending' | 'approved' | 'connected'
  registryUrl: string | null
}

interface RawRow {
  deployment_id: string
  key_id: string
  public_key_pem: string
  private_key_encrypted: string
  client_id: string | null
  client_secret_encrypted: string | null
  org_name: string | null
  requested_org_name: string
  contact_email: string
  status: 'pending' | 'approved' | 'connected'
  registry_url: string | null
}

// Process-local cache: a control-api serves one deployment for its lifetime, so
// the decrypted row is stable. Evicted by any write here + the test reset.
// Caveat: eviction is process-local only — a post-connection DELETE/reconnect
// clears this cache on THIS replica alone, so a reconnect-in-place on a
// multi-replica deployment requires a rollout restart to evict peer replicas.
let cached: RegistryConnectionRow | null | undefined

export function __resetRegistryConnectionCacheForTests(): void {
  cached = undefined
}

function encKey(): Buffer {
  return deriveOAuthEncryptionKey(config.oauthEncryptionKey)
}

export async function getRegistryConnection(
  db: DbClient = pool
): Promise<RegistryConnectionRow | null> {
  if (cached !== undefined) return cached
  const res = await db.query(
    `SELECT deployment_id, key_id, public_key_pem, private_key_encrypted, client_id,
            client_secret_encrypted, org_name, requested_org_name, contact_email, status, registry_url
       FROM registry_connection
      ORDER BY created_at DESC
      LIMIT 1`
  )
  const raw = res.rows[0] as RawRow | undefined
  if (!raw) {
    cached = null
    return null
  }
  const key = encKey()
  cached = {
    deploymentId: raw.deployment_id,
    keyId: raw.key_id,
    publicKeyPem: raw.public_key_pem,
    privateKeyPem: decryptOAuthSecret(key, raw.private_key_encrypted),
    clientId: raw.client_id,
    clientSecret: raw.client_secret_encrypted
      ? decryptOAuthSecret(key, raw.client_secret_encrypted)
      : null,
    orgName: raw.org_name,
    requestedOrgName: raw.requested_org_name,
    contactEmail: raw.contact_email,
    status: raw.status,
    registryUrl: raw.registry_url,
  }
  return cached
}

export async function upsertPendingConnection(
  input: {
    deploymentId: string
    keyId: string
    publicKeyPem: string
    privateKeyPem: string
    requestedOrgName: string
    contactEmail: string
    registryUrl: string
  },
  db: DbClient = pool
): Promise<void> {
  const encPriv = encryptOAuthSecret(encKey(), input.privateKeyPem)
  // Singleton table: delete any prior row then insert. (A connect restart replaces
  // a stale pending row — the deployment keypair is regenerated fresh each request.)
  await db.query(`DELETE FROM registry_connection`)
  await db.query(
    `INSERT INTO registry_connection
       (deployment_id, key_id, public_key_pem, private_key_encrypted,
        requested_org_name, contact_email, status, registry_url)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
    [
      input.deploymentId,
      input.keyId,
      input.publicKeyPem,
      encPriv,
      input.requestedOrgName,
      input.contactEmail,
      input.registryUrl,
    ]
  )
  cached = undefined
}

export async function markConnected(
  input: { clientId: string; clientSecret: string; orgName: string },
  db: DbClient = pool
): Promise<void> {
  const encSecret = encryptOAuthSecret(encKey(), input.clientSecret)
  await db.query(
    `UPDATE registry_connection
        SET client_id = $1, client_secret_encrypted = $2, org_name = $3,
            status = 'connected', updated_at = now()`,
    [input.clientId, encSecret, input.orgName]
  )
  cached = undefined
}

export async function deleteConnection(db: DbClient = pool): Promise<void> {
  await db.query(`DELETE FROM registry_connection`)
  cached = undefined
}

/** Mode-aware voucher signing material (spec §14.2). */
export async function resolveVoucherSigningMaterial(): Promise<{
  signingKey: string
  kid: string
}> {
  if (config.registryConnectionMode === 'self-hosted') {
    const row = await getRegistryConnection()
    if (!row || !row.privateKeyPem || !row.keyId) throw new VoucherUnavailableError()
    return { signingKey: row.privateKeyPem, kid: row.keyId }
  }
  // managed
  if (!config.registryVoucherPrivateKey || !config.registryVoucherKid) {
    throw new VoucherUnavailableError()
  }
  return { signingKey: config.registryVoucherPrivateKey, kid: config.registryVoucherKid }
}

/** Mode-aware machine (client_credentials) creds (spec §8 registryClient). */
export async function resolveMachineCreds(): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  // NOTE: no `url` here — the registry base URL has a single source of truth
  // (config.registryUrl / registryClient's API_BASE), mandatory + allowlisted
  // when auth is on. A per-row URL override is out of scope (spec §14.3).
  if (config.registryConnectionMode === 'self-hosted') {
    const row = await getRegistryConnection()
    if (!row || !row.clientId || !row.clientSecret) return null
    return {
      clientId: row.clientId,
      clientSecret: row.clientSecret,
    }
  }
  if (!config.registryClientId || !config.registryClientSecret) return null
  return {
    clientId: config.registryClientId,
    clientSecret: config.registryClientSecret,
  }
}
