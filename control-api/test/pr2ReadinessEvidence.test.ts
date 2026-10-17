import { describe, expect, it } from 'vitest'
import {
  PR2_READINESS_CONTRACT_VERSION,
  PR2_READINESS_HOPS,
  PR2_RUNTIME_HOPS_BY_WRITER,
  parsePr2ReadinessActivationRecord,
  parsePr2ReadinessEvidence,
  requiredBuildEvidenceKinds,
} from '../src/services/access/pr2ReadinessEvidence.js'

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
