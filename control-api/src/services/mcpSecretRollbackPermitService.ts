import { createHash, randomUUID } from 'node:crypto'
import { type DbClient, pool } from '../db.js'
import type { SecretPreconditions } from '../types.js'

export const MCP_SECRET_ROLLBACK_PERMIT_TTL_SECONDS = 120
export const MCP_SECRET_ROLLBACK_CLAIM_TTL_SECONDS = 15

export type McpSecretRollbackPermit = {
  sessionJti: string
  name: string
  namespace: string
  uid: string
  resourceVersion: string
}

export type McpSecretRollbackPermitLookup = Pick<
  McpSecretRollbackPermit,
  'sessionJti' | 'name' | 'namespace'
>

export type McpSecretRollbackPermitClaim = SecretPreconditions & {
  claimToken: string
}

export type McpSecretRollbackPermitClaimBinding = McpSecretRollbackPermitLookup & {
  claimToken: string
}

type QueryClient = Pick<DbClient, 'query'>

const SESSION_HASH_DOMAIN = 'mcp-secret-rollback-permit:v1:'

function requireField(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('invalid_mcp_secret_rollback_permit')
  return normalized
}

function sessionJtiHash(sessionJti: string): Buffer {
  return createHash('sha256')
    .update(SESSION_HASH_DOMAIN, 'utf8')
    .update(requireField(sessionJti), 'utf8')
    .digest()
}

export async function issueMcpSecretRollbackPermit(
  permit: McpSecretRollbackPermit,
  db: QueryClient = pool
): Promise<void> {
  const params = [
    sessionJtiHash(permit.sessionJti),
    requireField(permit.namespace),
    requireField(permit.name),
    requireField(permit.uid),
    requireField(permit.resourceVersion),
    MCP_SECRET_ROLLBACK_PERMIT_TTL_SECONDS,
  ]
  await db.query(`
    DELETE FROM mcp_secret_rollback_permits
     WHERE ctid IN (
       SELECT ctid
         FROM mcp_secret_rollback_permits
        WHERE expires_at <= statement_timestamp()
        ORDER BY expires_at
        LIMIT 100
     )
  `)
  await db.query(
    `INSERT INTO mcp_secret_rollback_permits
       (session_hash, namespace, name, uid, resource_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '1 second' * $6)
     ON CONFLICT (session_hash, namespace, name)
     DO UPDATE SET
       uid = EXCLUDED.uid,
       resource_version = EXCLUDED.resource_version,
       expires_at = EXCLUDED.expires_at,
       created_at = statement_timestamp()`,
    params
  )
}

export async function claimMcpSecretRollbackPermit(
  lookup: McpSecretRollbackPermitLookup,
  db: QueryClient = pool
): Promise<McpSecretRollbackPermitClaim | null> {
  const claimToken = randomUUID()
  const result = await db.query(
    `UPDATE mcp_secret_rollback_permits
        SET claim_token = $4::uuid,
            claim_expires_at = LEAST(
              expires_at,
              statement_timestamp() + interval '1 second' * $5
            )
      WHERE session_hash = $1
        AND namespace = $2
        AND name = $3
        AND expires_at > statement_timestamp()
        AND (claim_token IS NULL OR claim_expires_at <= statement_timestamp())
     RETURNING uid,
               resource_version AS "resourceVersion",
               claim_token::text AS "claimToken"`,
    [
      sessionJtiHash(lookup.sessionJti),
      requireField(lookup.namespace),
      requireField(lookup.name),
      claimToken,
      MCP_SECRET_ROLLBACK_CLAIM_TTL_SECONDS,
    ]
  )
  const row = result.rows[0] as
    | { uid?: unknown; resourceVersion?: unknown; claimToken?: unknown }
    | undefined
  if (
    typeof row?.uid !== 'string' ||
    typeof row.resourceVersion !== 'string' ||
    typeof row.claimToken !== 'string'
  ) {
    return null
  }
  return { uid: row.uid, resourceVersion: row.resourceVersion, claimToken: row.claimToken }
}

function claimBindingParams(binding: McpSecretRollbackPermitClaimBinding) {
  return [
    sessionJtiHash(binding.sessionJti),
    requireField(binding.namespace),
    requireField(binding.name),
    requireField(binding.claimToken),
  ]
}

export async function releaseMcpSecretRollbackPermitClaim(
  binding: McpSecretRollbackPermitClaimBinding,
  db: QueryClient = pool
): Promise<void> {
  await db.query(
    `UPDATE mcp_secret_rollback_permits
        SET claim_token = NULL,
            claim_expires_at = NULL
      WHERE session_hash = $1
        AND namespace = $2
        AND name = $3
        AND claim_token = $4::uuid`,
    claimBindingParams(binding)
  )
}

export async function finalizeMcpSecretRollbackPermitClaim(
  binding: McpSecretRollbackPermitClaimBinding,
  db: QueryClient = pool
): Promise<void> {
  await db.query(
    `DELETE FROM mcp_secret_rollback_permits
      WHERE session_hash = $1
        AND namespace = $2
        AND name = $3
        AND claim_token = $4::uuid`,
    claimBindingParams(binding)
  )
}
