import type { Database } from 'better-sqlite3'
import { typedColumnProjection } from './inspectCandidate'
import { CanonicalStoreError, LIMITS } from './types'

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`
const derived = new Set(['message_count', 'turn_count', 'last_activity_at'])
function incomplete(): never {
  throw new CanonicalStoreError(
    'CandidateIncomplete',
    'Recovery cannot prove preservation of accepted writes'
  )
}
function value(value: unknown): string {
  if (typeof value === 'bigint') return `integer:${value}`
  if (Buffer.isBuffer(value)) return `blob:${value.toString('base64')}`
  if (typeof value === 'number' && Object.is(value, -0)) return 'real:-0'
  return `${typeof value}:${JSON.stringify(value)}`
}
function equal(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  names: string[],
  skipDerived = false
): boolean {
  return names.every(
    (name, index) =>
      (skipDerived && derived.has(name)) ||
      (value(left[`type_${index}`]) === value(right[`type_${index}`]) &&
        value(left[`value_${index}`]) === value(right[`value_${index}`]))
  )
}
function cell(row: Record<string, unknown>, names: string[], name: string): unknown {
  return row[`value_${names.indexOf(name)}`]
}
interface Summary {
  message_count: bigint
  turn_count: bigint
  last_message: number | null
}
/** Matches recomputeSessionMessageSummary and the max-watermark insert path in the persistence statements.
 * Counter dispatch can increment the current summary explicitly, so only the prepared candidate is recomputed. */
function summaryQuery(candidate: Database) {
  return candidate
    .prepare(
      `SELECT
    COUNT(CASE WHEN role='user' OR (role='assistant' AND tool_calls IS NULL) THEN 1 END) AS message_count,
    COUNT(DISTINCT turn_number) AS turn_count,MAX(timestamp) AS last_message
    FROM messages WHERE session_id=?`
    )
    .safeIntegers(true)
}
function validateSummary(
  row: Record<string, unknown>,
  names: string[],
  summary: Summary,
  current?: Record<string, unknown>
): void {
  if (
    cell(row, names, 'message_count') !== summary.message_count ||
    cell(row, names, 'turn_count') !== summary.turn_count
  )
    incomplete()
  const started = cell(row, names, 'started_at')
  const last = cell(row, names, 'last_activity_at')
  const currentLast = current
    ? (cell(current, names, 'last_activity_at') ?? cell(current, names, 'started_at'))
    : started
  if (
    typeof started !== 'number' ||
    !Number.isFinite(started) ||
    typeof last !== 'number' ||
    !Number.isFinite(last) ||
    typeof currentLast !== 'number' ||
    !Number.isFinite(currentLast) ||
    (summary.last_message !== null &&
      (typeof summary.last_message !== 'number' || !Number.isFinite(summary.last_message))) ||
    last !== Math.max(started, currentLast, summary.last_message ?? started)
  )
    incomplete()
}
/** Verify every authoritative current field, exact approvals and monotonic integer sequence state.
 * Only the three source-proven derived session summaries may differ, and only after full candidate-message verification. */
export function validateRecoveryContinuity(
  current: Database,
  candidate: Database,
  deadline = Date.now() + LIMITS.timeoutMs
): void {
  const summaries = summaryQuery(candidate)
  for (const table of ['sessions', 'messages', 'pending_approvals']) {
    const columns = current.pragma(`table_info(${quote(table)})`) as Array<{
      name: string
      pk: number
    }>
    const names = columns.map(column => column.name)
    const keys = columns
      .filter(column => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(column => column.name)
    if (keys.length === 0) incomplete()
    const projection = typedColumnProjection(names)
    const rows = current
      .prepare(
        `SELECT ${projection},${keys.map((key, index) => `${quote(key)} AS key_${index}`).join(',')}
      FROM ${quote(table)} ORDER BY ${keys.map(quote).join(',')}`
      )
      .safeIntegers(true)
    const lookup = candidate
      .prepare(
        `SELECT ${projection} FROM ${quote(table)} WHERE ${keys.map(key => `${quote(key)}=?`).join(' AND ')}`
      )
      .safeIntegers(true)
    let count = 0
    for (const row of rows.iterate() as Iterable<Record<string, unknown>>) {
      if (Date.now() > deadline) throw new CanonicalStoreError('ManifestTooLarge')
      const found = lookup.get(...keys.map((_key, index) => row[`key_${index}`])) as
        | Record<string, unknown>
        | undefined
      if (!found || !equal(row, found, names, table === 'sessions')) incomplete()
      if (table === 'sessions')
        validateSummary(found, names, summaries.get(row.key_0) as Summary, row)
      count++
    }
    if (
      table === 'pending_approvals' &&
      (
        candidate.prepare('SELECT count(*) AS count FROM pending_approvals').get() as {
          count: number
        }
      ).count !== count
    )
      incomplete()
    if (table === 'sessions') {
      const currentSession = current
        .prepare(`SELECT ${projection} FROM sessions WHERE id=?`)
        .safeIntegers(true)
      const all = candidate
        .prepare(`SELECT ${projection},id AS key_0 FROM sessions ORDER BY id`)
        .safeIntegers(true)
      for (const row of all.iterate() as Iterable<Record<string, unknown>>) {
        if (Date.now() > deadline) throw new CanonicalStoreError('ManifestTooLarge')
        if (!currentSession.get(row.key_0))
          validateSummary(row, names, summaries.get(row.key_0) as Summary)
      }
    }
  }
  const rows = current
    .prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name')
    .safeIntegers(true)
  const lookup = candidate
    .prepare('SELECT seq FROM sqlite_sequence WHERE name=?')
    .safeIntegers(true)
  for (const row of rows.iterate() as Iterable<{ name: string; seq: bigint }>) {
    const found = lookup.get(row.name) as { seq: bigint } | undefined
    if (
      !found ||
      typeof row.seq !== 'bigint' ||
      typeof found.seq !== 'bigint' ||
      found.seq < row.seq
    )
      incomplete()
  }
}
