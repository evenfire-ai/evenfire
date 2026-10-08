import { describe, expect, it } from 'vitest'
import {
  LEGACY_DISCARD_COUNTER,
  downloadedRecord,
  legacyLease,
  legacyLeaseRecoveryVerdict,
  parseMetricValue,
  parseSeedSummary,
  requireLegacyLeaseLaneEnv,
  vacuityStoreVerdict,
} from './e2e-playwright/helpers/legacyLeaseRestart'

const PROFILE = 'clerum-fix-issue-1022-processing-lease-lifecycle-2e0feeb9'
const RUN_ID = 'image-capabilities-0123456789ab'
const SHA = 'a'.repeat(64)

const discardLine = JSON.stringify({
  level: 40,
  component: 'GfsDownloadStore',
  discarded: 1,
  msg: 'GFS download store discarded 1 legacy processing lease(s) at initialize',
})
const unknownLine = JSON.stringify({
  level: 40,
  component: 'GfsDownloadStore',
  legacyProcessingLeases: 1,
  outcome: 'unknown',
  msg: 'GFS download store could not confirm the discard of 1 legacy processing lease(s)',
})
const unrelatedLine = JSON.stringify({ level: 30, component: 'Server', msg: 'listening' })

describe('requireLegacyLeaseLaneEnv', () => {
  const valid = {
    MINIKUBE_PROFILE: PROFILE,
    CONTROL_API_REAL_PG_CONTEXT: PROFILE,
    E2E_K8S_CONTEXT: PROFILE,
    LEGACY_LEASE_LANE_MODE: 'fixed',
    LEGACY_LEASE_SEED_LABEL_VALUE: RUN_ID,
    IMAGE_CAPABILITIES_RUN_ID: RUN_ID,
  }

  it('accepts the runner bindings', () => {
    expect(requireLegacyLeaseLaneEnv(valid)).toEqual({
      profile: PROFILE,
      mode: 'fixed',
      runId: RUN_ID,
    })
  })

  it('lists every inconsistent binding at once', () => {
    let message = ''
    try {
      requireLegacyLeaseLaneEnv({
        ...valid,
        E2E_K8S_CONTEXT: 'minikube',
        LEGACY_LEASE_LANE_MODE: 'skip',
        LEGACY_LEASE_SEED_LABEL_VALUE: 'image-capabilities-ffffffffffff',
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('E2E_K8S_CONTEXT')
    expect(message).toContain('LEGACY_LEASE_LANE_MODE')
    expect(message).toContain('LEGACY_LEASE_SEED_LABEL_VALUE')
  })
})

describe('legacyLease', () => {
  it('is a valid, unexpired, foreign lease with no records and no writer session', () => {
    const now = Date.parse('2026-10-08T10:00:00.000Z')
    const lease = legacyLease(now)
    expect(lease.leaseId).toMatch(/^[0-9a-f-]{36}$/)
    expect(lease.recordIds).toEqual([])
    expect(lease.callerIdentity).not.toBe('')
    expect(Date.parse(lease.expiresAt)).toBeGreaterThan(now)
    expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.parse(lease.acquiredAt))
    expect(Object.hasOwn(lease, 'writerSessionId')).toBe(false)
  })
})

describe('parseSeedSummary', () => {
  const summary = (fields: Record<string, unknown>) =>
    `LEGACY_LEASE_SEED ${JSON.stringify({ leaseId: 'l1', records: 0, mode: '600', uid: 1001, gid: 1001, ...fields })}\n`

  it('reads the one summary of the seeded lease', () => {
    expect(parseSeedSummary(summary({}), 'l1').records).toBe(0)
  })

  it('refuses a ledger left with another mode or owner', () => {
    expect(() => parseSeedSummary(summary({ mode: '644' }), 'l1')).toThrow(/mode 644/)
    expect(() => parseSeedSummary(summary({ uid: 0 }), 'l1')).toThrow(/owner 0:1001/)
  })

  it('refuses no summary, two summaries, or another lease', () => {
    expect(() => parseSeedSummary('', 'l1')).toThrow(/0 summaries/)
    expect(() => parseSeedSummary(summary({}) + summary({}), 'l1')).toThrow(/2 summaries/)
    expect(() => parseSeedSummary(summary({}), 'l2')).toThrow(/another lease/)
  })
})

describe('parseMetricValue', () => {
  const exposition = [
    `# HELP ${LEGACY_DISCARD_COUNTER} Legacy processing leases discarded.`,
    `# TYPE ${LEGACY_DISCARD_COUNTER} counter`,
    `${LEGACY_DISCARD_COUNTER} 1`,
    'process_cpu_seconds_total 3.2',
  ].join('\n')

  it('reads an unlabelled sample', () => {
    expect(parseMetricValue(exposition, LEGACY_DISCARD_COUNTER)).toBe(1)
  })

  it('returns null when the metric is absent', () => {
    expect(parseMetricValue('process_cpu_seconds_total 3.2\n', LEGACY_DISCARD_COUNTER)).toBeNull()
  })

  it('refuses duplicate or labelled samples', () => {
    expect(() =>
      parseMetricValue(`${exposition}\n${LEGACY_DISCARD_COUNTER} 2`, LEGACY_DISCARD_COUNTER)
    ).toThrow(/2 samples/)
    expect(() =>
      parseMetricValue(`${LEGACY_DISCARD_COUNTER}{a="b"} 1`, LEGACY_DISCARD_COUNTER)
    ).toThrow(/not an unlabelled number/)
  })
})

describe('legacyLeaseRecoveryVerdict', () => {
  const ledger = { schemaVersion: 1, records: {} }

  it('accepts one confirmed discard with the counter at 1', () => {
    expect(
      legacyLeaseRecoveryVerdict({ ledger, logLines: [unrelatedLine, discardLine], counter: 1 })
    ).toBe('discarded')
  })

  it('accepts one unknown-outcome warning with the counter at 0', () => {
    expect(legacyLeaseRecoveryVerdict({ ledger, logLines: [unknownLine], counter: 0 })).toBe(
      'unknown-outcome'
    )
  })

  it('refuses a ledger that still carries processingLeases', () => {
    expect(() =>
      legacyLeaseRecoveryVerdict({
        ledger: { ...ledger, processingLeases: {} },
        logLines: [discardLine],
        counter: 1,
      })
    ).toThrow(/still carries processingLeases/)
  })

  it('refuses when no outcome was logged (the Host never ran the discard)', () => {
    expect(() =>
      legacyLeaseRecoveryVerdict({ ledger, logLines: [unrelatedLine], counter: 0 })
    ).toThrow(/0 discard line\(s\).*0 unknown-outcome/)
  })

  it('refuses a discard whose counter disagrees, and a missing counter', () => {
    expect(() =>
      legacyLeaseRecoveryVerdict({ ledger, logLines: [discardLine], counter: 0 })
    ).toThrow(/counter 0/)
    expect(() =>
      legacyLeaseRecoveryVerdict({ ledger, logLines: [discardLine], counter: null })
    ).toThrow(/not exposed/)
  })

  it('refuses both outcomes at once, and a discard of more than one lease', () => {
    expect(() =>
      legacyLeaseRecoveryVerdict({ ledger, logLines: [discardLine, unknownLine], counter: 1 })
    ).toThrow(/no recovery outcome/)
    const two = discardLine.replace('"discarded":1', '"discarded":2')
    expect(() => legacyLeaseRecoveryVerdict({ ledger, logLines: [two], counter: 2 })).toThrow(
      /no recovery outcome/
    )
  })
})

describe('vacuityStoreVerdict', () => {
  const ledger = { schemaVersion: 1, records: {}, processingLeases: { l1: {} } }

  it('accepts the pre-fix Host keeping the lease without a counter', () => {
    expect(
      vacuityStoreVerdict({ ledger, logLines: [unrelatedLine], counter: null, leaseId: 'l1' })
    ).toBe('lease-retained')
  })

  it('refuses a discarded lease, a discard line, or an exposed counter', () => {
    expect(() =>
      vacuityStoreVerdict({
        ledger: { schemaVersion: 1, records: {} },
        logLines: [],
        counter: null,
        leaseId: 'l1',
      })
    ).toThrow(/no longer carries/)
    expect(() =>
      vacuityStoreVerdict({ ledger, logLines: [discardLine], counter: null, leaseId: 'l1' })
    ).toThrow(/logged a legacy-lease discard/)
    expect(() => vacuityStoreVerdict({ ledger, logLines: [], counter: 0, leaseId: 'l1' })).toThrow(
      /exposes/
    )
  })
})

describe('downloadedRecord', () => {
  const record = (id: string, fields: Record<string, unknown>) => ({
    id,
    hostPath: `downloads/${id}`,
    sizeBytes: 10,
    sha256: SHA,
    state: 'completed',
    ...fields,
  })
  const before = { schemaVersion: 1, records: { old: record('old', {}) } }

  it('returns the one new completed record with the source digest and size', () => {
    const after = { schemaVersion: 1, records: { ...before.records, fresh: record('fresh', {}) } }
    expect(downloadedRecord(before, after, { sha256: SHA, bytes: 10 }).id).toBe('fresh')
  })

  it('refuses no new record, a different digest, or an unfinished transfer', () => {
    expect(() => downloadedRecord(before, before, { sha256: SHA, bytes: 10 })).toThrow(/added \[\]/)
    const other = {
      schemaVersion: 1,
      records: { fresh: record('fresh', { sha256: 'b'.repeat(64) }) },
    }
    expect(() => downloadedRecord(before, other, { sha256: SHA, bytes: 10 })).toThrow(
      /expected one/
    )
    const partial = {
      schemaVersion: 1,
      records: { fresh: record('fresh', { state: 'transferring' }) },
    }
    expect(() => downloadedRecord(before, partial, { sha256: SHA, bytes: 10 })).toThrow(
      /expected one/
    )
  })
})
