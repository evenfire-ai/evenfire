import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  type PendingGovernedEvent,
  type PendingGovernedEventBatch,
  TracingIdempotencyConflictError,
  TracingPersistenceInvariantError,
  appendGovernedEventBatchInTransaction,
} from '../src/services/tracing/append.js'

const NOW = '2026-07-10T10:00:00.000Z'

function administrativeEvent(
  index: number,
  overrides: Partial<PendingGovernedEvent<'administrative'>> = {}
): PendingGovernedEvent<'administrative'> {
  const suffix = String(index + 1).padStart(12, '0')
  return {
    family: 'administrative',
    eventId: `11111111-1111-4111-8111-${suffix}`,
    schemaVersion: 1,
    sourceService: 'control-api',
    sourceKind: 'control_api_local',
    sourceEventId: `source-${index}`,
    sourceIdentityColumn: 'source_event_id',
    occurredAt: NOW,
    ingestedAt: NOW,
    payloadSha256: String((index % 9) + 1).repeat(64),
    familyColumns: [
      { name: 'event_kind', value: 'configuration' },
      { name: 'action', value: 'configuration_change' },
      { name: 'outcome', value: 'committed' },
      { name: 'operator_sub', value: 'admin-1' },
      { name: 'service_sub', value: 'control-api' },
      { name: 'operation_id', value: null },
      { name: 'related_run_id', value: null },
      { name: 'request_id', value: `request-${index}` },
      { name: 'target_type', value: 'configuration' },
      { name: 'target_ref', value: 'control-api/settings' },
      { name: 'environment', value: 'test' },
      { name: 'team_id', value: null },
      { name: 'namespace', value: null },
      { name: 'source_audit_ref', value: `audit-${index}` },
      { name: 'payload_metadata', value: '{}' },
    ],
    stream: {
      environment: 'test',
      tenantId: null,
      teamId: null,
      runId: null,
      operationId: null,
      workloadRef: null,
    },
    ...overrides,
  }
}

function resultRow(event: PendingGovernedEvent, batchIndex: number, sequence: number) {
  return {
    batch_index: batchIndex,
    event_id: event.eventId,
    payload_sha256: event.payloadSha256,
    ingested_at: event.ingestedAt,
    stream_sequence: String(sequence),
  }
}

function batch(
  events: PendingGovernedEvent<'administrative'>[]
): PendingGovernedEventBatch<'administrative'> {
  return events as [
    PendingGovernedEvent<'administrative'>,
    ...PendingGovernedEvent<'administrative'>[],
  ]
}

describe('appendGovernedEventBatchInTransaction', () => {
  it('uses three query round trips for both 1 and 100 events and returns input order', async () => {
    const queryCounts: number[] = []

    for (const size of [1, 100]) {
      const events = Array.from({ length: size }, (_, index) =>
        administrativeEvent(index, { sourceEventId: `source-${size - index}` })
      )
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: size })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: events.map((event, index) => resultRow(event, index, index + 1)).reverse(),
          rowCount: size,
        })
      const db = { query } as DbClient

      const results = await appendGovernedEventBatchInTransaction(db, batch(events))

      queryCounts.push(query.mock.calls.length)
      expect(results.map(result => result.eventId)).toEqual(events.map(event => event.eventId))
      expect(results.every(result => result.kind === 'accepted')).toBe(true)

      const lockSql = String(query.mock.calls[0][0])
      const lockIdentities = query.mock.calls[0][1]?.[0] as string[]
      expect(lockSql).toContain('WITH ORDINALITY')
      expect(lockSql).toContain('ORDER BY lock_order')
      expect(lockIdentities).toEqual([...lockIdentities].sort())

      const lookupSql = String(query.mock.calls[1][0])
      expect(lookupSql).toContain('jsonb_to_recordset')
      const insertSql = String(query.mock.calls[2][0])
      expect(insertSql).toContain('WITH batch_values')
      expect(insertSql).toContain('INSERT INTO administrative_events')
      expect(insertSql).toContain('INSERT INTO governed_event_stream')
      expect(insertSql).toContain('JOIN inserted_stream s USING (event_id)')
    }

    expect(queryCounts).toEqual([3, 3])
  })

  it('maps accepted and persisted replay results back to input order', async () => {
    const events = [administrativeEvent(0), administrativeEvent(1), administrativeEvent(2)]
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [resultRow(events[1], 1, 20)], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [resultRow(events[2], 2, 22), resultRow(events[0], 0, 21)],
        rowCount: 2,
      })

    const results = await appendGovernedEventBatchInTransaction(
      { query } as DbClient,
      batch(events)
    )

    expect(results.map(result => [result.kind, result.eventId])).toEqual([
      ['accepted', events[0].eventId],
      ['replayed', events[1].eventId],
      ['accepted', events[2].eventId],
    ])
  })

  it('writes a same-identity same-payload duplicate once and replays later input positions', async () => {
    const first = administrativeEvent(0)
    const duplicate = administrativeEvent(1, {
      sourceEventId: first.sourceEventId,
      payloadSha256: first.payloadSha256,
    })
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [resultRow(first, 0, 30)], rowCount: 1 })

    const results = await appendGovernedEventBatchInTransaction(
      { query } as DbClient,
      batch([first, duplicate])
    )

    expect(results.map(result => [result.kind, result.eventId])).toEqual([
      ['accepted', first.eventId],
      ['replayed', first.eventId],
    ])
    expect(query.mock.calls[0][1]?.[0]).toHaveLength(1)
    expect(JSON.parse(String(query.mock.calls[1][1]?.[1]))).toHaveLength(1)
    expect(query.mock.calls[2][1]).toContain(first.eventId)
    expect(query.mock.calls[2][1]).not.toContain(duplicate.eventId)
  })

  it('rejects a same-identity different-payload duplicate before querying', async () => {
    const first = administrativeEvent(0)
    const conflicting = administrativeEvent(1, {
      sourceEventId: first.sourceEventId,
      payloadSha256: 'f'.repeat(64),
    })
    const query = vi.fn()

    await expect(
      appendGovernedEventBatchInTransaction({ query } as DbClient, batch([first, conflicting]))
    ).rejects.toBeInstanceOf(TracingIdempotencyConflictError)
    expect(query).not.toHaveBeenCalled()
  })

  it('fails the batch when an existing family row has no governed stream pointer', async () => {
    const event = administrativeEvent(0)
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...resultRow(event, 0, 40), stream_sequence: null }],
        rowCount: 1,
      })

    await expect(
      appendGovernedEventBatchInTransaction({ query } as DbClient, batch([event]))
    ).rejects.toBeInstanceOf(TracingPersistenceInvariantError)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('rejects a mixed-family batch before querying', async () => {
    const query = vi.fn()
    const administrative = administrativeEvent(0)
    const infrastructure = {
      ...administrative,
      family: 'infrastructure_telemetry' as const,
      sourceIdentityColumn: 'source_occurrence_id' as const,
    }

    await expect(
      appendGovernedEventBatchInTransaction(
        { query } as DbClient,
        [administrative, infrastructure] as unknown as PendingGovernedEventBatch<'administrative'>
      )
    ).rejects.toThrow('exactly one event family')
    expect(query).not.toHaveBeenCalled()
  })
})
