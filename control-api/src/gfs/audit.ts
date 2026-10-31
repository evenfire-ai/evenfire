import { createHash } from 'node:crypto'

export interface GfsAuditDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>
}

/**
 * Append one INSERT-only audit row. Mirrors gfsc DbAuditSink content hashing;
 * the full prev_hash→row_hash chaining is completed in P4-S02, so prev_hash is
 * left null here (each row still carries a tamper-evident content row_hash).
 */
export async function auditMutation(
  db: GfsAuditDb,
  params: {
    actorKey: string
    targetKey: string
    op: string
    drive: string | null
    resourceId: string | null
    outcome: 'allowed' | 'denied'
    requestId?: string
    sourceIp?: string
    actorOnBehalfOf?: string | null
    desktopUserId?: string
    authoritySource?: 'user-session' | 'linked-admin'
  }
): Promise<string | null> {
  // A null resource (an event with no GFS resource yet) is stored as a NULL
  // gfs_uri, never as a drive-root URI.
  if (params.resourceId !== null && !params.drive)
    throw new Error('GFS audit resource requires a drive')
  const gfsUri = params.resourceId === null ? null : `gfs://${params.drive}/${params.resourceId}`
  const rowHash = createHash('sha256')
    .update(
      [
        params.targetKey,
        params.op,
        gfsUri ?? '',
        params.outcome,
        params.actorOnBehalfOf === undefined ? params.actorKey : (params.actorOnBehalfOf ?? ''),
        params.desktopUserId ?? '',
        params.authoritySource ?? '',
        params.requestId ?? '',
      ].join(' ')
    )
    .digest('hex')
  const result = await db.query(
    `INSERT INTO gfs_audit
       (subject, actor_on_behalf_of, op, gfs_uri, outcome, source_ip, request_id,
        row_hash, desktop_user_id, authority_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10)
     RETURNING sequence_no::text AS id`,
    [
      params.targetKey,
      params.actorOnBehalfOf === undefined ? params.actorKey : params.actorOnBehalfOf,
      params.op,
      gfsUri,
      params.outcome,
      params.sourceIp ?? null,
      params.requestId ?? null,
      rowHash,
      params.desktopUserId ?? null,
      params.authoritySource ?? null,
    ]
  )
  const row = result.rows[0] as { id?: unknown } | undefined
  return row?.id === null || row?.id === undefined ? null : String(row.id)
}
