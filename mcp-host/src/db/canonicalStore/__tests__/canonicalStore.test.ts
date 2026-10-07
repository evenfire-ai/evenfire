import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type Binding,
  type FsPort,
  type MigrationJournal,
  acquireWriterFence,
  adoptCanonicalStore,
  assertNoIncompleteCanonicalMigration,
  beginRecovery,
  discoverBackupSets,
  exportCanonicalStore,
  exportHistoricalBackup,
  inspectCandidate,
  inspectRecovery,
  layoutPrecheck,
  nodeFs,
  runMigration,
  validateCanonicalStore,
} from '..'
import {
  type ResolvedCanonicalOperatorRequest,
  computeCanonicalOperatorRequestHash,
} from '../../../runtime/canonicalOperatorAuthorization'
import { runMigrations } from '../../migrate'
import { migrations } from '../../migrations'
import { FINAL_MARKER, MIGRATING_MARKER, readJournal } from '../journal'
import { fileHash, fingerprints, objectHash, privateDirectory } from '../paths'

const binding: Binding = { hostUid: 'host-825', pvcUid: 'pvc-825' }
const roots: string[] = []
function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-store-825-')))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function database(
  root: string,
  location = '',
  populated = true,
  version = migrations.length
): Database.Database {
  const directory = path.join(root, location)
  fs.mkdirSync(directory, { recursive: true })
  const db = new Database(path.join(directory, 'state.db'))
  if (version === migrations.length) runMigrations(db)
  else {
    db.exec('CREATE TABLE migrations_meta (name TEXT PRIMARY KEY, applied_at REAL NOT NULL)')
    for (const migration of migrations.slice(0, version)) {
      migration.up(db)
      db.prepare('INSERT INTO migrations_meta VALUES (?,?)').run(migration.name, 1)
    }
  }
  if (populated) {
    db.prepare(
      `INSERT INTO sessions (id,session_key,source,user_id,team_id,started_at) VALUES ('s1','key1','desktop','u1','t1',1)`
    ).run()
    db.prepare(
      `INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',1,'user','retained',1)`
    ).run()
    db.prepare(
      `INSERT INTO pending_approvals (request_id,session_id,task_id,tool_name,tool_call_id,parameters,description,context_snapshot,registered_at,expires_at)
      VALUES ('a1','s1','task1','tool','call1','{}','Approval','[]',1,2)`
    ).run()
  }
  if (populated && version >= 10) recompute(db)
  return db
}
function recompute(db: Database.Database): void {
  db.exec(`UPDATE sessions SET
    message_count=(SELECT COUNT(*) FROM messages WHERE session_id=sessions.id AND (role='user' OR (role='assistant' AND tool_calls IS NULL))),
    turn_count=(SELECT COUNT(DISTINCT turn_number) FROM messages WHERE session_id=sessions.id AND turn_number IS NOT NULL),
    last_activity_at=MAX(COALESCE(last_activity_at,started_at),started_at,COALESCE((SELECT MAX(timestamp) FROM messages WHERE session_id=sessions.id),started_at))`)
}
/** Glue tests inject a typed trusted resolver result; runtime authorization tests independently use fresh Kubernetes readers. */
function cliAdoptionBoundary(
  root: string,
  request: import('../types').RecoveryRequest,
  authorization: import('../types').OperatorAuthorization
) {
  const operatorRequest = {
    ...request,
    storageContract: 'canonical' as const,
    operation: 'adopt' as const,
    principal: { kind: 'control-admin' as const, subject: authorization.principal },
  }
  const requestHash = computeCanonicalOperatorRequestHash(operatorRequest)
  return {
    resolveOperatorRequest: async () =>
      ({
        ...binding,
        binding,
        storageContract: 'canonical',
        maintenanceId: request.maintenanceId,
        principal: authorization.principal,
        operation: 'adopt',
        action: 'adopt',
        request,
        operatorRequest,
        authorization: {
          ...authorization,
          kind: 'canonical-adoption',
          storageContract: 'canonical',
          requestHash,
        },
        proof: {
          ...binding,
          requestId: request.requestId,
          requestHash,
          storageContract: 'canonical',
          rootMountPath: root,
          rootReadOnly: false,
          hostResourceVersion: 'host-rv-1',
          pvcName: 'test-pvc',
          pvcResourceVersion: 'pvc-rv-1',
          podName: 'test-pod',
          podUid: randomUUID(),
          podResourceVersion: 'pod-rv-1',
          jobName: 'test-job',
          jobUid: randomUUID(),
          jobResourceVersion: 'job-rv-1',
          image: 'fixture-image',
          templateRevision: objectHash('fixture-template'),
        },
      }) as ResolvedCanonicalOperatorRequest,
  }
}
const provenance = { ...binding, kind: 'new-host' as const, maintenanceId: 'maintenance-825' }
async function inspection(root: string, location = '') {
  const fence = acquireWriterFence({ stateDir: path.join(root, 'state') })
  try {
    return await inspectCandidate(path.join(root, location), {
      root,
      scratchDir: path.join(root, 'state', '.canonical-store', 'scratch-tests'),
      binding,
      fence,
    })
  } finally {
    fence.close()
  }
}
function archived(root: string): MigrationJournal {
  const directory = path.join(root, 'state', '.canonical-store')
  const id = fs.readdirSync(directory).find(id => /^[0-9a-f-]{36}$/i.test(id))!
  return JSON.parse(fs.readFileSync(path.join(directory, id, 'journal.json'), 'utf8'))
}

