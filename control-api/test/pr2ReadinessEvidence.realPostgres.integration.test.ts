import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import {
  PR2_READINESS_CONTRACT_VERSION,
  PR2_READINESS_HOPS,
  PR2_RUNTIME_HOPS_BY_WRITER,
  type Pr2ReadinessHop,
  type Pr2ReadinessTransactionRunner,
  type Pr2ReadinessWriter,
  activatePr2ReadinessSource,
  assemblePr2Readiness,
  importPr2BuildEvidence,
  requiredBuildEvidenceKinds,
  writePr2ReadinessEvidence,
} from '../src/services/access/pr2ReadinessEvidence.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const SHA = 'a'.repeat(40)

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('PR2 readiness evidence on real PostgreSQL', () => {
  const database = `control_api_pr2_readiness_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let databasePool: Pool
  let acceptedAt: Date

  const transaction: Pr2ReadinessTransactionRunner = async work => {
    const client = await databasePool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client as DbClient)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    await initDb({ connect: () => databasePool.connect() })
    acceptedAt = new Date(Date.now() - 1_000)
    await activatePr2ReadinessSource(databasePool, {
      environmentId: 'test.cluster',
      sourceRevision: SHA,
      acceptedBy: 'test:operator',
      acceptedAt,
      maxRuntimeEvidenceAgeSeconds: 60,
    })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.end()
    }
  })

  function runtimeOwner(hop: Pr2ReadinessHop): Pr2ReadinessWriter {
    for (const [writer, hops] of Object.entries(PR2_RUNTIME_HOPS_BY_WRITER)) {
      if (hops.includes(hop)) return writer as Pr2ReadinessWriter
    }
    throw new Error(`missing runtime owner for ${hop}`)
  }

  async function writeCompleteHop(hop: Pr2ReadinessHop, observedAt: Date): Promise<void> {
    const writer = runtimeOwner(hop)
    const deploymentRevision = hop === 'action_contracts' ? null : 'deploy-a'
    for (const kind of requiredBuildEvidenceKinds(hop)) {
      await writePr2ReadinessEvidence(
        {
          environmentId: 'test.cluster',
          sourceRevision: SHA,
          hop,
          evidenceClass: 'build',
          evidenceKind: kind,
          writer: 'operator-build-importer',
          evidenceReference: `${kind}:${hop}:${SHA}`,
          outcome: 'passed',
          serviceVersion: '1.2.3',
          contractVersion: PR2_READINESS_CONTRACT_VERSION,
          deploymentRevision,
          imageRevision: SHA,
          observedAt,
        },
        transaction
      )
    }
    await writePr2ReadinessEvidence(
      {
        environmentId: 'test.cluster',
        sourceRevision: SHA,
        hop,
        evidenceClass: 'runtime',
        evidenceKind: 'service_runtime',
        writer,
        evidenceReference: `runtime:${writer}:${hop}:${SHA}`,
        outcome: 'passed',
        serviceVersion: '1.2.3',
        contractVersion: PR2_READINESS_CONTRACT_VERSION,
        deploymentRevision,
        imageRevision: SHA,
        observedAt,
      },
      transaction
    )
  }

  it('requires both classes for all 17 hops and invalidates atomically', async () => {
    const now = new Date()
    expect(
      Object.values(await assemblePr2Readiness(databasePool, 'test.cluster', now, SHA))
    ).not.toContain('ready')
    for (const hop of PR2_READINESS_HOPS) await writeCompleteHop(hop, new Date())
    expect(
      Object.values(await assemblePr2Readiness(databasePool, 'test.cluster', undefined, SHA))
    ).toEqual(Array(17).fill('ready'))

    expect(
      Object.values(
        await assemblePr2Readiness(databasePool, 'test.cluster', undefined, 'b'.repeat(40))
      )
    ).toEqual(Array(17).fill('unavailable'))

    const hop = 'mcp_host_live_effects' as const
    const writer = runtimeOwner(hop)
    const withdrawnAt = new Date('2026-09-08T12:00:21.000Z')
    await writePr2ReadinessEvidence(
      {
        environmentId: 'test.cluster',
        sourceRevision: SHA,
        hop,
        evidenceClass: 'runtime',
        evidenceKind: 'service_runtime',
        writer,
        evidenceReference: `runtime:${writer}:${hop}:${SHA}`,
        outcome: 'passed',
        serviceVersion: '1.2.3',
        contractVersion: PR2_READINESS_CONTRACT_VERSION,
        deploymentRevision: 'deploy-a',
        imageRevision: SHA,
        observedAt: new Date('2099-09-08T12:00:20.000Z'),
      },
      transaction
    )
    await writePr2ReadinessEvidence(
      {
        environmentId: 'test.cluster',
        sourceRevision: SHA,
        hop,
        evidenceClass: 'runtime',
        evidenceKind: 'service_runtime',
        writer,
        evidenceReference: `withdrawal:${writer}:${hop}:${SHA}`,
        outcome: 'withdrawn',
        serviceVersion: '1.2.3',
        contractVersion: PR2_READINESS_CONTRACT_VERSION,
        deploymentRevision: 'deploy-a',
        imageRevision: SHA,
        observedAt: withdrawnAt,
      },
      transaction
    )
    expect((await assemblePr2Readiness(databasePool, 'test.cluster', undefined, SHA))[hop]).toBe(
      'unavailable'
    )
  })

  it('expires and restores one required runtime hop at the configured max age', async () => {
    const hop = 'rpc_proxy_trusted_edge' as const
    await databasePool.query(
      `UPDATE pr2_readiness_activations
          SET updated_at = clock_timestamp() - interval '120 seconds'
        WHERE environment_id = $1`,
      ['test.cluster']
    )
    await databasePool.query(
      `UPDATE pr2_readiness_evidence
          SET observed_at = clock_timestamp() - interval '61 seconds'
        WHERE environment_id = $1
          AND source_revision = $2
          AND hop = $3
          AND evidence_class = 'runtime'
          AND evidence_kind = 'service_runtime'`,
      ['test.cluster', SHA, hop]
    )

    const expired = await assemblePr2Readiness(databasePool, 'test.cluster', undefined, SHA)
    expect(expired[hop]).toBe('unavailable')

    await databasePool.query(
      `UPDATE pr2_readiness_evidence
          SET observed_at = clock_timestamp()
        WHERE environment_id = $1
          AND source_revision = $2
          AND hop = $3
          AND evidence_class = 'runtime'
          AND evidence_kind = 'service_runtime'`,
      ['test.cluster', SHA, hop]
    )

    const refreshed = await assemblePr2Readiness(databasePool, 'test.cluster', undefined, SHA)
    expect(refreshed[hop]).toBe('ready')
  })

  it('rolls activation and its complete build-evidence batch back together', async () => {
    const nextSha = 'b'.repeat(40)
    const activation = {
      environmentId: 'test.cluster',
      sourceRevision: nextSha,
      acceptedBy: 'test:operator',
      acceptedAt,
      maxRuntimeEvidenceAgeSeconds: 60,
    } as const
    const evidence = ['exact_head_ci', 'producer_contract'].map(kind => ({
      environmentId: 'test.cluster',
      sourceRevision: nextSha,
      hop: 'action_contracts' as const,
      evidenceClass: 'build' as const,
      evidenceKind: kind as 'exact_head_ci' | 'producer_contract',
      writer: 'operator-build-importer' as const,
      evidenceReference: `${kind}:action_contracts:${nextSha}`,
      outcome: 'passed' as const,
      serviceVersion: '1.2.3',
      contractVersion: PR2_READINESS_CONTRACT_VERSION,
      deploymentRevision: null,
      imageRevision: nextSha,
      observedAt: new Date(),
    }))
    const failingTransaction: Pr2ReadinessTransactionRunner = async work => {
      const client = await databasePool.connect()
      let inserts = 0
      const db: DbClient = {
        query: async (text, values) => {
          if (text.includes('INSERT INTO pr2_readiness_evidence') && ++inserts === 2) {
            throw new Error('injected_build_batch_failure')
          }
          return client.query(text, values)
        },
      }
      try {
        await client.query('BEGIN')
        const result = await work(db)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    await expect(importPr2BuildEvidence(activation, evidence, failingTransaction)).rejects.toThrow(
      'injected_build_batch_failure'
    )
    const active = await databasePool.query(
      'SELECT source_revision FROM pr2_readiness_activations WHERE environment_id = $1',
      ['test.cluster']
    )
    expect(active.rows[0]).toMatchObject({ source_revision: SHA })
  })

  it('requires new runtime evidence when a previously used source is reactivated', async () => {
    const otherSha = 'c'.repeat(40)
    await activatePr2ReadinessSource(databasePool, {
      environmentId: 'test.cluster',
      sourceRevision: otherSha,
      acceptedBy: 'test:operator',
      acceptedAt,
      maxRuntimeEvidenceAgeSeconds: 60,
    })
    await activatePr2ReadinessSource(databasePool, {
      environmentId: 'test.cluster',
      sourceRevision: SHA,
      acceptedBy: 'test:operator',
      acceptedAt,
      maxRuntimeEvidenceAgeSeconds: 60,
    })

    expect(
      Object.values(await assemblePr2Readiness(databasePool, 'test.cluster', undefined, SHA))
    ).toEqual(Array(17).fill('unavailable'))
  })

  it('serializes a concurrent activation import and runtime writer without lock inversion', async () => {
    const observedAt = new Date()
    const activation = {
      environmentId: 'test.cluster',
      sourceRevision: SHA,
      acceptedBy: 'test:operator',
      acceptedAt: observedAt,
      maxRuntimeEvidenceAgeSeconds: 60,
    } as const
    const buildEvidence = {
      environmentId: 'test.cluster',
      sourceRevision: SHA,
      hop: 'action_contracts' as const,
      evidenceClass: 'build' as const,
      evidenceKind: 'exact_head_ci' as const,
      writer: 'operator-build-importer' as const,
      evidenceReference: `exact_head_ci:action_contracts:${SHA}`,
      outcome: 'passed' as const,
      serviceVersion: '1.2.3',
      contractVersion: PR2_READINESS_CONTRACT_VERSION,
      deploymentRevision: null,
      imageRevision: SHA,
      observedAt,
    }
    const runtimeEvidence = {
      environmentId: 'test.cluster',
      sourceRevision: SHA,
      hop: 'rpc_proxy_trusted_edge' as const,
      evidenceClass: 'runtime' as const,
      evidenceKind: 'service_runtime' as const,
      writer: 'rpc-proxy' as const,
      evidenceReference: `runtime:rpc-proxy:${SHA}`,
      outcome: 'passed' as const,
      serviceVersion: '1.2.3',
      contractVersion: PR2_READINESS_CONTRACT_VERSION,
      deploymentRevision: 'deploy-a',
      imageRevision: SHA,
      observedAt,
    }

    await expect(
      Promise.all([
        importPr2BuildEvidence(activation, [buildEvidence], transaction),
        writePr2ReadinessEvidence(runtimeEvidence, transaction),
      ])
    ).resolves.toHaveLength(2)
  })
})
