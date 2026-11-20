import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { rootLogger } from '../src/observability/logger.js'
import {
  PR2_READINESS_CONTRACT_VERSION,
  PR2_READINESS_HOPS,
  PR2_RUNTIME_HOPS_BY_WRITER,
  type Pr2ReadinessTransactionRunner,
  parsePr2ReadinessActivationRecord,
  parsePr2ReadinessEvidence,
  requiredBuildEvidenceKinds,
  startControlApiPr2RuntimeEvidence,
  writePr2ReadinessEvidence,
} from '../src/services/access/pr2ReadinessEvidence.js'
import { READINESS_EVIDENCE_WRITE_LOCK_CLASS } from '../src/services/advisoryLockClasses.js'

const SHA = 'a'.repeat(40)

function runtimeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    environmentId: 'production.cluster-a',
    sourceRevision: SHA,
    hop: 'rpc_proxy_trusted_edge',
    evidenceClass: 'runtime',
    evidenceKind: 'service_runtime',
    writer: 'rpc-proxy',
    evidenceReference: `runtime:rpc-proxy:${SHA}`,
    outcome: 'passed',
    serviceVersion: '0.1.0',
    contractVersion: PR2_READINESS_CONTRACT_VERSION,
    deploymentRevision: 'deploy-1',
    imageRevision: SHA,
    observedAt: '2026-09-08T12:00:00.000Z',
    ...overrides,
  }
}

describe('PR2 readiness evidence contract', () => {
  it('keeps the owner-approved hop inventory closed and exact', () => {
    expect(PR2_READINESS_HOPS).toHaveLength(17)
    expect(new Set(PR2_READINESS_HOPS).size).toBe(17)
    expect(PR2_RUNTIME_HOPS_BY_WRITER['gfs-controller']).toEqual(['gfs_controller_checkpoint'])
    expect(PR2_RUNTIME_HOPS_BY_WRITER['workspace-files-controller']).toEqual([
      'workspace_files_controller_checkpoint',
    ])
  })

  it('binds a runtime report to the exact owning service and rejects siblings', () => {
    expect(parsePr2ReadinessEvidence(runtimeEvidence(), 'runtime', 'rpc-proxy').hop).toBe(
      'rpc_proxy_trusted_edge'
    )
    expect(() =>
      parsePr2ReadinessEvidence(runtimeEvidence({ writer: 'external-rest-api' }), 'runtime')
    ).toThrow('pr2_readiness_writer_forbidden')
    expect(() =>
      parsePr2ReadinessEvidence(runtimeEvidence({ evidenceClass: 'build' }), 'runtime')
    ).toThrow('pr2_readiness_writer_forbidden')
    expect(() => parsePr2ReadinessEvidence(runtimeEvidence({ hop: 'unknown' }), 'runtime')).toThrow(
      'pr2_readiness_evidence_invalid'
    )
  })

  it('requires an explicit bounded freshness input in the activation record', () => {
    expect(
      parsePr2ReadinessActivationRecord(
        JSON.stringify({
          version: 1,
          environmentId: 'production.cluster-a',
          sourceRevision: SHA,
          acceptedBy: 'release:task-106',
          acceptedAt: '2026-09-08T12:00:00.000Z',
          maxRuntimeEvidenceAgeSeconds: 30,
        })
      ).maxRuntimeEvidenceAgeSeconds
    ).toBe(30)
    expect(() =>
      parsePr2ReadinessActivationRecord(
        JSON.stringify({
          version: 1,
          environmentId: 'production.cluster-a',
          sourceRevision: SHA,
          acceptedBy: 'release:task-106',
          acceptedAt: '2026-09-08T12:00:00.000Z',
        })
      )
    ).toThrow('pr2_readiness_activation_invalid')
  })

  it('requires bounded typed evidence references instead of arbitrary URLs', () => {
    expect(() =>
      parsePr2ReadinessEvidence(runtimeEvidence({ evidenceReference: `service:${SHA}` }))
    ).toThrow('pr2_readiness_reference_kind_mismatch')
    expect(() =>
      parsePr2ReadinessEvidence({
        ...runtimeEvidence(),
        evidenceReference: 'runtime:rpc-proxy:https://ci.example.test/run/1',
      })
    ).toThrow('pr2_readiness_reference_invalid')
  })

  it('requires immutable CI, contract, static, deployment, and durable evidence by class', () => {
    expect(requiredBuildEvidenceKinds('rpc_proxy_trusted_edge')).toEqual([
      'exact_head_ci',
      'producer_contract',
      'static_analysis',
      'deployment_render',
    ])
    expect(requiredBuildEvidenceKinds('workflow_authority_bindings')).toContain('real_postgres')
    expect(requiredBuildEvidenceKinds('action_contracts')).not.toContain('deployment_render')
  })
})

type RecordedStatement = { text: string; values: unknown[] }