describe('canonical SQLite store', () => {
  it('requires positive provenance before creating a new database', async () => {
    const root = fixture()
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'SourceExportRequired',
    })
    expect(fs.existsSync(path.join(root, 'state', 'state.db'))).toBe(false)
    const result = await runMigration(root, { binding, provenance })
    expect(result.reason).toBe('Created')
    expect(
      validateCanonicalStore({ stateDir: path.join(root, 'state'), binding, root }).storeId
    ).toBe(result.storeId)
    expect(archived(root).phase).toBe('completed')
  })
  it.each(['', 'workspace', 'state'])(
    'preserves a single %s catalog and its complete identity',
    async location => {
      const root = fixture()
      database(root, location).close()
      fs.mkdirSync(path.join(root, 'spillover'))
      fs.writeFileSync(path.join(root, 'spillover', 'blob.bin'), 'bytes')
      fs.mkdirSync(path.join(root, 'lost+found'))
      fs.writeFileSync(path.join(root, 'lost+found', 'keep'), 'kept')
      const before = await inspection(root, location)
      const result = await runMigration(root, { binding })
      const after = await inspection(root, 'state')
      expect(result.reason).toBe('SingleCandidate')
      expect(after.catalogHash).toBe(before.catalogHash)
      expect(after.counts).toEqual(before.counts)
      expect(fs.readFileSync(path.join(root, 'workspace', 'spillover', 'blob.bin'), 'utf8')).toBe(
        'bytes'
      )
      expect(fs.readFileSync(path.join(root, 'lost+found', 'keep'), 'utf8')).toBe('kept')
      expect(archived(root).operations.every(op => op.state === 'done')).toBe(true)
      const db = new Database(path.join(root, 'state', 'state.db'))
      expect(() =>
        db.prepare("UPDATE canonical_store_identity SET store_id='different'").run()
      ).toThrow('immutable')
      db.close()
    }
  )
  it('accepts legitimate later writes without requiring the old physical staging hash', async () => {
    const root = fixture()
    database(root).close()
    const first = await runMigration(root, { binding })
    const db = new Database(path.join(root, 'state', 'state.db'))
    db.prepare(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','later',2)"
    ).run()
    db.close()
    expect(await runMigration(root, { binding })).toEqual({
      outcome: 'ok',
      reason: 'AlreadyCanonical',
      layoutVersion: 1,
      storeId: first.storeId,
    })
    expect((await inspection(root, 'state')).counts.messages).toBe(2)
    expect(
      fs
        .readdirSync(path.join(root, 'state', '.canonical-store'))
        .filter(id => /^[0-9a-f-]{36}$/i.test(id))
    ).toHaveLength(1)
  })
  it('does not select newer or larger empty catalogs over complete business state', async () => {
    const root = fixture()
    database(root).close()
    const empty = database(root, 'state', false)
    empty.exec(
      "INSERT INTO sessions (id,session_key,source,started_at,title) VALUES ('padding','padding','desktop',1,zeroblob(200000)); DELETE FROM sessions"
    )
    empty.close()
    fs.utimesSync(path.join(root, 'state', 'state.db'), new Date(), new Date())
    expect(fs.statSync(path.join(root, 'state', 'state.db')).size).toBeGreaterThan(
      fs.statSync(path.join(root, 'state.db')).size
    )
    expect((await runMigration(root, { binding })).reason).toBe('EmptyCandidateRetired')
    expect((await inspection(root, 'state')).counts.messages).toBe(1)
  })
  it('selects equivalent normalized catalogs with state priority', async () => {
    const root = fixture()
    database(root).close()
    fs.mkdirSync(path.join(root, 'state'))
    fs.copyFileSync(path.join(root, 'state.db'), path.join(root, 'state', 'state.db'))
    expect((await runMigration(root, { binding })).reason).toBe('EquivalentCandidates')
    expect(archived(root).selected).toBe('C_state')
  })
  it.each([
    "UPDATE sessions SET user_id='other'",
    "UPDATE sessions SET session_key='other'",
    "UPDATE sessions SET state='busy'",
    'UPDATE sessions SET model_selection_revision=1',
    'UPDATE messages SET id=8',
    "UPDATE messages SET role='assistant'",
    "UPDATE messages SET content_parts='[]'",
    "UPDATE messages SET tool_calls='[]'",
    'UPDATE pending_approvals SET parameters=\'{"amount":1}\'',
    "UPDATE pending_approvals SET task_budget='{}'",
    "UPDATE pending_approvals SET authorization_scope='turn'",
    "UPDATE sqlite_sequence SET seq=20 WHERE name='messages'",
  ])('blocks one-field divergence: %s', async change => {
    const root = fixture()
    database(root).close()
    fs.mkdirSync(path.join(root, 'state'))
    fs.copyFileSync(path.join(root, 'state.db'), path.join(root, 'state', 'state.db'))
    const db = new Database(path.join(root, 'state', 'state.db'))
    db.exec(change)
    db.close()
    const before = fileHash(root, path.join(root, 'state.db'))
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'DivergentCandidates',
    })
    expect(readJournal(root, binding)?.phase).toBe('snapshotted')
    expect(fileHash(root, path.join(root, 'state.db'))).toBe(before)
  })
  it('replays non-checkpointed WAL only in private scratch and leaves source snapshots unchanged', async () => {
    const root = fixture()
    const db = database(root)
    db.pragma('journal_mode=WAL')
    db.pragma('wal_autocheckpoint=0')
    db.prepare(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','wal-only',2)"
    ).run()
    const before = objectHash(fingerprints(root, root))
    const result = await inspection(root)
    expect(result.counts.messages).toBe(2)
    expect(objectHash(fingerprints(root, root))).toBe(before)
    db.close()
  })
  it('normalizes a known older migration version only in scratch', async () => {
    const root = fixture()
    database(root, '', true, 1).close()
    const before = fileHash(root, path.join(root, 'state.db'))
    const result = await inspection(root)
    expect(result.schemaVersion).toBe(1)
    expect(result.counts.messages).toBe(1)
    expect(fileHash(root, path.join(root, 'state.db'))).toBe(before)
    expect((await runMigration(root, { binding })).reason).toBe('SingleCandidate')
  })
  it.each([
    'CREATE TABLE unknown_table (id INTEGER)',
    'ALTER TABLE messages ADD COLUMN unknown_data TEXT',
    'CREATE TRIGGER unknown_trigger AFTER INSERT ON sessions BEGIN SELECT 1; END',
  ])('blocks unsupported schema: %s', async sql => {
    const root = fixture()
    const db = database(root)
    db.exec(sql)
    db.close()
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'SchemaUnsupported',
    })
    expect(fs.existsSync(path.join(root, 'state.db'))).toBe(true)
  })
  it('blocks orphan sidecars, corrupt databases and hot rollback journals', async () => {
    const orphan = fixture()
    fs.writeFileSync(path.join(orphan, 'state.db-wal'), 'unowned')
    await expect(runMigration(orphan, { binding })).rejects.toMatchObject({
      reason: 'CandidateIncomplete',
    })
    const corrupt = fixture()
    fs.writeFileSync(path.join(corrupt, 'state.db'), 'not sqlite')
    await expect(runMigration(corrupt, { binding })).rejects.toMatchObject({
      reason: 'CandidateCorrupt',
    })
    const hot = fixture()
    database(hot).close()
    fs.writeFileSync(path.join(hot, 'state.db-journal'), 'hot journal')
    await expect(runMigration(hot, { binding })).rejects.toMatchObject({
      reason: 'CandidateIncomplete',
    })
  })
  it('fails before retiring sources when workspace destinations collide or disk budget is insufficient', async () => {
    const root = fixture()
    database(root).close()
    fs.mkdirSync(path.join(root, 'workspace'))
    fs.writeFileSync(path.join(root, 'notes.md'), 'source')
    fs.writeFileSync(path.join(root, 'workspace', 'notes.md'), 'destination')
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'WorkspaceEntryCollision',
    })
    expect(fs.existsSync(path.join(root, 'state.db'))).toBe(true)
    fs.unlinkSync(path.join(root, 'workspace', 'notes.md'))
    await expect(
      runMigration(root, { binding, statfs: () => ({ bsize: 1, bavail: 1 }) })
    ).rejects.toMatchObject({ reason: 'InsufficientSpace' })
    expect(fs.existsSync(path.join(root, 'state.db'))).toBe(true)
  })
  it('rejects symlinks, hardlinks and manipulated journal paths', async () => {
    const root = fixture()
    database(root).close()
    const outside = fixture()
    fs.symlinkSync(outside, path.join(root, 'workspace'))
    await expect(runMigration(root, { binding })).rejects.toMatchObject({ reason: 'LayoutUnsafe' })
    fs.unlinkSync(path.join(root, 'workspace'))
    fs.linkSync(path.join(root, 'state.db'), path.join(root, 'alias.db'))
    await expect(runMigration(root, { binding })).rejects.toMatchObject({ reason: 'LayoutUnsafe' })
    fs.unlinkSync(path.join(root, 'alias.db'))
    fs.mkdirSync(path.join(root, 'state', '.canonical-store'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'state', '.canonical-store', 'journal.json'),
      JSON.stringify({ journalVersion: 1, migrationId: '../escape' })
    )
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'JournalInvalid',
    })
    expect(fs.existsSync(path.join(outside, 'state.db'))).toBe(false)
  })
  it('requires init finalization before normal boot and rejects a foreign post-canonical empty source', async () => {
    const root = fixture()
    database(root).close()
    await runMigration(root, { binding })
    database(root, '', false).close()
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'ForeignCandidateAfterCanonical',
    })
    fs.writeFileSync(path.join(root, 'state', '.canonical-store', 'journal.json'), '{}')
    expect(() =>
      assertNoIncompleteCanonicalMigration({ root, stateDir: path.join(root, 'state') })
    ).toThrow('MigrationInProgress')
  })
  it('precheck keeps a winning state set intact and produces no canonical identity', async () => {
    const root = fixture()
    database(root, 'state').close()
    const before = objectHash(fingerprints(root, path.join(root, 'state')))
    fs.writeFileSync(path.join(root, 'notes.md'), 'retained note')
    const result = await layoutPrecheck(root, { binding })
    expect(result.reason).toBe('SingleCandidate')
    expect(objectHash(fingerprints(root, path.join(root, 'state')))).toBe(before)
    expect(fs.existsSync(path.join(root, FINAL_MARKER))).toBe(false)
    expect(archived(root).variant).toBe('keep-existing-state')
    expect(fs.readFileSync(path.join(root, 'workspace', 'notes.md'), 'utf8')).toBe('retained note')
  })
  it('one-shot authorized adoption continues the same blocked journal and preserves both originals', async () => {
    const root = fixture()
    database(root).close()
    const other = database(root, 'state')
    other.exec("UPDATE sessions SET title='different'")
    other.close()
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'DivergentCandidates',
    })
    const journal = readJournal(root, binding)!
    const request = {
      schemaVersion: 1 as const,
      requestId: randomUUID(),
      ...binding,
      maintenanceId: 'maintenance-825',
      migrationId: journal.migrationId,
      manifestHash: journal.manifestHash!,
      candidateHash: journal.candidates.find(candidate => candidate.id === 'C_root')!.sourceHash,
    }
    const authorization = {
      ...binding,
      authorized: true as const,
      principal: 'operator',
      requestId: request.requestId,
      maintenanceId: request.maintenanceId,
    }
    await expect(
      adoptCanonicalStore(root, request, { ...authorization, authorized: false } as never, {
        binding,
      })
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    await expect(
      adoptCanonicalStore(root, { ...request, candidateHash: '0'.repeat(64) }, authorization, {
        binding,
      })
    ).rejects.toMatchObject({ reason: 'AdoptFingerprintUnknown' })
    const result = await adoptCanonicalStore(root, request, authorization, { binding })
    expect(result.reason).toBe('Adopted')
    expect(archived(root).migrationId).toBe(journal.migrationId)
    expect(archived(root).adoption?.consumed).toBe(true)
    expect(await adoptCanonicalStore(root, request, authorization, { binding })).toEqual(result)
    await expect(
      adoptCanonicalStore(root, { ...request, manifestHash: '0'.repeat(64) }, authorization, {
        binding,
      })
    ).rejects.toMatchObject({ reason: 'AdoptReplay' })
    for (const candidate of journal.candidates)
      expect(
        fs.existsSync(
          path.join(
            root,
            'state',
            '.canonical-store',
            journal.migrationId,
            'retired',
            candidate.id,
            'state.db'
          )
        )
      ).toBe(true)
  })
  it('exports a validated consistent snapshot and repeats the same retained receipt', async () => {
    const root = fixture()
    const sourceRoot = fixture()
    database(sourceRoot).close()
    const options = {
      root,
      sourcePath: path.join(sourceRoot, 'state.db'),
      exportId: randomUUID(),
      binding,
      maintenanceId: 'maintenance-825',
    }
    const first = await exportCanonicalStore(options)
    expect(await exportCanonicalStore(options)).toEqual(first)
    const changed = new Database(options.sourcePath)
    changed.exec("UPDATE sessions SET title='new accepted state'")
    changed.close()
    await expect(exportCanonicalStore(options)).rejects.toMatchObject({
      reason: 'CandidateChangedDuringMigration',
    })
    const restored = new Database(options.sourcePath)
    restored.exec('UPDATE sessions SET title=NULL')
    restored.close()
    const result = await runMigration(root, { binding })
    expect(result.reason).toBe('SingleCandidate')
    expect((await inspection(root, 'state')).catalogHash).toBe(first.catalogHash)
    expect((await runMigration(root, { binding })).reason).toBe('AlreadyCanonical')
    expect(await exportCanonicalStore(options)).toEqual(first)
  })
})

