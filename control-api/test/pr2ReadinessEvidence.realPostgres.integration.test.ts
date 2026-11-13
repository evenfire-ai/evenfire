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
import { READINESS_EVIDENCE_WRITE_LOCK_CLASS } from '../src/services/advisoryLockClasses.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

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
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      }
    } finally {
      await adminPool?.end()
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
    for (const requiredHop of PR2_READINESS_HOPS) {
      await writeCompleteHop(requiredHop, new Date())
    }
    const clock = await databasePool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    const serverNow = new Date(clock.rows[0]!.now)
    await databasePool.query(
      `UPDATE pr2_readiness_activations
          SET updated_at = $2::timestamptz - interval '120 seconds'
        WHERE environment_id = $1`,
      ['test.cluster', serverNow]
    )

    const setRuntimeAgeSeconds = async (seconds: number): Promise<void> => {
      await databasePool.query(
        `UPDATE pr2_readiness_evidence
            SET observed_at = $4::timestamptz - ($5::text || ' seconds')::interval
          WHERE environment_id = $1
            AND source_revision = $2
            AND hop = $3
            AND evidence_class = 'runtime'
            AND evidence_kind = 'service_runtime'`,
        ['test.cluster', SHA, hop, serverNow, seconds]
      )
    }

    await setRuntimeAgeSeconds(30)
    const withinBound = await assemblePr2Readiness(databasePool, 'test.cluster', serverNow, SHA)
    expect(withinBound[hop]).toBe('ready')

    await setRuntimeAgeSeconds(60)
    const atBoundary = await assemblePr2Readiness(databasePool, 'test.cluster', serverNow, SHA)
    expect(atBoundary[hop]).toBe('ready')

    await setRuntimeAgeSeconds(61)
    const expired = await assemblePr2Readiness(databasePool, 'test.cluster', serverNow, SHA)
    expect(expired[hop]).toBe('unavailable')

    await setRuntimeAgeSeconds(-1)
    const futureDated = await assemblePr2Readiness(databasePool, 'test.cluster', serverNow, SHA)
    expect(futureDated[hop]).toBe('unavailable')

    await setRuntimeAgeSeconds(0)
    const refreshed = await assemblePr2Readiness(databasePool, 'test.cluster', serverNow, SHA)
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

  // A11 M1 (C12): the writer key is a two-int4 lock in its own class, so a
  // single-bigint `hashtext` key over the same text never blocks it.
  it('takes the writer key as a two-int4 lock that a single-bigint key cannot block', async () => {
    const environmentId = 'lock.cluster'
    await activatePr2ReadinessSource(databasePool, {
      environmentId,
      sourceRevision: SHA,
      acceptedBy: 'test:operator',
      acceptedAt: new Date(Date.now() - 1_000),
      maxRuntimeEvidenceAgeSeconds: 60,
    })
    const keyText = `${environmentId}:action_contracts:build:exact_head_ci`
    const other = await databasePool.connect()
    const writerClient = await databasePool.connect()
    let releaseWriter: () => void = () => undefined
    const writerHeld = new Promise<void>(resolve => (releaseWriter = resolve))
    let keyTaken: () => void = () => undefined
    const afterKey = new Promise<void>(resolve => (keyTaken = resolve))
    let writing: Promise<unknown> | undefined
    try {
      await other.query('BEGIN')
      await other.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [keyText])
      const writerPid = Number(
        (await writerClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      )
      // Hold the writer's transaction open right after its advisory statement.
      const hooked = Object.assign(Object.create(writerClient), {
        query: async (text: string, values?: unknown[]) => {
          const result = await writerClient.query(text, values)
          if (text.includes('pg_advisory_xact_lock')) {
            keyTaken()
            await writerHeld
          }
          return result
        },
      }) as DbClient
      const heldTransaction: Pr2ReadinessTransactionRunner = async work => {
        await writerClient.query('BEGIN')
        try {
          const result = await work(hooked)
          await writerClient.query('COMMIT')
          return result
        } catch (error) {
          await writerClient.query('ROLLBACK')
          throw error
        }
      }
      writing = writePr2ReadinessEvidence(
        {
          environmentId,
          sourceRevision: SHA,
          hop: 'action_contracts',
          evidenceClass: 'build',
          evidenceKind: 'exact_head_ci',
          writer: 'operator-build-importer',
          evidenceReference: `exact_head_ci:action_contracts:${SHA}`,
          outcome: 'passed',
          serviceVersion: '1.2.3',
          contractVersion: PR2_READINESS_CONTRACT_VERSION,
          deploymentRevision: null,
          imageRevision: SHA,
          observedAt: new Date(),
        },
        heldTransaction
      )
      let blocked: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        afterKey,
        new Promise((_resolve, reject) => {
          blocked = setTimeout(
            () => reject(new Error('the writer blocked on a single-bigint key with its text')),
            5_000
          )
        }),
      ]).finally(() => clearTimeout(blocked))

      const locks = await databasePool.query(
        `SELECT classid::text AS classid, objid::text AS objid, objsubid,
                (hashtext($2)::bigint & 4294967295)::text AS expected_objid
           FROM pg_locks
          WHERE locktype = 'advisory' AND pid = $1 AND granted`,
        [writerPid, keyText]
      )
      // Liveness: the writer holds exactly one advisory lock, in the class form.
      expect(locks.rows).toHaveLength(1)
      expect(locks.rows[0]).toEqual({
        classid: String(READINESS_EVIDENCE_WRITE_LOCK_CLASS),
        objid: locks.rows[0].expected_objid,
        objsubid: 2,
        expected_objid: locks.rows[0].expected_objid,
      })

      releaseWriter()
      await expect(writing).resolves.toBe('inserted')
    } finally {
      releaseWriter()
      await other.query('ROLLBACK')
      if (writing) await Promise.allSettled([writing])
      other.release()
      writerClient.release()
    }
  })
})
