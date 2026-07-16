import { config } from '../config.js'
import { pool } from '../db.js'
import {
  decryptOAuthSecret,
  deriveOAuthEncryptionKey,
  encryptOAuthSecret,
} from '../oauth/encryption.js'

// Hosted-mode hub credentials (spec §8.2). Secrets are AES-256-GCM encrypted
// with the platform's existing envelope key — a Postgres dump yields nothing
// usable. Rotation is ops-level (revoke + blank); this module never deletes.
export interface MemberRegistrationCredential {
  boundDomain: string
  tenantId: string
  kid: string
  secret: string
}

interface RawRow {
  bound_domain: string
  tenant_id: string
  kid: string
  secret_encrypted: string
}

function encryptionKey(): Buffer {
  return deriveOAuthEncryptionKey(config.oauthEncryptionKey)
}

export async function getActiveMemberRegistrationCredential(
  domain: string
): Promise<MemberRegistrationCredential | null> {
  const result = await pool.query(
    `SELECT bound_domain, tenant_id, kid, secret_encrypted
       FROM member_registration_credentials
      WHERE bound_domain = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [domain]
  )
  const row = result.rows[0] as RawRow | undefined
  if (!row) return null
  let secret: string
  try {
    secret = decryptOAuthSecret(encryptionKey(), row.secret_encrypted)
  } catch {
    // Lost/rotated envelope key = "no credential" (spec §8.2 fails soft). Revoke
    // the dead row so it frees the partial-unique slot and the re-mint INSERT
    // can succeed; keep the row (blanked) as audit trail.
    await pool.query(
      `UPDATE member_registration_credentials
          SET revoked_at = NOW(), secret_encrypted = ''
        WHERE bound_domain = $1 AND revoked_at IS NULL`,
      [domain]
    )
    return null
  }
  return {
    boundDomain: row.bound_domain,
    tenantId: row.tenant_id,
    kid: row.kid,
    secret,
  }
}

export async function insertMemberRegistrationCredential(input: {
  boundDomain: string
  tenantId: string
  kid: string
  secret: string
}): Promise<{ inserted: boolean }> {
  const encrypted = encryptOAuthSecret(encryptionKey(), input.secret)
  const result = await pool.query(
    `INSERT INTO member_registration_credentials (bound_domain, tenant_id, kid, secret_encrypted)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bound_domain) WHERE revoked_at IS NULL DO NOTHING`,
    [input.boundDomain, input.tenantId, input.kid, encrypted]
  )
  return { inserted: (result.rowCount ?? 0) > 0 }
}