describe('writer fence', () => {
  it('retains exclusive ownership without TTL and releases only on close', () => {
    const root = fixture()
    const fence = acquireWriterFence({ stateDir: path.join(root, 'state') })
    fence.assertHeld()
    expect(() => acquireWriterFence({ stateDir: path.join(root, 'state'), timeoutMs: 0 })).toThrow(
      'WriterFenceBusy'
    )
    fence.close()
    expect(() => fence.assertHeld()).toThrow('WriterFenceBusy')
    const next = acquireWriterFence({ stateDir: path.join(root, 'state') })
    next.assertHeld()
    next.close()
  })
  it('rejects an independent process until its complete death releases the OS lock', async () => {
    const root = fixture()
    const initial = acquireWriterFence({ stateDir: path.join(root, 'state') })
    initial.close()
    const file = path.join(root, 'state', '.canonical-store', 'writer-fence.db')
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D=require('better-sqlite3');const db=new D(process.argv[1]);db.pragma('journal_mode=DELETE');db.exec('BEGIN EXCLUSIVE');process.stdout.write('held\\n');process.stdin.resume();`,
        file,
      ],
      { cwd: path.resolve(__dirname, '../../../..'), stdio: ['pipe', 'pipe', 'pipe'] }
    )
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fence owner did not start')), 5000)
        child.stdout!.once('data', () => {
          clearTimeout(timeout)
          resolve()
        })
        child.once('error', reject)
        child.once('exit', code => {
          clearTimeout(timeout)
          reject(new Error(`owner exited ${code}`))
        })
      })
      expect(() =>
        acquireWriterFence({ stateDir: path.join(root, 'state'), timeoutMs: 0 })
      ).toThrow('WriterFenceBusy')
      const death = once(child, 'exit')
      child.kill('SIGKILL')
      await death
      const next = acquireWriterFence({ stateDir: path.join(root, 'state'), timeoutMs: 0 })
      next.assertHeld()
      next.close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})

describe('durable crash recovery', () => {
  function cutPort(
    predicate: (name: keyof FsPort, args: unknown[]) => boolean,
    before = false
  ): { port: FsPort; cuts: () => number } {
    let count = 0
    const port = Object.fromEntries(
      Object.entries(nodeFs).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          const cut = count === 0 && predicate(name as keyof FsPort, args)
          if (cut && before) {
            count++
            throw new Error('injected crash')
          }
          const result = (fn as (...args: unknown[]) => unknown)(...args)
          if (cut) {
            count++
            throw new Error('injected crash')
          }
          return result
        },
      ])
    ) as FsPort
    return { port, cuts: () => count }
  }
  it.each([
    [
      'after migrating marker',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'renameSync' && String(args[1]).endsWith(MIGRATING_MARKER),
    ],
    [
      'partial source copy',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'copyFileSync' && String(args[1]).includes('/sources/'),
    ],
    [
      'first sqlite retirement',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'renameSync' && String(args[1]).includes('/retired/'),
    ],
    [
      'promotion',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'renameSync' && String(args[0]).endsWith('/staging/state.db'),
    ],
    [
      'workspace move',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'renameSync' && String(args[1]).endsWith('/workspace/notes.md'),
    ],
    [
      'final marker',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'renameSync' && String(args[1]).endsWith(FINAL_MARKER),
    ],
    [
      'marker receipt',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'renameSync' && String(args[1]).endsWith('/migration-marker.json'),
    ],
    [
      'archive',
      (name: keyof FsPort, args: unknown[]) =>
        name === 'renameSync' && String(args[0]).endsWith('/.canonical-store/journal.json'),
    ],
  ] as const)(
    'recovers %s with the same migration and complete metadata',
    async (_label, predicate) => {
      const root = fixture()
      database(root).close()
      fs.writeFileSync(path.join(root, 'notes.md'), 'note')
      const port = cutPort(predicate)
      await expect(runMigration(root, { binding, fs: port.port })).rejects.toThrow('injected crash')
      expect(port.cuts()).toBe(1)
      const journal = readJournal(root, binding)
      const result = await runMigration(root, { binding })
      expect(['SingleCandidate', 'AlreadyCanonical']).toContain(result.reason)
      const saved = archived(root)
      if (journal) expect(saved.migrationId).toBe(journal.migrationId)
      const marker = JSON.parse(fs.readFileSync(path.join(root, FINAL_MARKER), 'utf8'))
      expect(marker).toEqual({
        markerVersion: 1,
        layoutVersion: 1,
        hostUid: binding.hostUid,
        pvcUid: binding.pvcUid,
        storeId: result.storeId,
        migrationId: saved.migrationId,
      })
      expect(fs.readFileSync(path.join(root, 'workspace', 'notes.md'), 'utf8')).toBe('note')
    }
  )
  it('resets only owned staging after a real partial database remains before staged', async () => {
    const root = fixture()
    database(root).close()
    const port = cutPort((name, args) => name === 'rmSync', true)
    await expect(runMigration(root, { binding, fs: port.port })).rejects.toThrow('injected crash')
    const journal = readJournal(root, binding)!
    expect(journal.phase).toBe('snapshotted')
    const staging = path.join(root, 'state', '.canonical-store', journal.migrationId, 'staging')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(
      path.join(staging, 'state.db'),
      fs.readFileSync(path.join(root, 'state.db')).subarray(0, 71)
    )
    const removals: string[] = []
    const replacement: FsPort = {
      ...nodeFs,
      rmSync(target, options) {
        removals.push(String(target))
        nodeFs.rmSync(target, options)
      },
    }
    await runMigration(root, { binding, fs: replacement })
    expect(removals).toEqual([staging])
    expect(archived(root).stagingSha256).toBe(fileHash(root, path.join(root, 'state', 'state.db')))
  })
})

describe('every SQLite and workspace move boundary', () => {
  const points = ['intent', 'rename', 'source-fsync', 'destination-fsync', 'done'] as const
  const entries = [
    ...['state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal'].map(name => ({
      kind: 'sqlite',
      name,
    })),
    { kind: 'workspace', name: 'a-first' },
    { kind: 'workspace', name: 'z-last' },
    { kind: 'promotion', name: 'state.db' },
  ] as const
  function walFixture(): string {
    const root = fixture()
    const sourceRoot = fixture()
    const db = database(sourceRoot)
    db.pragma('journal_mode=WAL')
    db.pragma('wal_autocheckpoint=0')
    db.prepare(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','wal row',2)"
    ).run()
    fs.mkdirSync(path.join(root, 'state'))
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm'])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(root, 'state', name))
    fs.writeFileSync(path.join(root, 'state', 'state.db-journal'), '')
    db.close()
    for (const name of ['a-first', 'z-last']) {
      fs.mkdirSync(path.join(root, name))
      fs.writeFileSync(path.join(root, name, 'contents'), 'retained bytes')
    }
    return root
  }
  it.each(
    entries.flatMap(entry =>
      points.flatMap(point => [true, false].map(before => [entry, point, before] as const))
    )
  )(
    'recovers %j at %s before=%s',
    async (entry, point, before) => {
      const root = walFixture()
      const fds = new Map<number, string>()
      let moved = false
      let syncs = 0
      let cuts = 0
      const selectedRename = (args: unknown[]) => {
        const from = String(args[0])
        const to = String(args[1])
        if (entry.kind === 'sqlite') return to.endsWith(`/retired/C_state/${entry.name}`)
        if (entry.kind === 'promotion') return from.endsWith('/staging/state.db')
        return to.endsWith(`/workspace/${entry.name}`)
      }
      const port = Object.fromEntries(
        Object.entries(nodeFs).map(([name, fn]) => [
          name,
          (...args: unknown[]) => {
            let selected = false
            if (
              cuts === 0 &&
              name === 'writeFileSync' &&
              (point === 'intent' || point === 'done') &&
              typeof args[1] === 'string'
            ) {
              const data = JSON.parse(args[1]) as MigrationJournal
              const operations = entry.kind === 'workspace' ? data.workspace : data.operations
              selected =
                operations?.some(
                  operation =>
                    operation.kind === entry.kind &&
                    operation.name === entry.name &&
                    operation.state === point &&
                    (entry.kind !== 'sqlite' || operation.candidate === 'C_state')
                ) ?? false
            }
            if (name === 'renameSync' && selectedRename(args)) {
              selected = cuts === 0 && point === 'rename'
              moved = true
            }
            if (
              moved &&
              name === 'fsyncSync' &&
              fds.has(Number(args[0])) &&
              fs.statSync(fds.get(Number(args[0]))!).isDirectory()
            ) {
              syncs++
              selected =
                cuts === 0 &&
                ((point === 'source-fsync' && syncs === 1) ||
                  (point === 'destination-fsync' && syncs === 2))
            }
            if (selected && before) {
              cuts++
              throw new Error('per-operation cut')
            }
            const result = (fn as (...args: unknown[]) => unknown)(...args)
            if (name === 'openSync') fds.set(Number(result), String(args[0]))
            if (name === 'closeSync') fds.delete(Number(args[0]))
            if (selected && !before) {
              cuts++
              throw new Error('per-operation cut')
            }
            return result
          },
        ])
      ) as FsPort
      await expect(runMigration(root, { binding, fs: port })).rejects.toThrow('per-operation cut')
      expect(cuts).toBe(1)
      const migration = readJournal(root, binding)!.migrationId
      const result = await runMigration(root, { binding })
      expect(result.reason).toBe('SingleCandidate')
      expect(archived(root).migrationId).toBe(migration)
      expect(archived(root).phase).toBe('completed')
      const db = new Database(path.join(root, 'state', 'state.db'), {
        readonly: true,
        fileMustExist: true,
      })
      expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 2 })
      db.close()
      for (const name of ['a-first', 'z-last'])
        expect(fs.readFileSync(path.join(root, 'workspace', name, 'contents'), 'utf8')).toBe(
          'retained bytes'
        )
      expect(
        fs.existsSync(
          path.join(
            root,
            'state',
            '.canonical-store',
            migration,
            'retired',
            'C_state',
            'state.db-wal'
          )
        )
      ).toBe(true)
    },
    30000
  )
  it('stops a newly introduced source before retiring any remaining original', async () => {
    const root = fixture()
    database(root).close()
    let cuts = 0
    const port: FsPort = {
      ...nodeFs,
      writeFileSync(file, data, options) {
        const result = nodeFs.writeFileSync(file, data, options)
        if (typeof data === 'string' && JSON.parse(data).phase === 'staged' && cuts++ === 0)
          throw new Error('staged cut')
        return result
      },
    }
    await expect(runMigration(root, { binding, fs: port })).rejects.toThrow('staged cut')
    database(root, 'workspace', false).close()
    const retained = fileHash(root, path.join(root, 'state.db'))
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'ForeignCandidateDuringMigration',
    })
    expect(fileHash(root, path.join(root, 'state.db'))).toBe(retained)
  })
  it('rejects a corrupted derived FTS index while preserving the source', async () => {
    const root = fixture()
    const db = database(root)
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('delete-all')").run()
    db.close()
    const source = fileHash(root, path.join(root, 'state.db'))
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'CandidateCorrupt',
    })
    expect(fileHash(root, path.join(root, 'state.db'))).toBe(source)
  })
  it('blocks cold inspection without a held fence and allows explicit readonly live diagnostics', async () => {
    const root = fixture()
    database(root).close()
    await expect(
      inspectCandidate(root, { root, scratchDir: path.join(root, 'scratch') })
    ).rejects.toMatchObject({ reason: 'WriterFenceBusy' })
    const inspected = await inspectCandidate(root, {
      root,
      scratchDir: path.join(root, 'state', '.canonical-store', 'live'),
      live: true,
    })
    expect(inspected.counts.messages).toBe(1)
    expect(inspected.sourceFiles[0].present).toBe(true)
  })
})

describe('prepared recovery continuity', () => {
  vi.setConfig({ testTimeout: 30000 })
  async function preparedRecovery() {
    const root = fixture()
    database(root).close()
    const original = await runMigration(root, { binding })
    const reconciled = fixture()
    fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(reconciled, 'state.db'))
    const source = new Database(path.join(reconciled, 'state.db'))
    source.exec(`INSERT INTO sessions (id,session_key,source,user_id,team_id,started_at) VALUES ('older','older-key','desktop','u1','t1',0);
      INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('older',1,'user','older retained history',0);`)
    recompute(source)
    source.close()
    const exportId = randomUUID()
    await exportCanonicalStore({
      root,
      sourcePath: path.join(reconciled, 'state.db'),
      exportId,
      binding,
      maintenanceId: 'maintenance-825',
    })
    const pins = await inspectRecovery(root, `C_import:${exportId}`, { binding })
    const request = {
      schemaVersion: 1 as const,
      ...pins,
      requestId: randomUUID(),
      ...binding,
      maintenanceId: 'maintenance-825',
    }
    const authorization = {
      authorized: true as const,
      principal: 'operator',
      ...binding,
      requestId: request.requestId,
      maintenanceId: request.maintenanceId,
    }
    return { root, reconciled, exportId, original, request, authorization }
  }
  it('keeps current accepted writes, ownership, state, approvals and identity while adding prepared history', async () => {
    const fixture = await preparedRecovery()
    await expect(runMigration(fixture.root, { binding })).rejects.toMatchObject({
      reason: 'ForeignCandidateAfterCanonical',
    })
    const result = await beginRecovery(fixture.root, fixture.request, fixture.authorization, {
      binding,
    })
    expect(result).toEqual({
      outcome: 'ok',
      reason: 'Adopted',
      layoutVersion: 1,
      storeId: fixture.original.storeId,
    })
    const db = new Database(path.join(fixture.root, 'state', 'state.db'), { readonly: true })
    expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 2 })
    expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 2 })
    expect(db.prepare('SELECT count(*) AS count FROM pending_approvals').get()).toEqual({
      count: 1,
    })
    db.close()
    expect(
      fs.existsSync(
        path.join(
          fixture.root,
          'state',
          '.canonical-store',
          fixture.request.migrationId,
          'retired',
          'C_state',
          'state.db'
        )
      )
    ).toBe(true)
    expect(
      fs.existsSync(
        path.join(
          fixture.root,
          'state',
          '.canonical-store',
          fixture.request.migrationId,
          'previous-marker.json'
        )
      )
    ).toBe(true)
    expect(
      await beginRecovery(fixture.root, fixture.request, fixture.authorization, { binding })
    ).toEqual(result)
    expect((await runMigration(fixture.root, { binding })).reason).toBe('AlreadyCanonical')
  })
  it.each([
    'DELETE FROM messages WHERE id=1',
    "UPDATE messages SET content='rewritten' WHERE id=1",
    "UPDATE messages SET content_parts='[]' WHERE id=1",
    "UPDATE sessions SET user_id='changed' WHERE id='s1'",
    "UPDATE sessions SET state='changed' WHERE id='s1'",
    "UPDATE sessions SET input_tokens=30 WHERE id='s1'",
    "UPDATE sessions SET model_selections='{}' WHERE id='s1'",
    'DELETE FROM pending_approvals',
    "INSERT INTO pending_approvals SELECT 'resurrected',session_id,task_id,tool_name,tool_call_id,parameters,description,context_snapshot,completed_results,intent_summary,source_message,registered_at,expires_at,trace_context,reason,mcp_server_name,task_budget,authorization_scope FROM pending_approvals",
    "UPDATE sqlite_sequence SET seq=0 WHERE name='messages'",
  ])('blocks lost or changed current state: %s', async sql => {
    const root = fixture()
    database(root).close()
    await runMigration(root, { binding })
    const reconciled = fixture()
    fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(reconciled, 'state.db'))
    const db = new Database(path.join(reconciled, 'state.db'))
    db.exec(sql)
    db.close()
    const exportId = randomUUID()
    await exportCanonicalStore({
      root,
      sourcePath: path.join(reconciled, 'state.db'),
      exportId,
      binding,
      maintenanceId: 'maintenance-825',
    })
    const before = fileHash(root, path.join(root, 'state', 'state.db'))
    await expect(inspectRecovery(root, `C_import:${exportId}`, { binding })).rejects.toMatchObject({
      reason: 'CandidateIncomplete',
    })
    expect(fileHash(root, path.join(root, 'state', 'state.db'))).toBe(before)
    expect(fs.existsSync(path.join(root, 'state', '.canonical-store', 'journal.json'))).toBe(false)
  })
  it('rejects stale current-catalog pins before starting any recovery journal', async () => {
    const f = await preparedRecovery()
    const db = new Database(path.join(f.root, 'state', 'state.db'))
    db.exec("UPDATE sessions SET title='accepted later state'")
    db.close()
    await expect(
      beginRecovery(f.root, f.request, f.authorization, { binding })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    expect(fs.existsSync(path.join(f.root, 'state', '.canonical-store', 'journal.json'))).toBe(
      false
    )
  })
  it('recovers an interrupted previous-marker rename without discarding the old binding', async () => {
    const f = await preparedRecovery()
    let cuts = 0
    const port: FsPort = {
      ...nodeFs,
      renameSync(source, destination) {
        nodeFs.renameSync(source, destination)
        if (String(destination).endsWith('/previous-marker.json') && cuts++ === 0)
          throw new Error('previous marker cut')
      },
    }
    await expect(
      beginRecovery(f.root, f.request, f.authorization, { binding, fs: port })
    ).rejects.toThrow('previous marker cut')
    const result = await beginRecovery(f.root, f.request, f.authorization, { binding })
    expect(result.storeId).toBe(f.original.storeId)
    expect(JSON.parse(fs.readFileSync(path.join(f.root, FINAL_MARKER), 'utf8')).migrationId).toBe(
      f.request.migrationId
    )
  })
  it('groups historical WAL backups by suffix and only exports the explicitly authorized complete set', async () => {
    const root = fixture()
    const sourceRoot = fixture()
    const source = database(sourceRoot)
    source.pragma('journal_mode=WAL')
    source.pragma('wal_autocheckpoint=0')
    source
      .prepare(
        "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','historic wal',2)"
      )
      .run()
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm'])
      fs.copyFileSync(path.join(sourceRoot, name), path.join(root, `${name}.pre-historical.bak`))
    source.close()
    const backups = discoverBackupSets(root)
    expect(backups).toHaveLength(1)
    expect(backups[0].complete).toBe(true)
    await expect(runMigration(root, { binding, provenance })).rejects.toMatchObject({
      reason: 'SourceExportRequired',
    })
    const exportId = randomUUID()
    const options = {
      root,
      binding,
      exportId,
      location: 'root' as const,
      suffix: 'historical',
      sourceHash: backups[0].sourceHash,
      authorization: {
        authorized: true as const,
        principal: 'operator',
        ...binding,
        requestId: exportId,
        maintenanceId: 'maintenance-825',
      },
    }
    const manifest = await exportHistoricalBackup(options)
    expect(discoverBackupSets(root)[0].sourceHash).toBe(backups[0].sourceHash)
    expect(manifest.catalogHash).toBeDefined()
    // A previous blocked creation must be resumed only within its own durable manifest; it is never replaced here.
    expect(fs.existsSync(path.join(root, 'state.db.pre-historical.bak'))).toBe(true)
  })
})

describe('exact persisted SQLite types and bytes', () => {
  it('distinguishes malformed UTF-8 TEXT bytes which decode to the same JavaScript replacement text', async () => {
    const root = fixture()
    database(root).close()
    fs.mkdirSync(path.join(root, 'state'))
    fs.copyFileSync(path.join(root, 'state.db'), path.join(root, 'state', 'state.db'))
    const one = new Database(path.join(root, 'state.db'))
    one.exec("UPDATE messages SET content=CAST(x'FF' AS TEXT)")
    one.close()
    const two = new Database(path.join(root, 'state', 'state.db'))
    two.exec("UPDATE messages SET content=CAST(x'FE' AS TEXT)")
    two.close()
    const a = await inspection(root)
    const b = await inspection(root, 'state')
    expect(a.catalogHash).not.toBe(b.catalogHash)
    await expect(runMigration(root, { binding })).rejects.toMatchObject({
      reason: 'DivergentCandidates',
    })
  })
  it('preserves integer precision above the JavaScript safe-integer limit', async () => {
    const root = fixture()
    const db = database(root)
    db.exec(
      "UPDATE messages SET id=9007199254740999;UPDATE sqlite_sequence SET seq=9007199254740999 WHERE name='messages'"
    )
    db.close()
    const before = await inspection(root)
    await runMigration(root, { binding })
    const after = await inspection(root, 'state')
    expect(after.catalogHash).toBe(before.catalogHash)
    const actual = new Database(path.join(root, 'state', 'state.db'))
    expect(actual.prepare('SELECT id FROM messages').safeIntegers().get()).toEqual({
      id: 9007199254740999n,
    })
    actual.close()
  })
})

describe('SQLite sidecar confinement', () => {
  it('rejects a live DB symlink and live/export sidecar aliases before SQLite opens them', async () => {
    const root = fixture()
    const outside = fixture()
    database(outside).close()
    fs.symlinkSync(path.join(outside, 'state.db'), path.join(root, 'state.db'))
    await expect(
      inspectCandidate(root, {
        root,
        scratchDir: path.join(root, 'state', '.canonical-store', 'inspect'),
        live: true,
      })
    ).rejects.toMatchObject({ reason: 'LayoutUnsafe' })
    fs.unlinkSync(path.join(root, 'state.db'))
    database(root).close()
    fs.symlinkSync(path.join(outside, 'state.db'), path.join(root, 'state.db-wal'))
    await expect(
      inspectCandidate(root, {
        root,
        scratchDir: path.join(root, 'state', '.canonical-store', 'inspect'),
        live: true,
      })
    ).rejects.toMatchObject({ reason: 'LayoutUnsafe' })
    await expect(
      exportCanonicalStore({
        root: fixture(),
        sourcePath: path.join(root, 'state.db'),
        exportId: randomUUID(),
        binding,
        maintenanceId: 'maintenance-825',
      })
    ).rejects.toMatchObject({ reason: 'LayoutUnsafe' })
  })
})

describe('audit regression proofs', () => {
  // These compositional tests exercise durable real filesystem flushes and multiple SQLite transitions.
  vi.setConfig({ testTimeout: 30000 })
  async function recoveryFixture() {
    const root = fixture()
    database(root).close()
    const original = await runMigration(root, { binding })
    const sourceRoot = fixture()
    fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(sourceRoot, 'state.db'))
    const source = new Database(path.join(sourceRoot, 'state.db'))
    source.exec(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp,turn_number) VALUES ('s1',0,'user','historical same-session message',0,3)"
    )
    recompute(source)
    source.close()
    const exportId = randomUUID()
    await exportCanonicalStore({
      root,
      sourcePath: path.join(sourceRoot, 'state.db'),
      exportId,
      binding,
      maintenanceId: 'maintenance-825',
    })
    const pins = await inspectRecovery(root, `C_import:${exportId}`, { binding })
    const request = {
      schemaVersion: 1 as const,
      ...pins,
      requestId: randomUUID(),
      ...binding,
      maintenanceId: 'maintenance-825',
    }
    const authorization = {
      authorized: true as const,
      principal: 'operator',
      ...binding,
      requestId: request.requestId,
      maintenanceId: request.maintenanceId,
    }
    return { root, sourceRoot, exportId, request, authorization, original }
  }
  it('continues an exact crash after started becomes durable, before snapshot or marker creation', async () => {
    const f = await recoveryFixture()
    let cuts = 0
    const port: FsPort = {
      ...nodeFs,
      renameSync(from, to) {
        nodeFs.renameSync(from, to)
        if (
          String(to).endsWith('/.canonical-store/journal.json') &&
          JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'started' &&
          cuts++ === 0
        )
          throw new Error('exact started cut')
      },
    }
    await expect(
      beginRecovery(f.root, f.request, f.authorization, { binding, fs: port })
    ).rejects.toThrow('exact started cut')
    const started = readJournal(f.root, binding)!
    expect(started.phase).toBe('started')
    expect(started.selected).toBe(`C_import:${f.exportId}`)
    expect(started.decision).toBe('Adopted')
    expect(started.candidates).toEqual([])
    const result = await beginRecovery(f.root, f.request, f.authorization, { binding })
    expect(result.storeId).toBe(f.original.storeId)
    expect(JSON.parse(fs.readFileSync(path.join(f.root, FINAL_MARKER), 'utf8')).migrationId).toBe(
      f.request.migrationId
    )
  })
  it('rejects a consumed requestId reused for a new migration and fresh source pins', async () => {
    const f = await recoveryFixture()
    await beginRecovery(f.root, f.request, f.authorization, { binding })
    const sourceRoot = fixture()
    fs.copyFileSync(path.join(f.root, 'state', 'state.db'), path.join(sourceRoot, 'state.db'))
    const exportId = randomUUID()
    await exportCanonicalStore({
      root: f.root,
      sourcePath: path.join(sourceRoot, 'state.db'),
      exportId,
      binding,
      maintenanceId: f.request.maintenanceId,
    })
    const pins = await inspectRecovery(f.root, `C_import:${exportId}`, { binding })
    const reused = { ...f.request, ...pins }
    await expect(beginRecovery(f.root, reused, f.authorization, { binding })).rejects.toMatchObject(
      { reason: 'AdoptReplay' }
    )
    expect(fs.existsSync(path.join(f.root, 'state', '.canonical-store', pins.migrationId))).toBe(
      false
    )
  })
  it('has zero business/history hash-byte reads during stable boot after imports and later writes', async () => {
    const f = await recoveryFixture()
    await beginRecovery(f.root, f.request, f.authorization, { binding })
    const db = new Database(path.join(f.root, 'state', 'state.db'))
    db.exec(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','accepted after recovery',2)"
    )
    db.close()
    const witness = vi.spyOn(nodeFs, 'readSync')
    expect((await runMigration(f.root, { binding })).reason).toBe('AlreadyCanonical')
    expect(witness).not.toHaveBeenCalled()
  })
  it('synchronizes each newly created directory and containing parent before creating its descendant', () => {
    const root = fixture()
    const events: Array<{ kind: string; path: string }> = []
    const fds = new Map<number, string>()
    const port: FsPort = {
      ...nodeFs,
      mkdirSync(directory, options) {
        const result = nodeFs.mkdirSync(directory, options)
        events.push({ kind: 'mkdir', path: String(directory) })
        return result
      },
      openSync(file, flags, mode) {
        const fd = nodeFs.openSync(file, flags, mode)
        fds.set(fd, String(file))
        return fd
      },
      fsyncSync(fd) {
        nodeFs.fsyncSync(fd)
        events.push({ kind: 'sync', path: fds.get(fd)! })
      },
      closeSync(fd) {
        fds.delete(fd)
        nodeFs.closeSync(fd)
      },
    }
    const destination = path.join(
      root,
      'state',
      '.canonical-store',
      randomUUID(),
      'retired',
      'C_root'
    )
    privateDirectory(root, destination, port)
    const created = events.filter(event => event.kind === 'mkdir')
    expect(created).toHaveLength(5)
    for (let index = 0; index < created.length; index++) {
      const position = events.findIndex(event => event === created[index])
      const beforeNext =
        index + 1 < created.length
          ? events.findIndex(event => event === created[index + 1])
          : events.length
      const interval = events.slice(position + 1, beforeNext)
      expect(interval).toContainEqual({ kind: 'sync', path: created[index].path })
      expect(interval).toContainEqual({ kind: 'sync', path: path.dirname(created[index].path) })
    }
  })
  it('permits only verified summaries for a union adding history to an existing session', async () => {
    const f = await recoveryFixture()
    const result = await beginRecovery(f.root, f.request, f.authorization, { binding })
    expect(result.storeId).toBe(f.original.storeId)
    const db = new Database(path.join(f.root, 'state', 'state.db'), { readonly: true })
    expect(
      db
        .prepare("SELECT message_count,turn_count,last_activity_at FROM sessions WHERE id='s1'")
        .get()
    ).toEqual({ message_count: 2, turn_count: 1, last_activity_at: 1 })
    db.close()
  })
  it('preserves a current activity watermark above all stored message timestamps', async () => {
    const root = fixture()
    const db = database(root)
    db.exec("UPDATE sessions SET last_activity_at=100 WHERE id='s1'")
    db.close()
    await runMigration(root, { binding })
    const sourceRoot = fixture()
    fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(sourceRoot, 'state.db'))
    const source = new Database(path.join(sourceRoot, 'state.db'))
    source.exec(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',0,'user','older',0)"
    )
    recompute(source)
    source.close()
    const exportId = randomUUID()
    await exportCanonicalStore({
      root,
      sourcePath: path.join(sourceRoot, 'state.db'),
      exportId,
      binding,
      maintenanceId: 'maintenance-825',
    })
    expect(
      (await inspectRecovery(root, `C_import:${exportId}`, { binding })).expectedStoreId
    ).toBeDefined()
    const badSourceRoot = fixture()
    fs.copyFileSync(path.join(sourceRoot, 'state.db'), path.join(badSourceRoot, 'state.db'))
    const bad = new Database(path.join(badSourceRoot, 'state.db'))
    bad.exec('UPDATE sessions SET last_activity_at=1')
    bad.close()
    // Validate the selected prepared source directly, without adding a second import to this operation.
    const { validateRecoveryContinuity } = await import('../recoveryContinuity')
    const current = new Database(path.join(root, 'state', 'state.db'), { readonly: true })
    const candidate = new Database(path.join(badSourceRoot, 'state.db'), { readonly: true })
    expect(() => validateRecoveryContinuity(current, candidate)).toThrow('Recovery cannot prove')
    current.close()
    candidate.close()
  })
  it('moves similarly named notes and blocks unidentified SQLite data before any retirement', async () => {
    const root = fixture()
    database(root).close()
    fs.writeFileSync(path.join(root, 'state.db-notes.md'), 'ordinary user notes')
    await runMigration(root, { binding })
    expect(fs.readFileSync(path.join(root, 'workspace', 'state.db-notes.md'), 'utf8')).toBe(
      'ordinary user notes'
    )
    const blocked = fixture()
    database(blocked).close()
    fs.copyFileSync(path.join(blocked, 'state.db'), path.join(blocked, 'state.db-unregistered.tmp'))
    await expect(runMigration(blocked, { binding })).rejects.toMatchObject({
      reason: 'CandidateIncomplete',
    })
    expect(fs.existsSync(path.join(blocked, 'state.db'))).toBe(true)
  })
  it('diagnoses a readonly source using external scratch without creating a fence or state directory', async () => {
    const root = fixture()
    database(root).close()
    const scratchRoot = fixture()
    const before = fileHash(root, path.join(root, 'state.db'))
    fs.chmodSync(path.join(root, 'state.db'), 0o444)
    fs.chmodSync(root, 0o555)
    try {
      const { runCli } = await import('../cli')
      const result = await runCli([
        'inspect',
        '--root',
        root,
        '--host-uid',
        binding.hostUid,
        '--pvc-uid',
        binding.pvcUid,
        '--scratch-root',
        scratchRoot,
      ])
      expect(result.exitCode).toBe(0)
      expect(fs.readdirSync(root)).toEqual(['state.db'])
      expect(fileHash(root, path.join(root, 'state.db'))).toBe(before)
      expect(fs.readdirSync(path.join(scratchRoot, '.canonical-store-inspection'))).toEqual([])
    } finally {
      fs.chmodSync(root, 0o700)
      fs.chmodSync(path.join(root, 'state.db'), 0o600)
    }
  })
  it('disposes inspection and repeated-export scratch without removing published or retained source evidence', async () => {
    const root = fixture()
    database(root).close()
    const fence = acquireWriterFence({ stateDir: path.join(root, 'state') })
    const result = await inspectCandidate(root, {
      root,
      scratchDir: path.join(root, 'state', '.canonical-store', 'disposable'),
      fence,
    })
    expect(fs.existsSync(result.normalizedPath)).toBe(true)
    result.dispose()
    expect(fs.existsSync(result.normalizedPath)).toBe(false)
    fence.close()
    expect(fs.existsSync(path.join(root, 'state.db'))).toBe(true)
    const destination = fixture()
    const exportId = randomUUID()
    const options = {
      root: destination,
      sourcePath: path.join(root, 'state.db'),
      exportId,
      binding,
      maintenanceId: 'maintenance-825',
    }
    await exportCanonicalStore(options)
    await exportCanonicalStore(options)
    const stage = path.join(destination, 'state', '.canonical-store', `export-${exportId}`)
    expect(fs.readdirSync(stage).filter(entry => /^[0-9a-f-]{36}$/i.test(entry))).toEqual([])
    expect(fs.readdirSync(path.join(stage, 'validation'))).toEqual([])
    expect(
      fs.existsSync(path.join(destination, '.canonical-store-import', exportId, 'state.db'))
    ).toBe(true)
  })
  it('recovers a real migration process killed immediately after a SQLite retirement rename', async () => {
    const root = fixture()
    database(root).close()
    fs.writeFileSync(path.join(root, 'notes.md'), 'retained')
    const compilation = fixture()
    const mcpRoot = path.resolve(__dirname, '../../../..')
    execFileSync(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        path.join(mcpRoot, 'src', 'db', 'canonicalStore', 'index.ts'),
        '--target',
        'ES2022',
        '--module',
        'commonjs',
        '--esModuleInterop',
        '--strict',
        '--skipLibCheck',
        '--types',
        'node',
        '--rootDir',
        path.join(mcpRoot, 'src'),
        '--outDir',
        compilation,
      ],
      { cwd: mcpRoot, stdio: 'pipe', timeout: 20000 }
    )
    const code = `const fs=require('fs');const {runMigration,nodeFs}=require(process.argv[1]);
      const port={...nodeFs,renameSync(from,to){nodeFs.renameSync(from,to);if(to.includes('/retired/C_root/state.db')){
        fs.writeSync(1,'retired\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}};
      runMigration(process.argv[2],{binding:{hostUid:'host-825',pvcUid:'pvc-825'},fs:port}).catch(()=>process.exit(1));`
    const child = spawn(
      process.execPath,
      ['-e', code, path.join(compilation, 'db', 'canonicalStore', 'index.js'), root],
      {
        cwd: mcpRoot,
        env: { ...process.env, NODE_PATH: path.join(mcpRoot, 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('migration did not reach the actual retirement barrier')),
          5000
        )
        child.stdout!.once('data', () => {
          clearTimeout(timeout)
          resolve()
        })
        child.once('error', reject)
        child.once('exit', code => {
          clearTimeout(timeout)
          reject(new Error(`migration exited early ${code}`))
        })
      })
      const identity = readJournal(root, binding)!.migrationId
      const death = once(child, 'exit')
      child.kill('SIGKILL')
      await death
      expect(fs.existsSync(path.join(root, 'state.db'))).toBe(false)
      expect((await runMigration(root, { binding })).reason).toBe('SingleCandidate')
      expect(archived(root).migrationId).toBe(identity)
      expect(fs.readFileSync(path.join(root, 'workspace', 'notes.md'), 'utf8')).toBe('retained')
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill('SIGKILL')
        await exit
      }
    }
  }, 30000)
})

it('does not discard an empty-looking lineage that retains AUTOINCREMENT continuity', async () => {
  const root = fixture()
  database(root).close()
  const other = database(root, 'state')
  other.exec(
    "DELETE FROM pending_approvals;DELETE FROM messages;DELETE FROM sessions;UPDATE sqlite_sequence SET seq=100 WHERE name='messages'"
  )
  other.close()
  await expect(runMigration(root, { binding })).rejects.toMatchObject({
    reason: 'DivergentCandidates',
  })
  expect(fs.existsSync(path.join(root, 'state', 'state.db'))).toBe(true)
})

it('does not regenerate a missing canonical marker by starting a new ordinary lineage transition', async () => {
  const root = fixture()
  database(root).close()
  const first = await runMigration(root, { binding })
  const original = fileHash(root, path.join(root, 'state', 'state.db'))
  fs.unlinkSync(path.join(root, FINAL_MARKER))
  await expect(runMigration(root, { binding })).rejects.toMatchObject({ reason: 'MarkerMismatch' })
  expect(fileHash(root, path.join(root, 'state', 'state.db'))).toBe(original)
  expect(readJournal(root, binding)?.operations).toEqual([])
  const db = new Database(path.join(root, 'state', 'state.db'), { readonly: true })
  expect(db.prepare('SELECT store_id FROM canonical_store_identity').get()).toEqual({
    store_id: first.storeId,
  })
  db.close()
})

it('repeats directory and parent durability after a cut left an existing but unsynchronized name', () => {
  const root = fixture()
  const fds = new Map<number, string>()
  let cut = false
  const cutting: FsPort = {
    ...nodeFs,
    openSync(file, flags, mode) {
      const fd = nodeFs.openSync(file, flags, mode)
      fds.set(fd, String(file))
      return fd
    },
    fsyncSync(fd) {
      if (!cut && fds.get(fd) === root) {
        cut = true
        throw new Error('parent sync cut')
      }
      nodeFs.fsyncSync(fd)
    },
    closeSync(fd) {
      fds.delete(fd)
      nodeFs.closeSync(fd)
    },
  }
  expect(() =>
    privateDirectory(root, path.join(root, 'state', '.canonical-store'), cutting)
  ).toThrow('parent sync cut')
  expect(fs.existsSync(path.join(root, 'state'))).toBe(true)
  const events: string[] = []
  const resumed: FsPort = {
    ...nodeFs,
    mkdirSync(directory, options) {
      events.push(`mkdir:${directory}`)
      return nodeFs.mkdirSync(directory, options)
    },
    openSync(file, flags, mode) {
      const fd = nodeFs.openSync(file, flags, mode)
      fds.set(fd, String(file))
      return fd
    },
    fsyncSync(fd) {
      events.push(`sync:${fds.get(fd)}`)
      nodeFs.fsyncSync(fd)
    },
    closeSync(fd) {
      fds.delete(fd)
      nodeFs.closeSync(fd)
    },
  }
  privateDirectory(root, path.join(root, 'state', '.canonical-store'), resumed)
  expect(events.indexOf(`sync:${path.join(root, 'state')}`)).toBeLessThan(
    events.indexOf(`mkdir:${path.join(root, 'state', '.canonical-store')}`)
  )
  expect(events.indexOf(`sync:${root}`)).toBeLessThan(
    events.indexOf(`mkdir:${path.join(root, 'state', '.canonical-store')}`)
  )
})

it('reads non-checkpointed WAL from a readonly source set using external writable scratch', async () => {
  const sourceRoot = fixture()
  const source = database(sourceRoot)
  source.pragma('journal_mode=WAL')
  source.pragma('wal_autocheckpoint=0')
  source.exec(
    "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','readonly WAL row',2)"
  )
  recompute(source)
  const root = fixture()
  const scratchRoot = fixture()
  for (const name of ['state.db', 'state.db-wal', 'state.db-shm']) {
    fs.copyFileSync(path.join(sourceRoot, name), path.join(root, name))
    fs.chmodSync(path.join(root, name), 0o444)
  }
  source.close()
  const before = fileHash(root, path.join(root, 'state.db'))
  fs.chmodSync(root, 0o555)
  try {
    const result = await inspectCandidate(root, {
      root,
      scratchRoot,
      scratchDir: path.join(scratchRoot, 'inspection'),
      live: true,
    })
    expect(result.counts.messages).toBe(2)
    result.dispose()
    expect(fileHash(root, path.join(root, 'state.db'))).toBe(before)
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false)
    expect(fs.readdirSync(path.join(scratchRoot, 'inspection'))).toEqual([])
  } finally {
    fs.chmodSync(root, 0o700)
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm'])
      if (fs.existsSync(path.join(root, name))) fs.chmodSync(path.join(root, name), 0o600)
  }
})

describe('final Astra allocation and timestamp regressions', () => {
  async function fixtureRecovery() {
    const root = fixture()
    database(root).close()
    await runMigration(root, { binding })
    const sourceRoot = fixture()
    fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(sourceRoot, 'state.db'))
    const exportId = randomUUID()
    await exportCanonicalStore({
      root,
      sourcePath: path.join(sourceRoot, 'state.db'),
      exportId,
      binding,
      maintenanceId: 'maintenance-825',
    })
    const pins = await inspectRecovery(root, `C_import:${exportId}`, { binding })
    const request = {
      schemaVersion: 1 as const,
      ...pins,
      ...binding,
      requestId: randomUUID(),
      maintenanceId: 'maintenance-825',
    }
    const authorization = {
      ...binding,
      authorized: true as const,
      principal: 'operator',
      requestId: request.requestId,
      maintenanceId: request.maintenanceId,
    }
    return { root, sourceRoot, exportId, request, authorization }
  }
  it.each(['existing', 'new'])(
    'rejects invented activity in %s sessions, preserving exact accepted watermark',
    async kind => {
      const root = fixture()
      const current = database(root)
      current.exec("UPDATE sessions SET last_activity_at=100 WHERE id='s1'")
      current.close()
      const candidateRoot = fixture()
      fs.copyFileSync(path.join(root, 'state.db'), path.join(candidateRoot, 'state.db'))
      const candidate = new Database(path.join(candidateRoot, 'state.db'))
      const { validateRecoveryContinuity } = await import('../recoveryContinuity')
      const intact = new Database(path.join(root, 'state.db'), { readonly: true })
      expect(() => validateRecoveryContinuity(intact, candidate)).not.toThrow()
      if (kind === 'existing')
        candidate.exec("UPDATE sessions SET last_activity_at=1e30 WHERE id='s1'")
      else
        candidate.exec(
          "INSERT INTO sessions (id,session_key,source,user_id,team_id,started_at,last_activity_at) VALUES ('new','new-key','desktop','u1','t1',0,1e30)"
        )
      expect(() => validateRecoveryContinuity(intact, candidate)).toThrow('Recovery cannot prove')
      if (kind === 'existing')
        candidate.exec("UPDATE sessions SET last_activity_at=100 WHERE id='s1'")
      else candidate.exec("UPDATE sessions SET last_activity_at=0 WHERE id='new'")
      expect(() => validateRecoveryContinuity(intact, candidate)).not.toThrow()
      if (kind === 'existing')
        candidate.exec("UPDATE sessions SET last_activity_at=99 WHERE id='s1'")
      else candidate.exec("UPDATE sessions SET last_activity_at=-1 WHERE id='new'")
      expect(() => validateRecoveryContinuity(intact, candidate)).toThrow('Recovery cannot prove')
      intact.close()
      candidate.close()
    }
  )
  it.each([
    'intent-before-rename',
    'intent-after-rename',
    'before-mkdir',
    'after-mkdir',
    'after-self-fsync',
    'after-parent-fsync',
    'before-done-write',
    'after-done-rename',
  ])(
    'resumes an allocation cut at %s without adopting unknown directory or allowing changed pins',
    async point => {
      const f = await fixtureRecovery()
      const directory = path.join(f.root, 'state', '.canonical-store', f.request.migrationId)
      const fds = new Map<number, string>()
      let cuts = 0
      const active = path.join(f.root, 'state', '.canonical-store', 'journal.json')
      const crash = () => {
        cuts++
        throw new Error('allocation cut')
      }
      const port: FsPort = {
        ...nodeFs,
        openSync(file, flags, mode) {
          const fd = nodeFs.openSync(file, flags, mode)
          fds.set(fd, String(file))
          return fd
        },
        closeSync(fd) {
          fds.delete(fd)
          nodeFs.closeSync(fd)
        },
        mkdirSync(file, options) {
          if (!cuts && String(file) === directory && point === 'before-mkdir') crash()
          const result = nodeFs.mkdirSync(file, options)
          if (!cuts && String(file) === directory && point === 'after-mkdir') crash()
          return result
        },
        fsyncSync(fd) {
          nodeFs.fsyncSync(fd)
          if (cuts || !fs.existsSync(active) || !fs.existsSync(directory)) return
          const journal = JSON.parse(fs.readFileSync(active, 'utf8')) as MigrationJournal
          if (journal.allocation?.state !== 'intent') return
          if (point === 'after-self-fsync' && fds.get(fd) === directory) crash()
          if (point === 'after-parent-fsync' && fds.get(fd) === path.dirname(directory)) crash()
        },
        writeFileSync(file, data, options) {
          if (
            !cuts &&
            point === 'before-done-write' &&
            typeof data === 'string' &&
            JSON.parse(data).allocation?.state === 'done'
          )
            crash()
          return nodeFs.writeFileSync(file, data, options)
        },
        renameSync(from, to) {
          const publishing = String(to) === active
          const staged = publishing
            ? (JSON.parse(fs.readFileSync(from, 'utf8')) as MigrationJournal)
            : undefined
          if (!cuts && point === 'intent-before-rename' && staged?.allocation?.state === 'intent')
            crash()
          nodeFs.renameSync(from, to)
          if (!cuts && point === 'intent-after-rename' && staged?.allocation?.state === 'intent')
            crash()
          if (!cuts && point === 'after-done-rename' && staged?.allocation?.state === 'done')
            crash()
        },
      }
      await expect(
        beginRecovery(f.root, f.request, f.authorization, { binding, fs: port })
      ).rejects.toThrow('allocation cut')
      expect(cuts).toBe(1)
      if (fs.existsSync(active)) {
        await expect(
          beginRecovery(f.root, { ...f.request, manifestHash: '0'.repeat(64) }, f.authorization, {
            binding,
          })
        ).rejects.toMatchObject({ reason: 'AdoptReplay' })
        expect(readJournal(f.root, binding)?.phase).toBe('started')
      } else {
        expect(fs.existsSync(directory)).toBe(false)
        await expect(
          beginRecovery(f.root, { ...f.request, manifestHash: '0'.repeat(64) }, f.authorization, {
            binding,
          })
        ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
        expect(fs.existsSync(active)).toBe(false)
      }
      expect((await beginRecovery(f.root, f.request, f.authorization, { binding })).reason).toBe(
        'Adopted'
      )
      const final = JSON.parse(
        fs.readFileSync(path.join(directory, 'journal.json'), 'utf8')
      ) as MigrationJournal
      expect(final.migrationId).toBe(f.request.migrationId)
      expect(final.allocation?.state).toBe('done')
      expect(final.allocation?.identity).toEqual({
        dev: fs.statSync(directory).dev,
        ino: fs.statSync(directory).ino,
      })
    }
  )
  it('does not adopt even an empty preexisting migration directory without a durable allocation intent', async () => {
    const f = await fixtureRecovery()
    const directory = path.join(f.root, 'state', '.canonical-store', f.request.migrationId)
    fs.mkdirSync(directory, { mode: 0o700 })
    await expect(
      beginRecovery(f.root, f.request, f.authorization, { binding })
    ).rejects.toMatchObject({ reason: 'MigrationIdCollision' })
    expect(fs.readdirSync(directory)).toEqual([])
    expect(readJournal(f.root, binding)).toBeUndefined()
  })
  it('rejects a nonempty directory during a reserved allocation without deleting its contents', async () => {
    const f = await fixtureRecovery()
    const directory = path.join(f.root, 'state', '.canonical-store', f.request.migrationId)
    let cut = false
    const port: FsPort = {
      ...nodeFs,
      mkdirSync(file, options) {
        const result = nodeFs.mkdirSync(file, options)
        if (!cut && String(file) === directory) {
          cut = true
          throw new Error('allocation mkdir cut')
        }
        return result
      },
    }
    await expect(
      beginRecovery(f.root, f.request, f.authorization, { binding, fs: port })
    ).rejects.toThrow('allocation mkdir cut')
    fs.writeFileSync(path.join(directory, 'unknown.txt'), 'unknown evidence')
    await expect(
      beginRecovery(f.root, f.request, f.authorization, { binding })
    ).rejects.toMatchObject({ reason: 'FileMoveConflict' })
    expect(fs.readFileSync(path.join(directory, 'unknown.txt'), 'utf8')).toBe('unknown evidence')
  })
  it('blocks pending root relocation before starting a recovery journal', async () => {
    const f = await fixtureRecovery()
    fs.writeFileSync(path.join(f.root, 'extra.txt'), 'unrelocated')
    await expect(
      beginRecovery(f.root, f.request, f.authorization, { binding })
    ).rejects.toMatchObject({ reason: 'WorkspaceEntryCollision' })
    expect(readJournal(f.root, binding)).toBeUndefined()
    expect(
      fs.existsSync(path.join(f.root, 'state', '.canonical-store', f.request.migrationId))
    ).toBe(false)
    expect(fs.readFileSync(path.join(f.root, 'extra.txt'), 'utf8')).toBe('unrelocated')
  })
  it('rejects root request JSON before any journal and accepts the same request from reserved metadata', async () => {
    const f = await fixtureRecovery()
    const requestFile = path.join(f.root, 'request.json')
    fs.writeFileSync(requestFile, JSON.stringify(f.request))
    const { runCli } = await import('../cli')
    const args = [
      'adopt',
      '--root',
      f.root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--maintenance-id',
      f.request.maintenanceId,
      '--operator-authorized',
      '--operator-principal',
      'operator',
      '--request',
      requestFile,
    ]
    await expect(runCli(args)).rejects.toMatchObject({ reason: 'LayoutUnsafe' })
    expect(readJournal(f.root, binding)).toBeUndefined()
    const reserved = path.join(
      f.root,
      'state',
      '.canonical-store',
      'requests',
      `${f.request.requestId}.json`
    )
    fs.mkdirSync(path.dirname(reserved), { recursive: true, mode: 0o700 })
    fs.renameSync(requestFile, reserved)
    args[args.length - 1] = reserved
    expect(
      (await runCli(args, cliAdoptionBoundary(f.root, f.request, f.authorization))).exitCode
    ).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(f.root, FINAL_MARKER), 'utf8')).migrationId).toBe(
      f.request.migrationId
    )
  })
})

describe('operator physical proof commands', () => {
  async function bootstrapFixture() {
    const root = fixture()
    const sourceRoot = fixture()
    database(sourceRoot).close()
    const scratchRoot = fixture()
    const exportId = randomUUID()
    const maintenanceId = 'maintenance-825'
    const manifest = await exportCanonicalStore({
      root,
      sourcePath: path.join(sourceRoot, 'state.db'),
      exportId,
      binding,
      maintenanceId,
    })
    const directory = path.join(root, '.canonical-store-bootstrap', exportId)
    fs.mkdirSync(path.join(directory, 'sources'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'backups'))
    fs.copyFileSync(path.join(sourceRoot, 'state.db'), path.join(directory, 'sources', 'state.db'))
    const sourceFiles = fingerprints(root, path.join(directory, 'sources'))
    const receipt = {
      receiptVersion: 1,
      exportId,
      requestId: randomUUID(),
      maintenanceId,
      ...binding,
      sourcePodUid: randomUUID(),
      sourceMode: 'sqlite',
      manifestHash: objectHash(manifest),
      catalogHash: manifest.catalogHash,
      sourceSchemaVersion: manifest.sourceSchemaVersion,
      sourceFiles,
      sourceSnapshotHash: objectHash(sourceFiles),
      sourceBackups: [],
      backupSnapshotHash: objectHash([]),
      closedWriter: {
        pid: 100,
        startTimeTicks: '1000',
        uid: 1001,
        argvHash: objectHash(['node', 'main.js']),
        supervisorPid: 99,
        supervisorStartTimeTicks: '900',
        mainSha256: objectHash('fixture-main'),
        supervisorSha256: objectHash('fixture-supervisor'),
      },
      closedWitnessHash: objectHash({ fixture: 'closure-document' }),
      runtimeClosureHash: objectHash({ fixture: 'runtime-document' }),
    }
    fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt))
    return { root, sourceRoot, scratchRoot, exportId, maintenanceId, manifest, receipt, directory }
  }
  it('verifies retained bootstrap sources and export catalog without asserting writer death', async () => {
    const f = await bootstrapFixture()
    const { verifyPreparation } = await import('../verification')
    const result = await verifyPreparation('sqlite-external-exported', {
      ...f,
      binding,
      expectedManifestHash: f.receipt.manifestHash,
    })
    expect(result.sourceHash).toBe(objectHash(f.manifest.files))
    expect(result.sourceSnapshotHash).toBe(f.receipt.sourceSnapshotHash)
    expect(result.catalogHash).toBe(f.manifest.catalogHash)
    expect(result.bootstrapRequestId).toBe(f.receipt.requestId)
    expect(Object.keys(result).some(key => /writer.*dead|writerStopped/i.test(key))).toBe(false)
    expect(
      fs.readdirSync(path.join(f.scratchRoot, '.canonical-store-bootstrap-verification'))
    ).toEqual([])
  })
  it('blocks tampered retained raw source and a mismatched maintenance binding', async () => {
    const f = await bootstrapFixture()
    const { verifyPreparation } = await import('../verification')
    await expect(
      verifyPreparation('sqlite-external-exported', { ...f, binding, maintenanceId: 'different' })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    fs.appendFileSync(path.join(f.directory, 'sources', 'state.db'), 'changed')
    await expect(
      verifyPreparation('sqlite-external-exported', { ...f, binding })
    ).rejects.toMatchObject({ reason: 'CandidateChangedDuringMigration' })
  })
  it('returns only physical empty inventory for new-host and blocks memory or unknown classes', async () => {
    const { verifyPreparation } = await import('../verification')
    const options = {
      root: fixture(),
      scratchRoot: fixture(),
      binding,
      maintenanceId: 'maintenance-825',
    }
    const empty = await verifyPreparation('new-host', options)
    expect(empty.catalogHash).toBeUndefined()
    expect(empty.schemaVersion).toBeUndefined()
    expect(empty.sourceHash).toBeUndefined()
    await expect(verifyPreparation('memory', options)).rejects.toMatchObject({
      reason: 'SourceExportRequired',
    })
    await expect(verifyPreparation('unknown', options)).rejects.toMatchObject({
      reason: 'StoreModeUnknown',
    })
    database(options.root).close()
    await expect(verifyPreparation('new-host', options)).rejects.toMatchObject({
      reason: 'SourceExportRequired',
    })
  })
  it('pins sqlite-pvc complete candidates plus exact root workspace manifest', async () => {
    const { verifyPreparation } = await import('../verification')
    const root = fixture()
    database(root).close()
    const scratchRoot = fixture()
    const first = await verifyPreparation('sqlite-pvc', {
      root,
      scratchRoot,
      binding,
      maintenanceId: 'maintenance-825',
    })
    fs.writeFileSync(path.join(root, 'notes.md'), 'workspace proof')
    await expect(
      verifyPreparation('sqlite-pvc', {
        root,
        scratchRoot,
        binding,
        maintenanceId: 'maintenance-825',
        expectedManifestHash: first.manifestHash,
      })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    const next = await verifyPreparation('sqlite-pvc', {
      root,
      scratchRoot,
      binding,
      maintenanceId: 'maintenance-825',
    })
    expect(next.catalogHash).toBe(first.catalogHash)
    expect(next.manifestHash).not.toBe(first.manifestHash)
  })
  it('verifies CURRENT accepted data after later writes while retaining completed operation pins', async () => {
    const root = fixture()
    database(root).close()
    const migrated = await runMigration(root, { binding })
    const db = new Database(path.join(root, 'state', 'state.db'))
    db.exec(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','later current message',2)"
    )
    recompute(db)
    db.close()
    const { verifyCurrent } = await import('../verification')
    const result = await verifyCurrent({
      root,
      scratchRoot: fixture(),
      binding,
      maintenanceId: 'maintenance-825',
    })
    expect(result.storeId).toBe(migrated.storeId)
    expect(result.currentCatalogHash).not.toBe(archived(root).expectedCatalogHash)
    expect(result.manifestHash).toBe(archived(root).manifestHash)
    expect(result.candidateHash).toBe(archived(root).candidates[0].sourceHash)
    expect(result.migrationId).toBe(archived(root).migrationId)
  })
  it('omits candidate pins for a Created operation and echoes job correlation data', async () => {
    const root = fixture()
    await runMigration(root, { binding, provenance })
    const { runCli } = await import('../cli')
    const requestId = randomUUID()
    const capabilityId = randomUUID()
    const { verifyCurrent } = await import('../verification')
    const measured = await verifyCurrent({
      root,
      scratchRoot: fixture(),
      binding,
      maintenanceId: 'maintenance-825',
    })
    const request = {
      schemaVersion: 1 as const,
      requestId,
      ...binding,
      storageContract: 'canonical' as const,
      operation: 'release' as const,
      maintenanceId: 'maintenance-825',
      principal: { kind: 'control-admin' as const, subject: 'operator' },
      expectedStoreId: measured.storeId!,
      expectedCurrentCatalogHash: measured.currentCatalogHash!,
    }
    const resolved = {
      ...binding,
      binding,
      storageContract: 'canonical' as const,
      maintenanceId: request.maintenanceId,
      principal: 'operator',
      operation: 'release' as const,
      action: 'verify-current' as const,
      request,
      authorization: {
        kind: 'canonical-verification' as const,
        ...binding,
        storageContract: 'canonical' as const,
        requestHash: computeCanonicalOperatorRequestHash(request),
        image: 'fixture-image',
        templateRevision: objectHash('fixture-template'),
        requestId,
        maintenanceId: request.maintenanceId,
        principal: 'operator',
        jobUid: capabilityId,
        podUid: randomUUID(),
        operation: 'release' as const,
        action: 'verify-current' as const,
      },
      proof: {
        ...binding,
        requestId,
        requestHash: computeCanonicalOperatorRequestHash(request),
        storageContract: 'canonical' as const,
        rootMountPath: root,
        rootReadOnly: false,
        hostResourceVersion: 'host-rv-1',
        pvcName: 'test-pvc',
        pvcResourceVersion: 'pvc-rv-1',
        podName: 'test-pod',
        podUid: randomUUID(),
        podResourceVersion: 'pod-rv-1',
        jobName: 'test-job',
        jobUid: capabilityId,
        jobResourceVersion: 'job-rv-1',
        image: 'fixture-image',
        templateRevision: objectHash('fixture-template'),
      },
    }
    const result = await runCli(
      [
        'verify-current',
        '--root',
        root,
        '--host-uid',
        binding.hostUid,
        '--pvc-uid',
        binding.pvcUid,
        '--maintenance-id',
        'maintenance-825',
        '--request-id',
        requestId,
        '--controller-uid',
        binding.hostUid,
        '--capability-id',
        capabilityId,
        '--scratch-root',
        fixture(),
      ],
      { resolveOperatorRequest: async () => resolved }
    )
    expect(result.exitCode).toBe(0)
    expect(result.result).toMatchObject({
      proofVersion: 1,
      requestId,
      controllerUid: binding.hostUid,
      capabilityId,
    })
    expect((result.result as Record<string, unknown>).candidateHash).toBeUndefined()
  })
})

describe('normal Pod boot-check', () => {
  it('preserves accepted later writes and committed identity without a new migration', async () => {
    const root = fixture()
    database(root).close()
    const first = await runMigration(root, { binding })
    const db = new Database(path.join(root, 'state', 'state.db'))
    db.exec(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','accepted before normal boot',2)"
    )
    recompute(db)
    db.close()
    const before = fileHash(root, path.join(root, 'state', 'state.db'))
    const journal = archived(root)
    const { bootCheck } = await import('../bootGuard')
    expect(bootCheck(root, binding)).toEqual({
      outcome: 'ok',
      reason: 'AlreadyCanonical',
      layoutVersion: 1,
      storeId: first.storeId,
    })
    expect(fileHash(root, path.join(root, 'state', 'state.db'))).toBe(before)
    expect(archived(root).migrationId).toBe(journal.migrationId)
    const after = new Database(path.join(root, 'state', 'state.db'), { readonly: true })
    expect(after.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 2 })
    after.close()
  })
  it('refuses missing DB or active journal before creating any store or coordination file', async () => {
    const root = fixture()
    const { bootCheck } = await import('../bootGuard')
    expect(() => bootCheck(root, binding)).toThrow('CandidateIncomplete')
    expect(fs.readdirSync(root)).toEqual([])
    database(root).close()
    await runMigration(root, { binding })
    fs.writeFileSync(path.join(root, 'state', '.canonical-store', 'journal.json'), '{}')
    expect(() => bootCheck(root, binding)).toThrow('MigrationInProgress')
    fs.unlinkSync(path.join(root, 'state', '.canonical-store', 'journal.json'))
    fs.unlinkSync(path.join(root, 'state', 'state.db'))
    expect(() => bootCheck(root, binding)).toThrow('CandidateIncomplete')
    expect(fs.existsSync(path.join(root, 'state', 'state.db'))).toBe(false)
  })
  it('fails when the stable coordination file is missing and when a real writer owns the fence', async () => {
    const root = fixture()
    database(root).close()
    await runMigration(root, { binding })
    const { bootCheck } = await import('../bootGuard')
    const held = acquireWriterFence({ stateDir: path.join(root, 'state') })
    expect(() => bootCheck(root, binding)).toThrow('WriterFenceBusy')
    held.close()
    const file = path.join(root, 'state', '.canonical-store', 'writer-fence.db')
    fs.unlinkSync(file)
    expect(() => bootCheck(root, binding)).toThrow('CandidateIncomplete')
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('CLI trusted resolver boundary', () => {
  it('cannot turn operator flags or a local request file into a capability', async () => {
    const root = fixture()
    const requestId = randomUUID()
    const requestFile = path.join(
      root,
      'state',
      '.canonical-store',
      'requests',
      `${requestId}.json`
    )
    fs.mkdirSync(path.dirname(requestFile), { recursive: true })
    fs.writeFileSync(requestFile, '{}')
    const { runCli } = await import('../cli')
    const args = [
      'adopt',
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--request',
      requestFile,
      '--operator-authorized',
      '--operator-principal',
      'operator',
      '--maintenance-id',
      'maintenance-825',
    ]
    await expect(
      runCli(args, {
        resolveOperatorRequest: async () => {
          throw new (await import('../types')).CanonicalStoreError('AdoptUnauthorized')
        },
      })
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    expect(fs.existsSync(path.join(root, 'state', '.canonical-store', 'journal.json'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'state', '.canonical-store', 'writer-fence.db'))).toBe(
      false
    )
  })
  it('rejects identical binding and request pins on a copied off-PVC root', async () => {
    const real = fixture()
    const copied = fixture()
    const requestId = randomUUID()
    const request = {
      schemaVersion: 1 as const,
      requestId,
      ...binding,
      maintenanceId: 'maintenance-825',
      migrationId: randomUUID(),
      manifestHash: '1'.repeat(64),
      candidateHash: '2'.repeat(64),
      expectedStoreId: randomUUID(),
      expectedCurrentCatalogHash: '3'.repeat(64),
    }
    const authorization = {
      authorized: true as const,
      ...binding,
      principal: 'operator',
      requestId,
      maintenanceId: request.maintenanceId,
    }
    const { runCli } = await import('../cli')
    await expect(
      runCli(
        [
          'adopt',
          '--root',
          copied,
          '--host-uid',
          binding.hostUid,
          '--pvc-uid',
          binding.pvcUid,
          '--request-id',
          requestId,
        ],
        cliAdoptionBoundary(real, request, authorization)
      )
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    expect(fs.readdirSync(copied)).toEqual([])
  })
})

it('rejects standalone CLI export even with authorization-looking flags, preserving source and destination', async () => {
  const root = fixture()
  const source = fixture()
  database(source).close()
  const { runCli } = await import('../cli')
  await expect(
    runCli([
      'export',
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--source-path',
      path.join(source, 'state.db'),
      '--maintenance-id',
      'maintenance-825',
      '--operator-authorized',
      '--operator-principal',
      'operator',
    ])
  ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  expect(fs.readdirSync(root)).toEqual([])
  expect(fs.existsSync(path.join(source, 'state.db'))).toBe(true)
})

describe('distinct authenticated Job CLI capabilities', () => {
  function proof(
    root: string,
    requestId: string,
    jobUid: string,
    request: import('../../../runtime/canonicalOperatorAuthorization').CanonicalOperatorRequest
  ) {
    return {
      ...binding,
      requestId,
      requestHash: computeCanonicalOperatorRequestHash(request),
      storageContract: 'canonical' as const,
      rootMountPath: root,
      rootReadOnly: false,
      hostResourceVersion: 'host-rv-1',
      pvcName: 'test-pvc',
      pvcResourceVersion: 'pvc-rv-1',
      podName: 'test-pod',
      podUid: randomUUID(),
      podResourceVersion: 'pod-rv-1',
      jobName: 'test-job',
      jobUid,
      jobResourceVersion: 'job-rv-1',
      image: 'fixture-image',
      templateRevision: objectHash('fixture-template'),
    }
  }
  it('creates only with a distinct new-host capability and rejects a standalone provenance flag', async () => {
    const root = fixture()
    const { runCli } = await import('../cli')
    const requestId = randomUUID()
    const jobUid = randomUUID()
    const maintenanceId = randomUUID()
    await expect(
      runCli([
        'migrate',
        '--root',
        root,
        '--host-uid',
        binding.hostUid,
        '--pvc-uid',
        binding.pvcUid,
        '--provenance',
        'new-host',
        '--maintenance-id',
        maintenanceId,
      ])
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    expect(fs.readdirSync(root)).toEqual([])
    const request = {
      ...binding,
      storageContract: 'canonical' as const,
      schemaVersion: 1 as const,
      operation: 'prepare' as const,
      requestId,
      maintenanceId,
      principal: { kind: 'control-admin' as const, subject: 'operator' },
      sourceClass: 'new-host' as const,
      targetImage: 'fixture-image',
      templateRevision: objectHash('fixture-template'),
    }
    const resolved = {
      ...binding,
      binding,
      storageContract: 'canonical' as const,
      maintenanceId,
      principal: 'operator',
      operation: 'prepare' as const,
      action: 'migrate' as const,
      request,
      proof: proof(root, requestId, jobUid, request),
      authorization: {
        ...binding,
        requestId,
        storageContract: 'canonical' as const,
        requestHash: computeCanonicalOperatorRequestHash(request),
        image: request.targetImage,
        templateRevision: request.templateRevision,
        maintenanceId,
        principal: 'operator',
        jobUid,
        podUid: randomUUID(),
        kind: 'canonical-new-host-initialization' as const,
        operation: 'prepare' as const,
        action: 'migrate' as const,
        verifiedManifestHash: objectHash({ candidates: [], backups: [], imports: [] }),
        provisioning: { ...binding, createdAt: new Date().toISOString() },
      },
    }
    const result = await runCli(
      [
        'migrate',
        '--root',
        root,
        '--host-uid',
        binding.hostUid,
        '--pvc-uid',
        binding.pvcUid,
        '--request-id',
        requestId,
        '--scratch-root',
        fixture(),
      ],
      { resolveOperatorRequest: async () => resolved }
    )
    expect(result.result).toMatchObject({ outcome: 'ok', reason: 'Created', layoutVersion: 1 })
    expect(
      validateCanonicalStore({ root, stateDir: path.join(root, 'state'), binding }).storeId
    ).toBe((result.result as Record<string, unknown>).storeId)
  })
  it('allows finalization verification with its distinct prepare/adopt capability and measures the actual final hash', async () => {
    const root = fixture()
    database(root).close()
    const migrated = await runMigration(root, { binding })
    const { runCli } = await import('../cli')
    const requestId = randomUUID()
    const jobUid = randomUUID()
    const maintenanceId = randomUUID()
    const request = {
      ...binding,
      storageContract: 'canonical' as const,
      schemaVersion: 1 as const,
      operation: 'prepare' as const,
      requestId,
      maintenanceId,
      principal: { kind: 'control-admin' as const, subject: 'operator' },
      sourceClass: 'sqlite-pvc' as const,
      targetImage: 'fixture-image',
      templateRevision: objectHash('fixture-template'),
      manifestHash: objectHash('pre-mutation-manifest'),
    }
    const { verifyCurrent } = await import('../verification')
    const measured = await verifyCurrent({ root, binding, maintenanceId, scratchRoot: fixture() })
    const expectedCurrentCatalogHash = measured.currentCatalogHash!
    const resolved = {
      ...binding,
      binding,
      storageContract: 'canonical' as const,
      maintenanceId,
      principal: 'operator',
      operation: 'prepare' as const,
      action: 'verify-current' as const,
      request,
      expectedCurrentCatalogHash,
      expectedStoreId: migrated.storeId!,
      proof: proof(root, requestId, jobUid, request),
      authorization: {
        ...binding,
        requestId,
        storageContract: 'canonical' as const,
        requestHash: computeCanonicalOperatorRequestHash(request),
        image: request.targetImage,
        templateRevision: request.templateRevision,
        maintenanceId,
        principal: 'operator',
        jobUid,
        podUid: randomUUID(),
        kind: 'canonical-finalization-verification' as const,
        operation: 'prepare' as const,
        action: 'verify-current' as const,
        expectedStoreId: migrated.storeId!,
        expectedCurrentCatalogHash,
        mutatorJobUid: randomUUID(),
      },
    }
    const result = await runCli(
      [
        'verify-current',
        '--root',
        root,
        '--host-uid',
        binding.hostUid,
        '--pvc-uid',
        binding.pvcUid,
        '--request-id',
        requestId,
        '--operation',
        'prepare',
        '--scratch-root',
        fixture(),
      ],
      { resolveOperatorRequest: async () => resolved }
    )
    expect(result.result).toMatchObject({
      storeId: migrated.storeId,
      manifestHash: archived(root).manifestHash,
    })
    expect((result.result as Record<string, unknown>).currentCatalogHash).toMatch(/^[0-9a-f]{64}$/)
    expect((result.result as Record<string, unknown>).manifestHash).not.toBe(request.manifestHash)
  })
})

describe('authenticated migrate CLI continuation', () => {
  async function cliFixture(newHost = false) {
    const root = fixture()
    const scratchRoot = fixture()
    const requestId = randomUUID()
    const maintenanceId = randomUUID()
    const jobUid = randomUUID()
    if (!newHost) {
      database(root).close()
      fs.writeFileSync(path.join(root, 'notes.md'), 'preserved workspace')
    }
    const { verifyPreparation } = await import('../verification')
    const sourceClass = newHost ? ('new-host' as const) : ('sqlite-pvc' as const)
    const physical = await verifyPreparation(sourceClass, {
      root,
      scratchRoot,
      binding,
      maintenanceId,
    })
    const request = {
      ...binding,
      storageContract: 'canonical' as const,
      schemaVersion: 1 as const,
      operation: 'prepare' as const,
      requestId,
      maintenanceId,
      principal: { kind: 'control-admin' as const, subject: 'operator' },
      sourceClass,
      targetImage: 'fixture-image',
      templateRevision: objectHash('fixture-template'),
      ...(newHost ? {} : { manifestHash: physical.manifestHash }),
    }
    const common = {
      ...binding,
      requestId,
      storageContract: 'canonical' as const,
      requestHash: computeCanonicalOperatorRequestHash(request),
      image: request.targetImage,
      templateRevision: request.templateRevision,
      maintenanceId,
      principal: 'operator',
      jobUid,
      podUid: randomUUID(),
      operation: 'prepare' as const,
      action: 'migrate' as const,
      verifiedManifestHash: physical.manifestHash,
    }
    const authorization = newHost
      ? {
          ...common,
          kind: 'canonical-new-host-initialization' as const,
          provisioning: { ...binding, createdAt: new Date().toISOString() },
        }
      : { ...common, kind: 'canonical-migration' as const }
    const resolved = {
      ...binding,
      binding,
      storageContract: 'canonical' as const,
      maintenanceId,
      principal: 'operator',
      operation: 'prepare' as const,
      action: 'migrate' as const,
      request,
      authorization,
      proof: {
        ...binding,
        requestId,
        requestHash: computeCanonicalOperatorRequestHash(request),
        storageContract: 'canonical' as const,
        rootMountPath: root,
        rootReadOnly: false,
        hostResourceVersion: 'host-rv-1',
        pvcName: 'test-pvc',
        pvcResourceVersion: 'pvc-rv-1',
        podName: 'test-pod',
        podUid: randomUUID(),
        podResourceVersion: 'pod-rv-1',
        jobName: 'test-job',
        jobUid,
        jobResourceVersion: 'job-rv-1',
        image: 'fixture-image',
        templateRevision: request.templateRevision,
      },
    } as ResolvedCanonicalOperatorRequest
    const args = [
      'migrate',
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--request-id',
      requestId,
      '--scratch-root',
      scratchRoot,
    ]
    return { root, scratchRoot, requestId, maintenanceId, resolved, args }
  }
  it.each(['started', 'snapshotted', 'staged', 'retiring', 'archived'])(
    'retries the real migrate CLI after %s with fresh authorization and the same durable operation',
    async point => {
      const f = await cliFixture()
      const { runCli } = await import('../cli')
      let cuts = 0
      const port: FsPort = {
        ...nodeFs,
        renameSync(from, to) {
          nodeFs.renameSync(from, to)
          if (cuts) return
          if (point === 'retiring' && String(to).includes('/retired/C_root/state.db')) {
            cuts++
            throw new Error('CLI migration cut')
          }
          if (point === 'archived' && String(from).endsWith('/.canonical-store/journal.json')) {
            cuts++
            throw new Error('CLI migration cut')
          }
          if (
            String(to).endsWith('/.canonical-store/journal.json') &&
            ['started', 'snapshotted', 'staged'].includes(point) &&
            JSON.parse(fs.readFileSync(to, 'utf8')).phase === point
          ) {
            cuts++
            throw new Error('CLI migration cut')
          }
        },
      }
      await expect(
        runCli(f.args, { resolveOperatorRequest: async () => f.resolved, fs: port })
      ).rejects.toThrow('CLI migration cut')
      expect(cuts).toBe(1)
      const active = readJournal(f.root, binding)
      const migrationId = active?.migrationId ?? archived(f.root).migrationId
      const durable = active ?? archived(f.root)
      expect(durable.operator?.requestId).toBe(f.requestId)
      if (point === 'retiring') expect(fs.existsSync(path.join(f.root, 'state.db'))).toBe(false)
      if (point === 'archived') {
        expect(active).toBeUndefined()
        const db = new Database(path.join(f.root, 'state', 'state.db'))
        db.exec(
          "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','accepted after committed operation',2)"
        )
        recompute(db)
        db.close()
      }
      const differentId = randomUUID()
      const foreign = {
        ...f.resolved,
        request: { ...f.resolved.request, requestId: differentId },
        authorization: { ...f.resolved.authorization, requestId: differentId },
        proof: { ...f.resolved.proof, requestId: differentId },
      } as ResolvedCanonicalOperatorRequest
      if (foreign.operation !== 'prepare' || foreign.action !== 'migrate')
        throw new Error('fixture migration capability')
      foreign.proof.requestHash = computeCanonicalOperatorRequestHash(foreign.request)
      foreign.authorization.requestHash = foreign.proof.requestHash
      const badArgs = [...f.args]
      badArgs[badArgs.indexOf('--request-id') + 1] = differentId
      await expect(
        runCli(badArgs, { resolveOperatorRequest: async () => foreign })
      ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
      const retry = {
        ...f.resolved,
        proof: { ...f.resolved.proof, podUid: randomUUID(), podResourceVersion: 'pod-rv-retry' },
      } as ResolvedCanonicalOperatorRequest
      const result = await runCli(f.args, { resolveOperatorRequest: async () => retry })
      expect(result.exitCode).toBe(0)
      expect(archived(f.root).migrationId).toBe(migrationId)
      expect(readJournal(f.root, binding)).toBeUndefined()
      expect(fs.readFileSync(path.join(f.root, 'workspace', 'notes.md'), 'utf8')).toBe(
        'preserved workspace'
      )
      const db = new Database(path.join(f.root, 'state', 'state.db'), { readonly: true })
      expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
        count: point === 'archived' ? 2 : 1,
      })
      db.close()
    },
    30000
  )
  it('resumes new-host started with exact provisioning and rejects same-request different birth provenance', async () => {
    const f = await cliFixture(true)
    const { runCli } = await import('../cli')
    let cuts = 0
    const port: FsPort = {
      ...nodeFs,
      renameSync(from, to) {
        nodeFs.renameSync(from, to)
        if (
          !cuts &&
          String(to).endsWith('/.canonical-store/journal.json') &&
          JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'started'
        ) {
          cuts++
          throw new Error('new-host CLI cut')
        }
      },
    }
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => f.resolved, fs: port })
    ).rejects.toThrow('new-host CLI cut')
    const active = readJournal(f.root, binding)!
    expect(active.provenance?.kind).toBe('new-host')
    expect(active.operator?.kind).toBe('canonical-new-host-initialization')
    const foreign = {
      ...f.resolved,
      authorization: {
        ...f.resolved.authorization,
        provisioning: { ...binding, createdAt: '2000-01-01T00:00:00.000Z' },
      },
    } as ResolvedCanonicalOperatorRequest
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => foreign })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    expect(
      (await runCli(f.args, { resolveOperatorRequest: async () => f.resolved })).exitCode
    ).toBe(0)
    expect(archived(f.root).migrationId).toBe(active.migrationId)
    expect(
      validateCanonicalStore({ root: f.root, stateDir: path.join(f.root, 'state'), binding })
        .storeId
    ).toBeDefined()
  })
  it('never grants continuation to an unbound programmatic journal with only the same Host/PVC', async () => {
    const f = await cliFixture()
    let cuts = 0
    const port: FsPort = {
      ...nodeFs,
      renameSync(from, to) {
        nodeFs.renameSync(from, to)
        if (
          !cuts &&
          String(to).endsWith('/.canonical-store/journal.json') &&
          JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'started'
        ) {
          cuts++
          throw new Error('unbound journal cut')
        }
      },
    }
    await expect(runMigration(f.root, { binding, fs: port })).rejects.toThrow('unbound journal cut')
    expect(readJournal(f.root, binding)?.operator).toBeUndefined()
    const { runCli } = await import('../cli')
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => f.resolved })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    expect(readJournal(f.root, binding)?.phase).toBe('started')
    expect(fs.existsSync(path.join(f.root, 'state.db'))).toBe(true)
  })
})
