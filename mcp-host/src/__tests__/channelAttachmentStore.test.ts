import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildAttachmentFileReference,
  classifyBytes,
  resourceNameProblem,
} from '@clerum/gfs-interaction-policy'
import { runMigrations } from '../db/migrate'
import { createDispatcher, dispatch } from '../db/worker/dispatcher'
import type {
  EndObsoleteApprovalSessionResult,
  InsertChannelAttachmentResult,
  PersistedSession,
  PersistedSessionSummary,
  RetainedChannelAttachmentRow,
  RotateSessionOnIdentityChangeResult,
  SearchMessageRow,
  SessionRow,
  SweptChannelAttachmentRef,
} from '../db/worker/protocol'
import {
  ChannelAttachmentStore,
  ChannelAttachmentStoreError,
  normalizeChannelFilename,
  validateStrictChannelImageContainer,
} from '../internalTools/channelAttachmentStore'
import { PrivateStoreUntrustedError } from '../internalTools/gfsStorePrivateFiles'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'
import { channelAttachmentStoreDir, putTestBuffer } from './channelAttachmentTestHelpers'

const HEALTHY_STATFS = async () => ({
  bsize: 4096n,
  blocks: (100n * 1024n * 1024n * 1024n) / 4096n, // 100 GiB total
  bavail: (50n * 1024n * 1024n * 1024n) / 4096n, // 50 GiB available (50% > 15% floor)
})

function openTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function makeAttachmentRow(
  overrides: Partial<RetainedChannelAttachmentRow> = {}
): RetainedChannelAttachmentRow {
  const bytes = Buffer.from('hello world attachment')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const attachmentId = overrides.attachment_id ?? randomUUID()
  const classification = classifyBytes({
    bytes,
    totalByteLength: bytes.length,
    declaredMediaType: 'text/plain',
    filename: 'notes.txt',
  })
  const ref = buildAttachmentFileReference({
    attachmentId,
    messageId: 'msg-1',
    name: 'notes.txt',
    declaredMediaType: 'text/plain',
    byteLength: bytes.length,
    digestHex: sha256,
    classification,
  })
  if (!ref.ok) throw new Error(ref.message)

  return {
    attachment_id: attachmentId,
    session_key: 'u-prov:telegram:chat-1',
    linked_user_id: 'linked-user-a',
    provider_event_id: 'evt-1',
    provider_attachment_id: 'att-1',
    storage_rel_path: `${attachmentId}.bin`,
    sha256,
    byte_length: bytes.length,
    file_reference_json: JSON.stringify(ref.value),
    width: null,
    height: null,
    visual_valid: 0,
    created_at: 1_700_000_000,
    expires_at: 1_700_604_800,
    status: 'ready',
    ...overrides,
  }
}

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: overrides.id ?? `sess-${randomUUID()}`,
    session_key: overrides.session_key ?? 'u-prov:telegram:chat-1',
    source: overrides.source ?? 'telegram',
    user_id: overrides.user_id ?? 'u-prov',
    team_id: null,
    channel_type: overrides.channel_type ?? 'telegram',
    channel_id: overrides.channel_id ?? 'chat-1',
    thread_id: overrides.thread_id ?? null,
    model: null,
    model_selections: null,
    system_prompt_stable_hash: null,
    parent_session_id: null,
    started_at: 1_700_000_000,
    last_activity_at: 1_700_000_000,
    turn_count: 1,
    ended_at: null,
    end_reason: null,
    message_count: 1,
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
    approval_mode: 'manual',
    linked_user_id: 'linked-user-a',
    ...overrides,
  }
}