/** A transaction runner over a fake client that records every statement. */
function recordingRunner(statements: RecordedStatement[]): Pr2ReadinessTransactionRunner {
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      statements.push({ text, values })
      if (text.includes('FROM pr2_readiness_activations')) {
        return { rows: [{ source_revision: SHA, received_at: new Date() }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return async work => work(client as unknown as DbClient)
}

describe('PR2 readiness evidence writer advisory key (C12 A11 M1)', () => {
  it('serializes writers on a two-int4 key in the readiness evidence class', async () => {
    const statements: RecordedStatement[] = []
    const evidence = parsePr2ReadinessEvidence(runtimeEvidence(), 'runtime', 'rpc-proxy')

    await expect(writePr2ReadinessEvidence(evidence, recordingRunner(statements))).resolves.toBe(
      'inserted'
    )

    const advisory = statements.findIndex(statement =>
      statement.text.includes('pg_advisory_xact_lock')
    )
    const activation = statements.findIndex(statement =>
      statement.text.includes('FROM pr2_readiness_activations')
    )
    // Liveness: the writer read the activation row and inserted the evidence.
    expect(activation).toBe(0)
    expect(statements.at(-1)!.text).toContain('INSERT INTO pr2_readiness_evidence')
    expect(advisory).toBe(1)
    expect(statements[advisory]).toEqual({
      text: `SELECT pg_advisory_xact_lock($1::integer, hashtext($2 || ':' || $3 || ':' || $4 || ':' || $5))`,
      values: [
        READINESS_EVIDENCE_WRITE_LOCK_CLASS,
        'production.cluster-a',
        'rpc_proxy_trusted_edge',
        'runtime',
        'service_runtime',
      ],
    })
    expect(statements.filter(s => s.text.includes('pg_advisory'))).toHaveLength(1)
  })
})

describe('startControlApiPr2RuntimeEvidence fails loud (C12 P9)', () => {
  const activationRecord = JSON.stringify({
    version: 1,
    environmentId: 'production.cluster-a',
    sourceRevision: SHA,
    acceptedBy: 'release:task-106',
    acceptedAt: '2026-09-08T12:00:00.000Z',
    maxRuntimeEvidenceAgeSeconds: 30,
  })
  const configured = {
    CONTROL_API_PR2_READINESS_ACTIVATION_RECORD: activationRecord,
    EVENFIRE_SOURCE_REVISION: SHA,
    EVENFIRE_SERVICE_VERSION: '1.2.3',
    EVENFIRE_DEPLOYMENT_REVISION: 'deploy-1',
    EVENFIRE_IMAGE_REVISION: SHA,
  }
  let info: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  const stops: Array<() => void> = []

  beforeEach(() => {
    info = vi.spyOn(rootLogger, 'info').mockImplementation(() => undefined as never)
    error = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    info.mockRestore()
    error.mockRestore()
  })

  it('logs not configured and writes nothing without an activation record', () => {
    const runner = vi.fn()

    stops.push(startControlApiPr2RuntimeEvidence({}, runner as never))

    expect(info).toHaveBeenCalledExactlyOnceWith(
      { event: 'pr2_runtime_evidence_not_configured' },
      'PR2 runtime evidence is not configured'
    )
    expect(runner).not.toHaveBeenCalled()
  })

  it.each([
    [
      'pr2_runtime_evidence_source_revision_invalid',
      { EVENFIRE_SOURCE_REVISION: 'not-a-revision' },
    ],
    ['pr2_runtime_evidence_service_version_missing', { EVENFIRE_SERVICE_VERSION: ' ' }],
    [
      'pr2_runtime_evidence_activation_revision_mismatch',
      { EVENFIRE_SOURCE_REVISION: 'b'.repeat(40), EVENFIRE_IMAGE_REVISION: 'b'.repeat(40) },
    ],
    ['pr2_runtime_evidence_deployment_revision_missing', { EVENFIRE_DEPLOYMENT_REVISION: '' }],
    ['pr2_runtime_evidence_image_revision_mismatch', { EVENFIRE_IMAGE_REVISION: 'c'.repeat(40) }],
    ['pr2_readiness_activation_invalid', { CONTROL_API_PR2_READINESS_ACTIVATION_RECORD: '{}' }],
  ])('stops startup with %s when the activation record is present', (code, overrides) => {
    const runner = vi.fn()

    expect(() =>
      startControlApiPr2RuntimeEvidence({ ...configured, ...overrides }, runner as never)
    ).toThrow(code)

    expect(runner).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it('logs each failed hop write and keeps reporting', async () => {
    const hops = PR2_RUNTIME_HOPS_BY_WRITER['control-api']
    const runner = vi.fn(async () => {
      throw new Error('pr2_readiness_source_inactive')
    })

    stops.push(startControlApiPr2RuntimeEvidence(configured, runner as never))

    // Witness: every hop was attempted, and each failure was logged once.
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(hops.length))
    expect(runner).toHaveBeenCalledTimes(hops.length)
    expect(error.mock.calls).toEqual(
      hops.map(hop => [
        {
          event: 'pr2_runtime_evidence_write_failed',
          hop,
          errorName: 'Error',
          reason: 'pr2_readiness_source_inactive',
        },
        'PR2 runtime evidence write failed',
      ])
    )
  })

  it('logs a SQLSTATE without the message text', async () => {
    const hops = PR2_RUNTIME_HOPS_BY_WRITER['control-api']
    const runner = vi.fn(async () => {
      throw Object.assign(new Error('could not serialize access for row "secret"'), {
        code: '40001',
      })
    })

    stops.push(startControlApiPr2RuntimeEvidence(configured, runner as never))

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(hops.length))
    expect(error.mock.calls[0]).toEqual([
      {
        event: 'pr2_runtime_evidence_write_failed',
        hop: hops[0],
        errorName: 'Error',
        errorCode: '40001',
      },
      'PR2 runtime evidence write failed',
    ])
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret')
  })
})
