import { config } from '../config.js'
import { pool, withTransaction } from '../db.js'
import type { DbClient } from '../db.js'
import {
  decryptOAuthSecret,
  deriveOAuthEncryptionKey,
  encryptOAuthSecret,
} from '../oauth/encryption.js'
import {
  invalidateRegistryIdentityCaches,
  isRegistryIdentityCacheGenerationCurrent,
  withCurrentRegistryIdentity,
} from './registryIdentityCache.js'

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

// Process-local cache with a bounded TTL: a control-api serves one deployment
// for its lifetime, so the decrypted row is stable — but the DERIVED auth state
// (isRegistryAuthActive) is an access-control input, and an unbounded cache
// would let a peer replica keep reporting auth-active forever after another
// replica disconnected. The TTL caps that window; writes here still evict
// immediately on the local process.
const CONNECTION_CACHE_TTL_MS = 15_000
let cached: RegistryConnectionRow | null | undefined
let cachedGeneration = -1
let cachedAt = 0

export function __resetRegistryConnectionCacheForTests(): void {
  cached = undefined
  cachedGeneration = -1
  cachedAt = 0
}

function encKey(): Buffer {
  return deriveOAuthEncryptionKey(config.oauthEncryptionKey)
}

export async function getRegistryConnection(
  db: DbClient = pool
): Promise<RegistryConnectionRow | null> {
  return withCurrentRegistryIdentity(async generation => {
    if (
      cached !== undefined &&
      cachedGeneration === generation &&
      Date.now() - cachedAt < CONNECTION_CACHE_TTL_MS
    ) {
      return cached
    }
    const res = await db.query(
      `SELECT deployment_id, key_id, public_key_pem, private_key_encrypted, client_id,
              client_secret_encrypted, org_name, requested_org_name, contact_email, status, registry_url
         FROM registry_connection
        ORDER BY created_at DESC
        LIMIT 1`
    )
    const raw = res.rows[0] as RawRow | undefined
    if (!raw) {
      if (isRegistryIdentityCacheGenerationCurrent(generation)) {
        cached = null
        cachedGeneration = generation
        cachedAt = Date.now()
      }
      return null
    }
    const key = encKey()
    const row = {
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
    if (isRegistryIdentityCacheGenerationCurrent(generation)) {
      cached = row
      cachedGeneration = generation
      cachedAt = Date.now()
    }
    return row
  })
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
    /** 'approved' marks a registry auto-approval whose claim has not landed yet. */
    status?: 'pending' | 'approved'
  },
  db?: DbClient
): Promise<void> {
  const encPriv = encryptOAuthSecret(encKey(), input.privateKeyPem)
  const status = input.status ?? 'pending'
  // Singleton table: replace any prior row. DELETE + INSERT must be ATOMIC —
  // a crash between them destroys the deployment keypair, which is the only
  // artifact that can recover an already-approved deployment (rotate is
  // PoP-gated). An explicit db means the caller already owns a transaction.
  const run = async (tx: DbClient): Promise<void> => {
    await tx.query(`DELETE FROM registry_connection`)
    await tx.query(
      `INSERT INTO registry_connection
         (deployment_id, key_id, public_key_pem, private_key_encrypted,
          requested_org_name, contact_email, status, registry_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.deploymentId,
        input.keyId,
        input.publicKeyPem,
        encPriv,
        input.requestedOrgName,
        input.contactEmail,
        status,
        input.registryUrl,
      ]
    )
  }
  if (db) await run(db)
  else await withTransaction(run)
  cached = undefined
  invalidateRegistryIdentityCaches()
}

export async function markConnected(
  input: { deploymentId: string; clientId: string; clientSecret: string; orgName: string },
  db: DbClient = pool
): Promise<boolean> {
  const encSecret = encryptOAuthSecret(encKey(), input.clientSecret)
  // Scoped to the deployment that actually claimed. Without the predicate a
  // DELETE or a second registration landing mid-claim would either silently
  // swallow the credentials or stamp THIS deployment's client secret onto a
  // DIFFERENT deployment's keypair — machine creds and voucher signing key
  // would then belong to two different deployments.
  const res = await db.query(
    `UPDATE registry_connection
        SET client_id = $1, client_secret_encrypted = $2, org_name = $3,
            status = 'connected', updated_at = now()
      WHERE deployment_id = $4 AND status <> 'connected'`,
    [input.clientId, encSecret, input.orgName, input.deploymentId]
  )
  cached = undefined
  const wrote = (res.rowCount ?? 0) > 0
  if (wrote) invalidateRegistryIdentityCaches()
  return wrote
}

export async function deleteConnection(db: DbClient = pool): Promise<void> {
  await db.query(`DELETE FROM registry_connection`)
  cached = undefined
  invalidateRegistryIdentityCaches()
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

/**
 * Registry auth is ACTIVE when this deployment actually holds usable machine
 * credentials.
 *
 * Self-hosted derives it from the claimed connection row, so connecting is the
 * only operator action — there is no env var to set and no restart. Managed
 * keeps CLERUM_REGISTRY_AUTH_ENABLED, because managed has no row (its creds
 * come from env).
 *
 * Note this checks CREDENTIALS, not row presence: a 'pending' row, and an
 * 'approved' row whose claim has not landed, both correctly report inactive.
 * That falls out of resolveMachineCreds, which null-checks clientId/clientSecret.
 */
export async function isRegistryAuthActive(): Promise<boolean> {
  if (config.registryConnectionMode === 'managed') return config.registryAuthEnabled
  return (await resolveMachineCreds()) !== null
}
