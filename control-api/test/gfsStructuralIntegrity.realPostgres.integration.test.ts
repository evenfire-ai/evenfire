import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import { applyResourcePatch } from '../src/routes/gfs/resources.js'
import type { GfsCaller } from '../src/routes/gfs/grants.js'
import { PgBlobStagingStore } from '../../gfs-controller/src/db/blobStaging.js'
import {
  GfsWriteService,
  type BlobWriter,
  type Transactor,
} from '../../gfs-controller/src/db/writeStore.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const operator: GfsCaller = {
  isOperator: true,
  subjects: new Set(['operator:']),
  actorKey: 'operator:',
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function begin(client: PoolClient): Promise<void> {
  await client.query('BEGIN')
  await client.query(`SET LOCAL lock_timeout = '5s'`)
  await client.query(`SET LOCAL statement_timeout = '10s'`)
}

async function waitUntilBlocked(
  pool: Pool,
  blockedPid: number,
  blockerPid: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked`,
      [blockedPid, blockerPid]
    )
    if (result.rows[0]?.blocked) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error(`${label}: expected PostgreSQL blocker was not observed`)
}

interface Tree {
  drive: string
  root: string
  source: string
  destinationA: string
  destinationB: string
  child: string
}

async function seedTree(pool: Pool, label: string): Promise<Tree> {
  const tree: Tree = {
    drive: `real-pg-${label}-${randomBytes(4).toString('hex')}`,
    root: randomUUID(),
    source: randomUUID(),
    destinationA: randomUUID(),
    destinationB: randomUUID(),
    child: randomUUID(),
  }
  await pool.query(
    `INSERT INTO gfs_resources
       (resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes)
     VALUES ($1,$6,NULL,'','directory','/',0,0),
            ($2,$6,$1,'source','directory','/source',0,0),
            ($3,$6,$1,'destination-a','directory','/destination-a',0,0),
            ($4,$6,$1,'destination-b','directory','/destination-b',0,0),
            ($5,$6,$2,'child.txt','file','/source/child.txt',0,0)`,
    [tree.root, tree.source, tree.destinationA, tree.destinationB, tree.child, tree.drive]
  )
  return tree
}

async function move(client: PoolClient, tree: Tree, destination: string): Promise<number> {
  const result = await applyResourcePatch(
    client,
    operator,
    tree.drive,
    tree.child,
    { newParentId: destination },
    async () => undefined
  )
  return result.version
}

const blobs: BlobWriter = {
  async writeImmutable(resourceId: string, generation: string, data: Readable | Buffer) {
    if (!Buffer.isBuffer(data)) throw new Error('real-PG fixture expects buffered replacement')
    return {
      blobKey: `${resourceId.replaceAll('-', '')}/${generation}`,
      bytes: data.length,
      contentSha256: createHash('sha256').update(data).digest('hex'),
    }
  },
  async verify() {},
  async deleteByKey() {},
  async deleteLegacyFlat() {},
}

function boundTransaction(client: PoolClient): Transactor {
  return { transaction: work => work(client) }
}
function writer(client: PoolClient, manifests = new PgBlobStagingStore(client)): GfsWriteService {
  return new GfsWriteService(boundTransaction(client), blobs, manifests)
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function expectNoLiveNodeBelowTombstone(pool: Pool): Promise<void> {
  const result = await pool.query<{ violations: string }>(`WITH RECURSIVE ancestry AS (
    SELECT resource_id AS live_id,parent_resource_id,ARRAY[resource_id]::uuid[] visited
      FROM gfs_resources WHERE deleted_at IS NULL UNION ALL
    SELECT a.live_id,p.parent_resource_id,a.visited||p.resource_id FROM ancestry a
      JOIN gfs_resources p ON p.resource_id=a.parent_resource_id
     WHERE NOT p.resource_id=ANY(a.visited))
    SELECT count(*) violations FROM ancestry a JOIN gfs_resources p
      ON p.resource_id=a.parent_resource_id WHERE p.deleted_at IS NOT NULL`)
  expect(Number(result.rows[0]?.violations)).toBe(0)
}

describeRealPostgres('GFS Phase 0 real PostgreSQL integrity', () => {
  const database = `gfs_phase0_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('serializes create/delete and makes delete observe the committed child', async () => {
    const tree = await seedTree(pool, 'create-delete')
    const creator = await pool.connect()
    const deleter = await pool.connect()
    try {
      await Promise.all([begin(creator), begin(deleter)])
      const creatorPid = Number((await creator.query('SELECT pg_backend_pid() pid')).rows[0]?.pid)
      const deleterPid = Number((await deleter.query('SELECT pg_backend_pid() pid')).rows[0]?.pid)
      await writer(creator).create({
        drive: tree.drive,
        parentId: tree.destinationA,
        name: 'concurrent',
        kind: 'directory',
      })
      const deletion = writer(deleter).delete({
        drive: tree.drive,
        resourceId: tree.destinationA,
        ifMatch: 0,
      }).catch(error => error as { code?: string })
      await waitUntilBlocked(pool, deleterPid, creatorPid, 'create/delete')
      await creator.query('COMMIT')
      await expect(deletion).resolves.toMatchObject({ code: 'not_empty' })
      await deleter.query('ROLLBACK')
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined)
      await deleter.query('ROLLBACK').catch(() => undefined)
      for (const client of [creator, deleter]) client.release()
    }
    await expectNoLiveNodeBelowTombstone(pool)
  }, 20_000)

  it('serializes move/delete and prevents a half-observed destination', async () => {
    const tree = await seedTree(pool, 'move-delete')
    const [mover, deleter] = await Promise.all([pool.connect(), pool.connect()])
    try {
      await Promise.all([begin(mover), begin(deleter)])
      const moverPid = Number((await mover.query('SELECT pg_backend_pid() pid')).rows[0]?.pid)
      const deleterPid = Number((await deleter.query('SELECT pg_backend_pid() pid')).rows[0]?.pid)
      expect(await move(mover, tree, tree.destinationA)).toBe(1)
      const deletion = writer(deleter).delete({
        drive: tree.drive,
        resourceId: tree.destinationA,
        ifMatch: 0,
      }).catch(error => error as { code?: string })
      await waitUntilBlocked(pool, deleterPid, moverPid, 'move/delete')
      await mover.query('COMMIT')
      await expect(deletion).resolves.toMatchObject({ code: 'not_empty' })
      await deleter.query('ROLLBACK')
    } finally {
      await mover.query('ROLLBACK').catch(() => undefined)
      await deleter.query('ROLLBACK').catch(() => undefined)
      for (const client of [mover, deleter]) client.release()
    }
    await expectNoLiveNodeBelowTombstone(pool)
  }, 20_000)

  it('rejects moving a directory below its descendant', async () => {
    const tree = await seedTree(pool, 'cycle')
    const descendant = randomUUID()
    await pool.query(`INSERT INTO gfs_resources
      (resource_id,drive,parent_resource_id,name,kind,path_cache,version,bytes)
      VALUES ($1,$2,$3,'descendant','directory','/source/descendant',0,0)`,
    [descendant, tree.drive, tree.source])
    const client = await pool.connect()
    try {
      await begin(client)
      await expect(applyResourcePatch(
        client, operator, tree.drive, tree.source, { newParentId: descendant }, async () => undefined
      )).rejects.toMatchObject({ code: 'path_invalid' })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const source = await pool.query(
      'SELECT parent_resource_id,path_cache,version FROM gfs_resources WHERE resource_id=$1', [tree.source])
    expect(source.rows).toEqual([{ parent_resource_id: tree.root, path_cache: '/source', version: 0 }])
  })

  it('atomically refreshes path_cache for every node in a moved subtree', async () => {
    const tree = await seedTree(pool, 'subtree-paths')
    const [nested, leaf] = [randomUUID(), randomUUID()]
    await pool.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes)
       VALUES ($1,$3,$4,'nested','directory','/source/nested',0,0),
              ($2,$3,$1,'leaf.txt','file','/source/nested/leaf.txt',0,0)`,
      [nested, leaf, tree.drive, tree.source]
    )
    const client = await pool.connect()
    try {
      await begin(client)
      await applyResourcePatch(
        client, operator, tree.drive, tree.source, { newParentId: tree.destinationA }, async () => undefined
      )
      const beforeCommit = await pool.query(`SELECT path_cache FROM gfs_resources
        WHERE resource_id=ANY($1::uuid[]) ORDER BY path_cache`, [[tree.source, tree.child, nested, leaf]])
      expect(beforeCommit.rows.map(row => row.path_cache)).toEqual([
        '/source', '/source/child.txt', '/source/nested', '/source/nested/leaf.txt',
      ])
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const paths = await pool.query(`SELECT name,path_cache FROM gfs_resources
      WHERE resource_id=ANY($1::uuid[]) ORDER BY path_cache`, [[tree.source, tree.child, nested, leaf]])
    expect(paths.rows).toEqual([
      { name: 'source', path_cache: '/destination-a/source' },
      { name: 'child.txt', path_cache: '/destination-a/source/child.txt' },
      { name: 'nested', path_cache: '/destination-a/source/nested' },
      { name: 'leaf.txt', path_cache: '/destination-a/source/nested/leaf.txt' },
    ])
  })

  it('serializes two moves and leaves one coherent final parent and path', async () => {
    const tree = await seedTree(pool, 'move-move')
    const [first, second] = await Promise.all([pool.connect(), pool.connect()])
    try {
      await Promise.all([begin(first), begin(second)])
      const firstPid = Number((await first.query('SELECT pg_backend_pid() pid')).rows[0]?.pid)
      const secondPid = Number((await second.query('SELECT pg_backend_pid() pid')).rows[0]?.pid)
      expect(await move(first, tree, tree.destinationA)).toBe(1)
      const secondMove = move(second, tree, tree.destinationB)
      await waitUntilBlocked(pool, secondPid, firstPid, 'move/move')
      await first.query('COMMIT')
      await expect(secondMove).resolves.toBe(2)
      await second.query('COMMIT')
      const final = await pool.query(
        `SELECT parent_resource_id,path_cache,version FROM gfs_resources WHERE resource_id=$1`,
        [tree.child]
      )
      expect(final.rows).toEqual([{
        parent_resource_id: tree.destinationB,
        path_cache: '/destination-b/child.txt',
        version: 2,
      }])
    } finally {
      await first.query('ROLLBACK').catch(() => undefined)
      await second.query('ROLLBACK').catch(() => undefined)
      for (const client of [first, second]) client.release()
    }
  }, 20_000)

  it('never lets cleanup claim a generation while publication holds its row lock', async () => {
    const tree = await seedTree(pool, 'publish-cleanup')
    const [publisher, cleanup] = await Promise.all([pool.connect(), pool.connect()])
    const paused = deferred()
    const resume = deferred()
    try {
      await begin(cleanup)
      const transactor: Transactor = {
        transaction: async work => {
          await begin(publisher)
          const result = await work(publisher)
          paused.resolve()
          await resume.promise
          await publisher.query('COMMIT')
          return result
        },
      }
      const manifests = new PgBlobStagingStore(pool)
      const replacement = new GfsWriteService(transactor, blobs, manifests).replace({
        drive: tree.drive,
        resourceId: tree.child,
        ifMatch: 0,
        content: Buffer.from('replacement'),
      })
      await paused.promise
      const store = new PgBlobStagingStore(cleanup)
      await expect(store.claimExpiredCandidate(0)).resolves.toBeNull()
      resume.resolve()
      const published = await replacement
      const row = await pool.query<{ blob_key: string | null }>(
        'SELECT blob_key FROM gfs_resources WHERE resource_id=$1',
        [tree.child]
      )
      expect(row.rows[0]?.blob_key).toBe(published.blobKey)
      await cleanup.query('ROLLBACK')
    } finally {
      await publisher.query('ROLLBACK').catch(() => undefined)
      await cleanup.query('ROLLBACK').catch(() => undefined)
      for (const client of [publisher, cleanup]) client.release()
    }
  }, 20_000)
})
