import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { assertCanonicalRuntimeConfig } from '../../../canonicalStoreBootGuard'
import {
  type ConversationStoreHandle,
  createConversationStore,
} from '../../../core/conversation/persistence/conversationStoreFactory'
import { runMigration } from '../../canonicalStore/canonicalStoreInit'
import { acquireWriterFence } from '../../canonicalStore/writerFence'
import { runMigrations } from '../../migrate'
import { createDispatcher, dispatch } from '../dispatcher'
import type { SessionRow } from '../protocol'

const roots: string[] = []
const handles: ConversationStoreHandle[] = []
const binding = { hostUid: randomUUID(), pvcUid: randomUUID() }
function fixture(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canonical-worker-'))
  roots.push(root)
  return root
}
function options(root: string) {
  return {
    mode: 'sqlite' as const,
    dbPath: path.join(root, 'state', 'state.db'),
    cacheSize: 10,
    syncTimeoutMs: 2000,
    asyncTimeoutMs: 2000,
    checkpointEveryWrites: 2,
    heartbeatMs: 1000,
    canonicalStore: { stateDir: path.join(root, 'state'), binding, required: true },
    workerScriptPath: path.resolve(__dirname, '../../../../dist/db/worker/dbWorker.js'),
  }
}
function sessionRow(id: string, key: string): SessionRow {
  return {
    id,
    session_key: key,
    source: 'rpc',
    user_id: 'owner',
    team_id: null,
    channel_type: 'rpc',
    channel_id: 'host',
    thread_id: 'chat',
    model: null,
    model_selections: null,
    system_prompt_stable_hash: null,
    parent_session_id: null,
    started_at: 10,
    ended_at: null,
    end_reason: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_tokens_reported: 0,
    title: null,
    state: 'idle',
    active_task_id: null,
    active_trace_context: null,
  }
}
async function canonicalFixture(): Promise<string> {
  const root = fixture()
  const result = await runMigration(root, {
    binding,
    provenance: { ...binding, kind: 'new-host', maintenanceId: randomUUID() },
  })
  expect(result.outcome).toBe('ok')
  return root
}
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('canonical runtime worker', () => {
  it('requires sqlite, an explicit bound state directory and the exact canonical path', () => {
    const root = fixture()
    const opts = options(root)
    expect(() => assertCanonicalRuntimeConfig('memory', opts.dbPath, opts.canonicalStore)).toThrow(
      'RequiresSqlite'
    )
    expect(() => assertCanonicalRuntimeConfig('dual', opts.dbPath, opts.canonicalStore)).toThrow(
      'RequiresSqlite'
    )
    expect(() =>
      assertCanonicalRuntimeConfig('sqlite', path.join(root, 'state.db'), opts.canonicalStore)
    ).toThrow('DbPathMismatch')
    expect(() =>
      assertCanonicalRuntimeConfig('sqlite', opts.dbPath, {
        ...opts.canonicalStore,
        stateDir: 'state',
      })
    ).toThrow('StateDirInvalid')
    expect(() =>
      assertCanonicalRuntimeConfig('sqlite', opts.dbPath, {
        ...opts.canonicalStore,
        legacyRoot: root,
      })
    ).toThrow('RootMountForbidden')
  })

  it('never creates a missing canonical database', async () => {
    const root = fixture()
    const handle = createConversationStore(options(root))
    handles.push(handle)
    await expect(handle.ready).rejects.toThrow('CandidateIncomplete')
    expect(fs.existsSync(path.join(root, 'state', 'state.db'))).toBe(false)
  })

  it('validates identity before writes and rejects a different Host UID', async () => {
    const root = await canonicalFixture()
    const opts = options(root)
    opts.canonicalStore.binding = { ...binding, hostUid: randomUUID() }
    const handle = createConversationStore(opts)
    handles.push(handle)
    await expect(handle.ready).rejects.toThrow('HostUidMismatch')
  })

  it('holds the PVC fence through accepted writes until acknowledged SQLite close', async () => {
    const root = await canonicalFixture()
    const opts = options(root)
    const handle = createConversationStore(opts)
    handles.push(handle)
    await handle.ready
    expect(() =>
      acquireWriterFence({ stateDir: opts.canonicalStore.stateDir, timeoutMs: 0 })
    ).toThrow('WriterFenceBusy')
    const id = randomUUID()
    const write = handle.persistQueue!.enqueueSync({
      kind: 'insert_session',
      payload: sessionRow(id, 'owner:rpc:host:chat'),
    })
    const closing = handle.shutdown()
    await write
    await closing
    const contender = acquireWriterFence({ stateDir: opts.canonicalStore.stateDir, timeoutMs: 0 })
    try {
      const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true })
      try {
        expect(db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id)).toEqual({
          user_id: 'owner',
        })
      } finally {
        db.close()
      }
    } finally {
      contender.close()
    }
  })

  it('rejects a canonical file even when all new runtime options are missing', async () => {
    const root = await canonicalFixture()
    const opts = options(root)
    const handle = createConversationStore({ ...opts, canonicalStore: undefined })
    handles.push(handle)
    await expect(handle.ready).rejects.toThrow('CanonicalStoreLayoutRollback')
    expect(() =>
      createConversationStore({ ...opts, mode: 'memory', canonicalStore: undefined })
    ).toThrow('CanonicalStoreLayoutRollback')
  })

  it('never recreates a missing committed canonical database when runtime options disappear', async () => {
    const root = await canonicalFixture()
    const opts = options(root)
    fs.renameSync(opts.dbPath, opts.dbPath + '.retained')
    const stateOnly = createConversationStore({ ...opts, canonicalStore: undefined })
    handles.push(stateOnly)
    await expect(stateOnly.ready).rejects.toThrow('RuntimeContractMissing')
    expect(fs.existsSync(opts.dbPath)).toBe(false)
    const rootFile = path.join(root, 'state.db')
    const rootMount = createConversationStore({
      ...opts,
      dbPath: rootFile,
      canonicalStore: undefined,
    })
    handles.push(rootMount)
    await expect(rootMount.ready).rejects.toThrow('CanonicalStoreLayoutRollback')
    expect(fs.existsSync(rootFile)).toBe(false)
    expect(() =>
      createConversationStore({ ...opts, mode: 'memory', canonicalStore: undefined })
    ).toThrow('RuntimeContractMissing')
  })

  it('rejects an active journal without a runtime contract before creating a SQLite file', async () => {
    const root = fixture()
    const opts = options(root)
    fs.mkdirSync(path.join(root, 'state', '.canonical-store'), { recursive: true })
    fs.writeFileSync(path.join(root, 'state', '.canonical-store', 'journal.json'), '{}')
    const handle = createConversationStore({ ...opts, canonicalStore: undefined })
    handles.push(handle)
    await expect(handle.ready).rejects.toThrow('MigrationInProgress')
    expect(fs.existsSync(opts.dbPath)).toBe(false)
  })

  it('cannot downgrade a canonical state subPath by disabling the required flag', async () => {
    const root = await canonicalFixture()
    const opts = options(root)
    const handle = createConversationStore({
      ...opts,
      canonicalStore: { ...opts.canonicalStore, required: false },
    })
    handles.push(handle)
    await expect(handle.ready).rejects.toThrow('CanonicalStoreLayoutRollback')
  })

  it('blocks an incomplete legacy migration before running worker schema migrations', async () => {
    const root = fixture()
    const state = path.join(root, 'state')
    fs.mkdirSync(path.join(state, '.canonical-store'), { recursive: true })
    fs.writeFileSync(path.join(state, '.canonical-store', 'journal.json'), '{}')
    const handle = createConversationStore({
      ...options(root),
      dbPath: path.join(root, 'state.db'),
      canonicalStore: { stateDir: state, binding, required: false, legacyRoot: root },
    })
    handles.push(handle)
    await expect(handle.ready).rejects.toThrow('MigrationInProgress')
    expect(fs.existsSync(path.join(root, 'state.db'))).toBe(false)
  })

  async function floorFixture(): Promise<string> {
    const root = fixture()
    const db = new Database(path.join(root, 'state.db'))
    runMigrations(db)
    db.close()
    const result = await runMigration(root, { binding, writer: 'layout-precheck' })
    expect(result.outcome).toBe('ok')
    expect(result.storageContract).toBe('legacy-floor')
    return root
  }

  function floorOptions(root: string) {
    const opts = options(root)
    return {
      ...opts,
      canonicalStore: {
        ...opts.canonicalStore,
        required: false,
        storageContract: 'legacy-floor' as const,
      },
    }
  }

  it('never creates the database or fence for a missing legacy-floor store', async () => {
    const root = fixture()
    const handle = createConversationStore(floorOptions(root))
    handles.push(handle)
    await expect(handle.ready).rejects.toThrow('CandidateIncomplete')
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false)
  })

  it('keeps floor writes durable through restart and canonical activation without inventing a store identity', async () => {
    const root = await floorFixture()
    const opts = floorOptions(root)
    const first = createConversationStore(opts)
    handles.push(first)
    await first.ready
    const id = randomUUID()
    await first.persistQueue!.enqueueSync({
      kind: 'insert_session',
      payload: sessionRow(id, 'owner:rpc:host:floor'),
    })
    expect(() =>
      acquireWriterFence({ stateDir: opts.canonicalStore.stateDir, timeoutMs: 0 })
    ).toThrow('WriterFenceBusy')
    await first.shutdown()
    const second = createConversationStore(opts)
    handles.push(second)
    await second.ready
    await second.shutdown()
    const floorDb = new Database(opts.dbPath, { readonly: true, fileMustExist: true })
    try {
      expect(
        floorDb.prepare('SELECT COUNT(*) AS count FROM canonical_store_identity').get()
      ).toEqual({ count: 0 })
      expect(floorDb.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id)).toEqual({
        user_id: 'owner',
      })
    } finally {
      floorDb.close()
    }
    const activation = await runMigration(root, { binding })
    expect(activation.outcome).toBe('ok')
    const canonical = createConversationStore(options(root))
    handles.push(canonical)
    await canonical.ready
    const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true })
    try {
      expect(db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id)).toEqual({
        user_id: 'owner',
      })
    } finally {
      db.close()
    }
    await canonical.shutdown()
    const downgrade = createConversationStore(opts)
    handles.push(downgrade)
    await expect(downgrade.ready).rejects.toThrow('CanonicalStoreLayoutRollback')
  })

  it('rejects floor binding mismatch and removal of its explicit runtime contract', async () => {
    const root = await floorFixture()
    const opts = floorOptions(root)
    const mismatch = createConversationStore({
      ...opts,
      canonicalStore: { ...opts.canonicalStore, binding: { ...binding, hostUid: randomUUID() } },
    })
    handles.push(mismatch)
    await expect(mismatch.ready).rejects.toThrow('HostUidMismatch')
    const missing = createConversationStore({ ...opts, canonicalStore: undefined })
    handles.push(missing)
    await expect(missing.ready).rejects.toThrow('RuntimeContractMissing')
    const legacy = createConversationStore({
      ...opts,
      canonicalStore: { ...opts.canonicalStore, storageContract: undefined },
    })
    handles.push(legacy)
    await expect(legacy.ready).rejects.toThrow('RuntimeContractMissing')
  })

  it('rejects missing floor marker or writer fence instead of repairing them on boot', async () => {
    const root = await floorFixture()
    const opts = floorOptions(root)
    const marker = path.join(opts.canonicalStore.stateDir, '.canonical-store', 'legacy-layout.json')
    fs.renameSync(marker, marker + '.retained')
    const missingMarker = createConversationStore(opts)
    handles.push(missingMarker)
    await expect(missingMarker.ready).rejects.toThrow('MarkerMismatch')
    fs.renameSync(marker + '.retained', marker)
    const fence = path.join(opts.canonicalStore.stateDir, '.canonical-store', 'writer-fence.db')
    fs.renameSync(fence, fence + '.retained')
    const missingFence = createConversationStore(opts)
    handles.push(missingFence)
    await expect(missingFence.ready).rejects.toThrow('CandidateIncomplete')
    expect(fs.existsSync(fence)).toBe(false)
  })

  it('rechecks the actual fence connection before a write retry and stops when it is lost', async () => {
    const root = fixture()
    const stateDir = path.join(root, 'state')
    const fence = acquireWriterFence({ stateDir })
    const dbPath = path.join(stateDir, 'state.db')
    const db = new Database(dbPath)
    runMigrations(db)
    db.pragma('busy_timeout = 0')
    const blocker = new Database(dbPath)
    const deps = createDispatcher(db, () => fence.assertHeld())
    blocker.exec('BEGIN IMMEDIATE')
    const writing = dispatch(
      { kind: 'insert_session', payload: sessionRow(randomUUID(), 'owner:rpc:host:retry') },
      deps
    )
    fence.close()
    const contender = acquireWriterFence({ stateDir, timeoutMs: 0 })
    blocker.exec('ROLLBACK')
    try {
      await expect(writing).rejects.toThrow('WriterFenceBusy')
      expect(db.prepare('SELECT COUNT(*) AS total FROM sessions').get()).toEqual({ total: 0 })
    } finally {
      contender.close()
      blocker.close()
      db.close()
    }
  })
})
