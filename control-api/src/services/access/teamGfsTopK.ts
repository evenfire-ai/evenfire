import { AccessBudgetExceededError } from './accessExecutionBudget.js'
import {
  type CatalogIdentityCandidate,
  type CatalogProducerPage,
  type CatalogRequestContext,
  type ProducerContinuation,
  catalogKey,
} from './catalogContracts.js'
import { CATALOG_KEY_SQL } from './catalogProducerSql.js'
import {
  CatalogProducerContractError,
  catalogQuery,
  listBoundedProducerKeys,
} from './catalogProducerSupport.js'

export type TeamGfsStreamKind = 'grant' | 'share'
export type TeamGfsStreamRequest = Readonly<{
  kind: TeamGfsStreamKind
  subjectId: string
  afterId: string
  take: number
}>
export type TeamGfsStreamHead = Readonly<{
  kind: TeamGfsStreamKind
  subjectId: string
  logicalId: string
  batchLast: boolean
}>

const TEAM_GFS_ADVANCE_CHUNK = 8

const TEAM_GFS_STREAM_HEAD_SQL = `WITH requested AS (
  SELECT stream.kind, stream.subject_id, stream.after_id, stream.take
    FROM jsonb_to_recordset($1::jsonb)
      AS stream(kind text, subject_id text, after_id uuid, take integer)
), heads AS (
  SELECT requested.kind, requested.subject_id, candidate.resource_id
    FROM (SELECT * FROM requested WHERE kind = 'grant') requested
   CROSS JOIN LATERAL (
     SELECT grant_row.resource_id
       FROM gfs_grants grant_row
 CROSS JOIN LATERAL (
         SELECT 1
           FROM gfs_resources resource
          WHERE resource.resource_id = grant_row.resource_id
            AND resource.drive = grant_row.drive AND resource.deleted_at IS NULL
          OFFSET 0
       ) live_resource
      WHERE grant_row.subject_type = 'team' AND grant_row.subject_id = requested.subject_id
        AND grant_row.resource_id > requested.after_id
      ORDER BY grant_row.resource_id
      LIMIT requested.take
   ) candidate
  UNION ALL
  SELECT requested.kind, requested.subject_id, candidate.resource_id
    FROM (SELECT * FROM requested WHERE kind = 'share') requested
   CROSS JOIN LATERAL (
     SELECT share.resource_id
       FROM gfs_shares share
 CROSS JOIN LATERAL (
         SELECT 1
           FROM gfs_resources resource
          WHERE resource.resource_id = share.resource_id
            AND resource.drive = share.drive AND resource.deleted_at IS NULL
          OFFSET 0
       ) live_resource
      WHERE share.subject_type = 'team' AND share.subject_id = requested.subject_id
        AND share.resource_id > requested.after_id
      ORDER BY share.resource_id
      LIMIT requested.take
   ) candidate
)
SELECT kind, subject_id, resource_id::text AS logical_id
  FROM heads
 ORDER BY logical_id, kind, subject_id`

function compareHead(left: TeamGfsStreamHead, right: TeamGfsStreamHead): number {
  return (
    left.logicalId.localeCompare(right.logicalId) ||
    left.kind.localeCompare(right.kind) ||
    left.subjectId.localeCompare(right.subjectId)
  )
}

class HeadHeap {
  private readonly values: TeamGfsStreamHead[] = []

  get size(): number {
    return this.values.length
  }

  peek(): TeamGfsStreamHead | undefined {
    return this.values[0]
  }

  push(value: TeamGfsStreamHead): void {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareHead(this.values[parent]!, value) <= 0) break
      this.values[index] = this.values[parent]!
      index = parent
    }
    this.values[index] = value
  }

  pop(): TeamGfsStreamHead | undefined {
    const first = this.values[0]
    const last = this.values.pop()
    if (!first || !last || this.values.length === 0) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      if (left >= this.values.length) break
      const child =
        right < this.values.length && compareHead(this.values[right]!, this.values[left]!) < 0
          ? right
          : left
      if (compareHead(last, this.values[child]!) <= 0) break
      this.values[index] = this.values[child]!
      index = child
    }
    this.values[index] = last
    return first
  }
}

function parseHeads(rows: readonly Record<string, unknown>[]): TeamGfsStreamHead[] {
  const parsed = rows.map(row => {
    const kind = row.kind
    const subjectId = row.subject_id
    const logicalId = row.logical_id
    if (
      (kind !== 'grant' && kind !== 'share') ||
      typeof subjectId !== 'string' ||
      !subjectId ||
      typeof logicalId !== 'string' ||
      !logicalId
    ) {
      throw new CatalogProducerContractError('team_gfs_stream_head_invalid')
    }
    return { kind: kind as TeamGfsStreamKind, subjectId, logicalId }
  })
  const lastByStream = new Map<string, string>()
  for (const head of parsed) lastByStream.set(`${head.kind}:${head.subjectId}`, head.logicalId)
  return parsed.map(head =>
    Object.freeze({
      ...head,
      batchLast: lastByStream.get(`${head.kind}:${head.subjectId}`) === head.logicalId,
    })
  )
}