describe('X2 & X3 — ChannelAttachmentStore, SQLite migration 020, and worker ops', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-ch-att-store-'))
    db = openTestDb()
  })

  afterEach(async () => {
    db.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('S24: ingests into conversation_attachments on turn 1 before any sessions row exists with PRAGMA foreign_keys = ON', async () => {
    const deps = createDispatcher(db)
    const row = makeAttachmentRow()

    const inserted = (await dispatch(
      { kind: 'insert_channel_attachment', payload: row },
      deps
    )) as InsertChannelAttachmentResult

    expect(inserted.deduplicated).toBe(false)
    expect(inserted.record.attachment_id).toBe(row.attachment_id)

    const sessionCount = (
      db.prepare('SELECT count(*) AS cnt FROM sessions').get() as { cnt: number }
    ).cnt
    const attachmentCount = (
      db.prepare('SELECT count(*) AS cnt FROM conversation_attachments').get() as { cnt: number }
    ).cnt
    expect(sessionCount).toBe(0)
    expect(attachmentCount).toBe(1)
  })

  it('S26: deduplicates idempotent insert across pod restart with 1 SQLite row and 1 blob', async () => {
    const deps = createDispatcher(db)
    const store1 = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const payloadBytes = Buffer.from('%PDF-1.4 idempotent content')
    const put1 = await putTestBuffer(store1, {
      bytes: payloadBytes,
      linkedUserId: 'linked-user-a',
    })
    const row1 = makeAttachmentRow({
      attachment_id: put1.attachmentId,
      storage_rel_path: put1.storageRelPath,
      sha256: put1.sha256,
      byte_length: put1.byteLength,
    })
    const res1 = (await dispatch(
      { kind: 'insert_channel_attachment', payload: row1 },
      deps
    )) as InsertChannelAttachmentResult
    expect(res1.deduplicated).toBe(false)

    // Simulate restart by creating a brand new store instance over the same PVC directory.
    const store2 = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const put2 = await putTestBuffer(store2, {
      bytes: payloadBytes,
      linkedUserId: 'linked-user-a',
    })
    const row2 = makeAttachmentRow({
      attachment_id: put2.attachmentId,
      storage_rel_path: put2.storageRelPath,
      sha256: put2.sha256,
      byte_length: put2.byteLength,
    })
    const res2 = (await dispatch(
      { kind: 'insert_channel_attachment', payload: row2 },
      deps
    )) as InsertChannelAttachmentResult

    expect(res2.deduplicated).toBe(true)
    expect(res2.record.attachment_id).toBe(row1.attachment_id)

    // Clean up duplicate blob just as X4 ingest handler does.
    await store2.removeBlob(put2.storageRelPath)

    const files = await fs.readdir(channelAttachmentStoreDir(tmpDir))
    expect(files).toEqual([put1.storageRelPath])
    const count = (
      db.prepare('SELECT count(*) AS cnt FROM conversation_attachments').get() as { cnt: number }
    ).cnt
    expect(count).toBe(1)
  })

  it('S29: enforces max size (413), upfront concurrent activeReservedBytes disk floor (507), and leaves 0 partials and 0 reserved bytes at rest', async () => {
    const blockSize = 4096n
    // 100 MiB total volume -> 15% floor = 16 MiB (FREE_SPACE_FLOOR_MIN_BYTES = 16_777_216).
    // Give 18.5 MiB (18.5 * 1024 * 1024) available -> headroom above 16 MiB floor is 2.5 MiB.
    // A 2 MiB maxFileBytes stream fits the reservation and fails at limit+1 with file_too_large,
    // while 5 concurrent 1 MiB uploads admit at most 2 and reject 3 with disk_full!
    const totalBlocks = (100n * 1024n * 1024n) / blockSize
    // Exact 18.5 MiB (19,398,656 bytes): 2.5 MiB above the 16 MiB floor.
    const availBlocks = (18n * 1024n * 1024n + 512n * 1024n) / blockSize

    const store = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      maxFileBytes: 2 * 1024 * 1024,
      statfsFn: async () => ({ bsize: blockSize, blocks: totalBlocks, bavail: availBlocks }),
    })

    // 1) Oversized stream aborts with file_too_large and leaves 0 partials.
    async function* oversizedStream() {
      yield Buffer.alloc(1024 * 1024, 0x41)
      yield Buffer.alloc(1024 * 1024 + 1, 0x42)
    }
    await expect(
      store.putStream({
        stream: oversizedStream(),
        linkedUserId: 'linked-user-a',
      })
    ).rejects.toMatchObject({ code: 'file_too_large' })

    // 2) 5 concurrent 1 MiB streams racing near the 15% floor.
    const oneMiB = Buffer.alloc(1024 * 1024, 0x7a)
    let releaseStreams!: () => void
    const gate = new Promise<void>(resolve => {
      releaseStreams = resolve
    })
    const makeSlowStream = () =>
      (async function* () {
        yield oneMiB.subarray(0, 512 * 1024)
        await gate
        yield oneMiB.subarray(512 * 1024)
      })()

    const resultsPromise = Promise.allSettled(
      Array.from({ length: 5 }, () =>
        store.putStream({
          stream: makeSlowStream(),
          linkedUserId: 'linked-user-a',
          declaredBytes: oneMiB.length,
        })
      )
    )

    // Let all 5 enter statfs + reservation synchronously before releasing chunks.
    await new Promise(resolve => setTimeout(resolve, 30))
    releaseStreams()

    const results = await resultsPromise
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]

    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(3)
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ChannelAttachmentStoreError)
      expect((r.reason as ChannelAttachmentStoreError).code).toBe('disk_full')
    }

    const dirEntries = await fs.readdir(channelAttachmentStoreDir(tmpDir))
    expect(dirEntries.filter(name => name.endsWith('.partial'))).toHaveLength(0)
    expect(dirEntries.filter(name => name.endsWith('.bin'))).toHaveLength(2)
    // Reservation-release witness: a subsequent small write within the 2.5 MiB headroom succeeds.
    const afterPut = await putTestBuffer(store, {
      bytes: Buffer.alloc(64 * 1024, 0x33),
      linkedUserId: 'linked-user-a',
    })
    expect(afterPut.byteLength).toBe(64 * 1024)
  })

  it('S30: fails closed with channel_attachment_store_unavailable in memory mode without creating directories', async () => {
    const memoryRoot = path.join(tmpDir, 'never-created')
    const store = new ChannelAttachmentStore({
      hostWorkspaceRoot: memoryRoot,
      sessionStoreMode: 'memory',
    })
    expect(store.isAvailable()).toBe(false)
    await expect(
      putTestBuffer(store, {
        bytes: Buffer.from('secret'),
        linkedUserId: 'linked-user-a',
      })
    ).rejects.toMatchObject({ code: 'channel_attachment_store_unavailable' })

    // Liveness witness: verify the directory was never created while sqlite mode does create it.
    await expect(fs.access(memoryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const sqliteStore = new ChannelAttachmentStore({
      hostWorkspaceRoot: path.join(tmpDir, 'sqlite-root'),
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const put = await putTestBuffer(sqliteStore, {
      bytes: Buffer.from('ok'),
      linkedUserId: 'linked-user-a',
    })
    expect(put.byteLength).toBe(2)
  })

  it('S37: survives cold restart with a fresh store instance and verifies SHA-256 on read', async () => {
    const deps = createDispatcher(db)
    const originalBytes = Buffer.from('%PDF-1.7 cold-restart-contract-payload')
    const storeBefore = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const put = await putTestBuffer(storeBefore, {
      bytes: originalBytes,
      linkedUserId: 'linked-user-a',
    })
    const row = makeAttachmentRow({
      attachment_id: put.attachmentId,
      storage_rel_path: put.storageRelPath,
      sha256: put.sha256,
      byte_length: put.byteLength,
    })
    await dispatch({ kind: 'insert_channel_attachment', payload: row }, deps)

    // Cold restart: new ChannelAttachmentStore over same PVC dir.
    const storeAfter = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const read = await storeAfter.readForOwner(
      {
        getChannelAttachmentForOwner: (attachmentId, sessionKey, linkedUserId, nowEpoch) =>
          dispatch(
            {
              kind: 'get_channel_attachment_for_owner',
              attachmentId,
              sessionKey,
              linkedUserId,
              nowEpoch: nowEpoch ?? 1_700_000_100,
            },
            deps
          ) as Promise<RetainedChannelAttachmentRow | null>,
      },
      {
        attachmentId: put.attachmentId,
        sessionKey: row.session_key,
        linkedUserId: row.linked_user_id,
        nowEpoch: 1_700_000_100,
      }
    )

    expect(read.bytes.equals(originalBytes)).toBe(true)
    // Cross-user isolation witness: User B cannot read User A's attachment.
    await expect(
      storeAfter.readForOwner(
        {
          getChannelAttachmentForOwner: (attachmentId, sessionKey, linkedUserId, nowEpoch) =>
            dispatch(
              {
                kind: 'get_channel_attachment_for_owner',
                attachmentId,
                sessionKey,
                linkedUserId,
                nowEpoch: nowEpoch ?? 1_700_000_100,
              },
              deps
            ) as Promise<RetainedChannelAttachmentRow | null>,
        },
        {
          attachmentId: put.attachmentId,
          sessionKey: row.session_key,
          linkedUserId: 'linked-user-b',
          nowEpoch: 1_700_000_100,
        }
      )
    ).rejects.toMatchObject({ code: 'attachment_not_found' })
  })

  it('S40: pins expired attachments during pending_approvals / processing and sweeps both row and blob once idle', async () => {
    const deps = createDispatcher(db)
    const store = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const payload = Buffer.from('pinned attachment bytes')
    const put = await putTestBuffer(store, {
      bytes: payload,
      linkedUserId: 'linked-user-a',
    })
    const session = makeSessionRow({
      id: 'sess-pinned',
      session_key: 'u-prov:telegram:chat-pin',
      state: 'awaiting_approval',
      active_task_id: 'task-pin',
      linked_user_id: 'linked-user-a',
    })
    await dispatch({ kind: 'insert_session', payload: session }, deps)
    await dispatch(
      {
        kind: 'insert_pending_approval',
        payload: {
          request_id: 'req-pin',
          session_id: session.id,
          task_id: 'task-pin',
          tool_name: 'clerum__gfs_save_attachment',
          tool_call_id: 'tc-1',
          parameters: '{}',
          description: 'Save attachment',
          context_snapshot: '[]',
          completed_results: null,
          intent_summary: null,
          source_message: null,
          registered_at: 1_700_000_000,
          expires_at: 1_700_604_800,
          trace_context: null,
          reason: null,
          mcp_server_name: null,
        },
      },
      deps
    )

    const attRow = makeAttachmentRow({
      attachment_id: put.attachmentId,
      session_key: session.session_key,
      linked_user_id: 'linked-user-a',
      storage_rel_path: put.storageRelPath,
      sha256: put.sha256,
      byte_length: put.byteLength,
      created_at: 1_700_000_000,
      expires_at: 1_700_003_600, // +1 hour
    })
    await dispatch({ kind: 'insert_channel_attachment', payload: attRow }, deps)

    const pastTtl = 1_700_010_000 // past +1 hour TTL
    const dbSweeper = {
      sweepExpiredChannelAttachments: (nowEpoch?: number, limit?: number) =>
        dispatch(
          {
            kind: 'sweep_expired_channel_attachments',
            nowEpoch: nowEpoch ?? pastTtl,
            limit,
          },
          deps
        ) as Promise<SweptChannelAttachmentRef[]>,
    }

    // Sweep while awaiting_approval + pending_approvals exists -> pinned!
    const sweepWhilePinned = await store.sweepExpired(dbSweeper, { nowEpoch: pastTtl })
    expect(sweepWhilePinned.sweptRows).toBe(0)
    expect(sweepWhilePinned.removedBlobs).toBe(0)

    // Still readable while pinned (and also when transitioning to 'processing' after approve deletes pending_approvals — S87).
    await dispatch(
      {
        kind: 'update_session_state',
        sessionId: session.id,
        state: 'processing',
        deletePendingRequestId: 'req-pin',
      },
      deps
    )
    const activeDuringProcessing = (await dispatch(
      {
        kind: 'list_active_channel_attachments',
        sessionKey: session.session_key,
        linkedUserId: 'linked-user-a',
        nowEpoch: pastTtl,
      },
      deps
    )) as RetainedChannelAttachmentRow[]
    expect(activeDuringProcessing).toHaveLength(1)
    const verified = await store.readVerified(put.storageRelPath, put.sha256)
    expect(verified.equals(payload)).toBe(true)

    // Once session transitions to idle, next sweep deletes both SQLite row and PVC blob.
    await dispatch(
      {
        kind: 'update_session_state',
        sessionId: session.id,
        state: 'idle',
        activeTaskId: null,
      },
      deps
    )
    const sweepAfterIdle = await store.sweepExpired(dbSweeper, { nowEpoch: pastTtl })
    expect(sweepAfterIdle.sweptRows).toBe(1)
    expect(sweepAfterIdle.removedBlobs).toBe(1)

    const remainingRows = (
      db.prepare('SELECT count(*) AS cnt FROM conversation_attachments').get() as { cnt: number }
    ).cnt
    expect(remainingRows).toBe(0)
    const remainingFiles = await fs.readdir(channelAttachmentStoreDir(tmpDir))
    expect(remainingFiles).toHaveLength(0)
  })

  it('S41: fails closed on corrupted blob (SHA-256 mismatch) and symlink swap while untampered sibling reads cleanly', async () => {
    const store = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const goodBytes = Buffer.from('untampered-sibling-bytes')
    const corruptBytes = Buffer.from('original-bytes-before-tamper')
    const symlinkVictim = Buffer.from('symlink-target-victim')

    const goodPut = await putTestBuffer(store, { bytes: goodBytes, linkedUserId: 'u1' })
    const corruptPut = await putTestBuffer(store, { bytes: corruptBytes, linkedUserId: 'u1' })
    const symlinkPut = await putTestBuffer(store, { bytes: symlinkVictim, linkedUserId: 'u1' })

    const storeDir = channelAttachmentStoreDir(tmpDir)
    // Case A: flip 1 byte on disk.
    const corruptPath = path.join(storeDir, corruptPut.storageRelPath)
    const tampered = Buffer.from(corruptBytes)
    tampered[0] = tampered[0]! ^ 0xff
    await fs.writeFile(corruptPath, tampered, { mode: 0o600 })

    await expect(
      store.readVerified(corruptPut.storageRelPath, corruptPut.sha256)
    ).rejects.toMatchObject({
      code: 'attachment_integrity_failed',
    })

    // Case B: swap committed blob with a symlink to a file outside the store.
    const outsideFile = path.join(tmpDir, 'outside-secret.txt')
    await fs.writeFile(outsideFile, 'top-secret', { mode: 0o600 })
    const symlinkPath = path.join(storeDir, symlinkPut.storageRelPath)
    await fs.unlink(symlinkPath)
    await fs.symlink(outsideFile, symlinkPath)

    await expect(
      store.readVerified(symlinkPut.storageRelPath, symlinkPut.sha256)
    ).rejects.toBeInstanceOf(PrivateStoreUntrustedError)

    // Liveness witness: untampered sibling still reads cleanly.
    const readGood = await store.readVerified(goodPut.storageRelPath, goodPut.sha256)
    expect(readGood.equals(goodBytes)).toBe(true)
  })

  it('S71 & S77: rotates ended session under partial unique index without crash while preserving cancelled-approval idle sessions and linked_user_id FTS isolation', async () => {
    const deps = createDispatcher(db)
    const sessionKey = 'u-prov:telegram:chat-rotate'
    const sessionA = makeSessionRow({
      id: 'sess-user-a',
      session_key: sessionKey,
      user_id: 'u-prov',
      linked_user_id: 'linked-user-a',
      state: 'idle',
    })
    await dispatch({ kind: 'insert_session', payload: sessionA }, deps)
    await dispatch(
      {
        kind: 'insert_message',
        payload: {
          session_id: sessionA.id,
          ordinal: 0,
          role: 'user',
          content: 'ALPHA-SENTINEL-SECRET-771',
          content_parts: null,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1_700_000_001,
          token_count: null,
          finish_reason: null,
          spillover_ref: null,
          is_error: 0,
          turn_number: 1,
        },
      },
      deps
    )

    // Rotate session A -> state='ended', ended_at=now.
    const rotated = (await dispatch(
      {
        kind: 'rotate_session_on_identity_change',
        sessionKey,
        expectedLinkedUserId: 'linked-user-b',
        endedAt: 1_700_000_050,
        endReason: 'identity_changed',
      },
      deps
    )) as RotateSessionOnIdentityChangeResult
    expect(rotated).toEqual({ rotated: true, endedSessionId: sessionA.id })

    // Insert User B's fresh active session under identical session_key (partial unique index allows this!).
    const sessionB = makeSessionRow({
      id: 'sess-user-b',
      session_key: sessionKey,
      user_id: 'u-prov',
      linked_user_id: 'linked-user-b',
      state: 'idle',
    })
    await dispatch({ kind: 'insert_session', payload: sessionB }, deps)
    await dispatch(
      {
        kind: 'insert_message',
        payload: {
          session_id: sessionB.id,
          ordinal: 0,
          role: 'user',
          content: 'BETA-PUBLIC-MESSAGE-882',
          content_parts: null,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1_700_000_060,
          token_count: null,
          finish_reason: null,
          spillover_ref: null,
          is_error: 0,
          turn_number: 1,
        },
      },
      deps
    )

    const loadedActive = (await dispatch(
      { kind: 'load_active_session', sessionKey },
      deps
    )) as PersistedSession | null
    expect(loadedActive?.session.id).toBe(sessionB.id)
    expect(loadedActive?.session.linked_user_id).toBe('linked-user-b')
    expect(loadedActive?.messages).toHaveLength(1)

    const totalRows = (
      db.prepare('SELECT count(*) AS cnt FROM sessions WHERE session_key = ?').get(sessionKey) as {
        cnt: number
      }
    ).cnt
    expect(totalRows).toBe(2)

    // FTS linked_user_id isolation: User B gets 0 hits for User A's sentinel; User A gets 1 hit.
    const ftsUserB = (await dispatch(
      {
        kind: 'fts_search_messages',
        query: 'ALPHA',
        userId: 'u-prov',
        linkedUserId: 'linked-user-b',
        limit: 10,
      },
      deps
    )) as SearchMessageRow[]
    expect(ftsUserB).toHaveLength(0)

    const ftsUserA = (await dispatch(
      {
        kind: 'fts_search_messages',
        query: 'ALPHA',
        userId: 'u-prov',
        linkedUserId: 'linked-user-a',
        limit: 10,
      },
      deps
    )) as SearchMessageRow[]
    expect(ftsUserA).toHaveLength(1)
    expect(ftsUserA[0]!.session_id).toBe(sessionA.id)

    // S77: Desktop rpc chat that cancelled during approval has ended_at set while state='idle'
    // and MUST remain visible to selectSessionBySessionKey and selectSessionSummariesByPrefix.
    const desktopKey = 'desktop-user-1:rpc:agent-a:chat-99'
    const desktopSession = makeSessionRow({
      id: 'sess-desktop-1',
      session_key: desktopKey,
      source: 'rpc',
      user_id: 'desktop-user-1',
      channel_type: 'rpc',
      channel_id: 'agent-a',
      thread_id: 'chat-99',
      state: 'idle',
      ended_at: 1_700_000_100,
      end_reason: 'cancelled',
      linked_user_id: null,
    })
    await dispatch({ kind: 'insert_session', payload: desktopSession }, deps)

    const loadedDesktop = (await dispatch(
      { kind: 'load_active_session', sessionKey: desktopKey },
      deps
    )) as PersistedSession | null
    expect(loadedDesktop?.session.id).toBe(desktopSession.id)

    const summaries = (await dispatch(
      {
        kind: 'list_session_summaries_by_prefix',
        sessionKeyPrefix: 'desktop-user-1:rpc:',
        userId: 'desktop-user-1',
      },
      deps
    )) as PersistedSessionSummary[]
    expect(summaries.map(s => s.session.id)).toEqual([desktopSession.id])

    // Atomic end_obsolete_approval_session ends session + clears pending_approvals in one tx.
    const endedRes = (await dispatch(
      {
        kind: 'end_obsolete_approval_session',
        sessionKey,
        endedAt: 1_700_000_200,
        endReason: 'identity_revoked',
      },
      deps
    )) as EndObsoleteApprovalSessionResult
    expect(endedRes).toEqual({ ended: true, sessionId: sessionB.id })
    const afterEnd = (await dispatch(
      { kind: 'load_active_session', sessionKey },
      deps
    )) as PersistedSession | null
    expect(afterEnd).toBeNull()
  })

  it('normalizeChannelFilename & validateStrictChannelImageContainer handle edge cases cleanly', () => {
    // Null/empty/traversal/control-char/300-char names all pass resourceNameProblem === null.
    const cases = [
      normalizeChannelFilename(null, 'jpeg', 'abc12345'),
      normalizeChannelFilename('Q1/2026\x00report.pdf', 'pdf', 'abc12345'),
      normalizeChannelFilename('..', 'binary_unsupported', 'abc12345'),
      normalizeChannelFilename('.', 'text', 'abc12345'),
      normalizeChannelFilename(`${'a'.repeat(300)}.pdf`, 'pdf', 'abc12345'),
      normalizeChannelFilename('caf\u0065\u0301\\notes.txt', 'text', 'abc12345'),
    ]
    expect(cases[0]).toBe('attachment-abc12345.jpg')
    expect(cases[1]).toBe('Q1_2026report.pdf')
    expect(cases[2]).toBe('attachment-abc12345.bin')
    expect(cases[4]!.endsWith('.pdf')).toBe(true)
    expect([...cases[4]!].length).toBeLessThanOrEqual(255)
    for (const name of cases) {
      expect(resourceNameProblem(name)).toBeNull()
    }

    // Strict JPEG/PNG framing validation.
    const validPng = Buffer.from(PNG_2X2_BASE64, 'base64')
    const validJpeg = Buffer.from(JPEG_2X2_BASE64, 'base64')
    expect(validateStrictChannelImageContainer(validPng, 'png')).toEqual({
      width: 2,
      height: 2,
      visualValid: true,
    })
    expect(validateStrictChannelImageContainer(validJpeg, 'jpeg')).toEqual({
      width: 2,
      height: 2,
      visualValid: true,
    })

    // Motion-Photo JPEG: trailing bytes after EOI -> visualValid: false.
    const motionPhoto = Buffer.concat([validJpeg, Buffer.from('mp4-trailing-bytes')])
    expect(validateStrictChannelImageContainer(motionPhoto, 'jpeg').visualValid).toBe(false)

    // Truncated JPEG missing EOI -> visualValid: false.
    expect(
      validateStrictChannelImageContainer(validJpeg.subarray(0, validJpeg.length - 2), 'jpeg')
        .visualValid
    ).toBe(false)

    // PNG missing IDAT -> visualValid: false.
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdrData = Buffer.alloc(13)
    ihdrData.writeUInt32BE(2, 0)
    ihdrData.writeUInt32BE(2, 4)
    const ihdrChunk = Buffer.concat([
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('IHDR', 'latin1'),
      ihdrData,
      Buffer.alloc(4),
    ])
    const iendChunk = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('IEND', 'latin1'),
      Buffer.alloc(4),
    ])
    const idatlessPng = Buffer.concat([pngSignature, ihdrChunk, iendChunk])
    expect(validateStrictChannelImageContainer(idatlessPng, 'png').visualValid).toBe(false)
  })

  it('T-BR12: concurrent first putStream calls await single-flight scanHostUsageOnce so hostQuotaBytes cannot be bypassed', async () => {
    const storeDir = channelAttachmentStoreDir(tmpDir)
    await fs.mkdir(storeDir, { recursive: true, mode: 0o700 })
    await fs.chmod(storeDir, 0o700)
    // Pre-populate 900 bytes on disk with hostQuotaBytes = 1000 (100 bytes remaining).
    await fs.writeFile(path.join(storeDir, `${randomUUID()}.bin`), Buffer.alloc(900, 0x41), {
      mode: 0o600,
    })

    const freshStore = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      hostQuotaBytes: 1000,
      userQuotaBytes: 1000,
      statfsFn: HEALTHY_STATFS,
    })

    const makeStream = (len: number) =>
      (async function* () {
        yield Buffer.alloc(len, 0x42)
      })()

    const results = await Promise.allSettled([
      freshStore.putStream({
        stream: makeStream(200),
        linkedUserId: 'linked-user-a',
        declaredBytes: 200,
      }),
      freshStore.putStream({
        stream: makeStream(200),
        linkedUserId: 'linked-user-b',
        declaredBytes: 200,
      }),
    ])
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'quota_exceeded' })
    }

    // Liveness witness: smaller blob within remaining 100 bytes succeeds.
    const small = await putTestBuffer(freshStore, {
      bytes: Buffer.alloc(80, 0x43),
      linkedUserId: 'linked-user-a',
    })
    expect(small.byteLength).toBe(80)
  })

  it('BR-T6: enforces hostQuotaBytes, per-user userQuotaBytes, and cleanupOrphanPartials (preserving active partials)', async () => {
    const store = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      hostQuotaBytes: 1000,
      userQuotaBytes: 400,
      statfsFn: HEALTHY_STATFS,
    })

    // User A fills 300/400 userQuotaBytes.
    const a1 = await putTestBuffer(store, {
      bytes: Buffer.alloc(300, 0x11),
      linkedUserId: 'linked-user-a',
    })
    expect(a1.byteLength).toBe(300)

    // User A next 150 bytes breaches userQuotaBytes (300 + 150 > 400).
    await expect(
      putTestBuffer(store, {
        bytes: Buffer.alloc(150, 0x12),
        linkedUserId: 'linked-user-a',
      })
    ).rejects.toMatchObject({ code: 'quota_exceeded' })

    // Liveness witness: User B still has 400-byte user quota and host has 700 bytes left.
    const b1 = await putTestBuffer(store, {
      bytes: Buffer.alloc(400, 0x21),
      linkedUserId: 'linked-user-b',
    })
    expect(b1.byteLength).toBe(400)

    // Host now has 700/1000 bytes committed -> User C requesting 350 breaches hostQuotaBytes.
    await expect(
      putTestBuffer(store, {
        bytes: Buffer.alloc(350, 0x31),
        linkedUserId: 'linked-user-c',
      })
    ).rejects.toMatchObject({ code: 'quota_exceeded' })

    // cleanupOrphanPartials: seed a stale .partial and hold an active in-flight putStream.
    const storeDir = channelAttachmentStoreDir(tmpDir)
    const stalePartial = `${randomUUID()}.partial`
    await fs.writeFile(path.join(storeDir, stalePartial), Buffer.from('stale'), { mode: 0o600 })

    let releaseActive!: () => void
    const activeGate = new Promise<void>(resolve => {
      releaseActive = resolve
    })
    let chunkWritten!: () => void
    const chunkWrittenPromise = new Promise<void>(resolve => {
      chunkWritten = resolve
    })
    const activeId = randomUUID()
    const activePut = store.putStream({
      attachmentId: activeId,
      linkedUserId: 'linked-user-c',
      declaredBytes: 50,
      stream: (async function* () {
        yield Buffer.alloc(25, 0x55)
        chunkWritten()
        await activeGate
        yield Buffer.alloc(25, 0x56)
      })(),
    })

    await chunkWrittenPromise
    await new Promise(resolve => setTimeout(resolve, 20))

    // Run cleanup with graceWindowMs=0 while activeId.partial is in flight.
    const cleanup = await store.cleanupOrphanPartials(0)
    expect(cleanup.removed).toBe(1)

    const entriesDuring = await fs.readdir(storeDir)
    expect(entriesDuring).not.toContain(stalePartial)
    expect(entriesDuring).toContain(`${activeId}.partial`)

    releaseActive()
    const activeRes = await activePut
    expect(activeRes.byteLength).toBe(50)
  })
})