async function readHeads(
  context: CatalogRequestContext,
  streams: readonly TeamGfsStreamRequest[]
): Promise<TeamGfsStreamHead[]> {
  if (streams.length === 0) return []
  const result = await catalogQuery(
    context.db,
    context.budget,
    TEAM_GFS_STREAM_HEAD_SQL,
    [
      JSON.stringify(
        streams.map(stream => ({
          kind: stream.kind,
          subject_id: stream.subjectId,
          after_id: stream.afterId,
          take: stream.take,
        }))
      ),
    ],
    { chargeProducer: false }
  )
  return parseHeads(result.rows as Record<string, unknown>[])
}

export async function collectTeamGfsTopK(input: {
  streams: readonly Omit<TeamGfsStreamRequest, 'take'>[]
  take: number
  read: (streams: readonly TeamGfsStreamRequest[]) => Promise<readonly TeamGfsStreamHead[]>
}): Promise<Readonly<{ logicalIds: readonly string[]; hasMore: boolean }>> {
  if (input.streams.length === 0) return { logicalIds: Object.freeze([]), hasMore: false }
  const streamCount = input.streams.length
  const initialTake = Math.max(
    1,
    Math.min(TEAM_GFS_ADVANCE_CHUNK, Math.ceil((input.take + 1) / streamCount) + 1)
  )
  const initialStreams = input.streams.map(stream => ({ ...stream, take: initialTake }))
  const heap = new HeadHeap()
  for (const head of await input.read(initialStreams)) heap.push(head)
  const logicalIds: string[] = []
  while (heap.size > 0 && logicalIds.length < input.take + 1) {
    const logicalId = heap.peek()!.logicalId
    const consumed: TeamGfsStreamHead[] = []
    while (heap.peek()?.logicalId === logicalId) consumed.push(heap.pop()!)
    logicalIds.push(logicalId)
    if (logicalIds.length < input.take + 1) {
      const advanced = await input.read(
        consumed
          .filter(head => head.batchLast)
          .map(head => ({
            kind: head.kind,
            subjectId: head.subjectId,
            afterId: logicalId,
            take: TEAM_GFS_ADVANCE_CHUNK,
          }))
      )
      for (const head of advanced) heap.push(head)
    }
  }
  return Object.freeze({ logicalIds: Object.freeze(logicalIds), hasMore: heap.size > 0 })
}

async function teamCandidates(input: {
  context: CatalogRequestContext
  after: string
  take: number
}): Promise<Readonly<{ candidates: readonly CatalogIdentityCandidate[]; hasMore: boolean }>> {
  const memberships = input.context.principal.memberships
  if (memberships.length === 0) return { candidates: Object.freeze([]), hasMore: false }
  const admission = input.context.budget.teamGfsMembershipAdmissionLimit
  if (admission === null || memberships.length > admission) {
    throw new AccessBudgetExceededError('teamGfsMembershipAdmission', true)
  }
  const streams = memberships.flatMap(membership =>
    (['grant', 'share'] as const).map(kind => ({
      kind,
      subjectId: membership.teamId,
      afterId: input.after || '00000000-0000-0000-0000-000000000000',
    }))
  )
  const merged = await collectTeamGfsTopK({
    streams,
    take: input.take,
    read: requested => readHeads(input.context, requested),
  })
  const candidates = merged.logicalIds.map(logicalId =>
    Object.freeze({
      key: catalogKey(input.context.environmentId, 'gfs_resource', logicalId),
      canonicalId: `gfs_resource:${logicalId}`,
      validUntil: null,
    })
  )
  return Object.freeze({ candidates: Object.freeze(candidates), hasMore: merged.hasMore })
}

function mergeCandidates(
  direct: readonly CatalogIdentityCandidate[],
  team: readonly CatalogIdentityCandidate[],
  take: number
): CatalogIdentityCandidate[] {
  const byId = new Map<string, CatalogIdentityCandidate>()
  for (const candidate of [...direct, ...team]) byId.set(candidate.key[2], candidate)
  return [...byId.values()]
    .sort((left, right) => left.key[2].localeCompare(right.key[2]))
    .slice(0, take + 1)
}

export async function listGfsProducerKeys(input: {
  context: CatalogRequestContext
  continuation: ProducerContinuation
  take: number
}): Promise<CatalogProducerPage> {
  const direct = await listBoundedProducerKeys({
    context: input.context,
    family: 'gfs_resource',
    requiredOperationalSources: [],
    continuation: input.continuation,
    take: input.take,
    sql: CATALOG_KEY_SQL.gfs_resource,
    extraValues: ['', '', ''],
  })
  if (direct.sourceCompleteness !== 'complete' || input.continuation.exhausted) return direct
  const after = input.continuation.afterKey?.[2] ?? ''
  const team = await teamCandidates({ context: input.context, after, take: input.take })
  const candidates = mergeCandidates(direct.candidates, team.candidates, input.take)
  const hasMore = direct.hasMore || team.hasMore || candidates.length > input.take
  return Object.freeze({
    candidates: Object.freeze(candidates),
    continuation: Object.freeze({
      afterKey: candidates.at(-1)?.key ?? input.continuation.afterKey,
      exhausted: !hasMore,
    }),
    hasMore,
    sourceRevision: direct.sourceRevision,
    sourceCompleteness: direct.sourceCompleteness,
    partialErrors: direct.partialErrors,
  })
}

export const teamGfsTopKSql = Object.freeze({ streamHead: TEAM_GFS_STREAM_HEAD_SQL })
