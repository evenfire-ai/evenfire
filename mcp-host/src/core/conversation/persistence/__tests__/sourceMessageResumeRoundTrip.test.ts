/**
 * #666 R4-M2 — a pending approval persists the sanitized source message, so a
 * cold restart rebuilds the file-reference pins instead of silently unpinning
 * every referenced file. The row is whatever persistSuspend actually maps, not
 * a hand-written fixture.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildGfsFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { sourceMessageForResume } from '../../../../agent/sourceMessageForResume'
import { prepareStatements } from '../../../../db/statements'
import type { PendingApprovalRow } from '../../../../db/worker/protocol'
import { referencedFilePins } from '../../../../internalTools/gfs'
import type { ResumeSourceMessage } from '../../../types'
import { ConversationManager } from '../../conversation'
import { reconstructPendingApproval } from '../reconstruct'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-r4m2:rpc:agent:default'
const FILE_BYTES = Buffer.from('SENTINEL-666-resume-bytes')
const RID = '0123456789abcdef0123456789abcdef'

let handle: StoreHandle | undefined
afterEach(async () => {
  await handle?.shutdown()
  handle = undefined
})

describe('#666 R4-M2 — source message resume round-trip', () => {
  it('persists the sanitized source message and reconstructs it', async () => {
    handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'read the notes', 'task-r4m2')

    const sourceMessage: ResumeSourceMessage = {
      content: 'read the notes',
      channelType: 'rpc',
      channelId: 'chatllm',
      sender: 'user-1',
      timestamp: '2026-09-28T10:00:00Z',
      messageId: 'message-1',
      hostRef: 'chatllm',
      attachments: [
        {
          id: 'file-1',
          kind: 'file',
          mimeType: 'text/plain',
          encoding: 'base64',
          filename: 'notes.txt',
          sizeBytes: FILE_BYTES.length,
        },
      ],
      fileReferenceResolutions: [
        {
          availability: 'available',
          reference: {
            schemaVersion: 1,
            id: `gfs:main:${RID}@v3`,
            source: {
              kind: 'gfs',
              drive: 'main',
              resourceId: RID,
              gfsUri: `gfs://main/${RID}`,
              version: 3,
            },
            name: 'notes.txt',
            declaredMediaType: null,
            detectedMediaType: 'text/plain',
            class: 'text',
            detection: 'text_utf8',
            mismatch: false,
            byteLength: 4,
            textReadable: true,
            reader: 'text',
            modelImageInput: 'unsupported',
          },
        },
      ],
    }
    const approval = {
      request_id: 'req-r4m2',
      tool_name: 'internal__do',
      parameters: {},
      description: 'Approve internal__do',
      tool_call_id: 'call-r4m2',
      context_snapshot: [],
      sourceMessage,
      task_budget: {
        elapsedActiveMs: 0,
        iterationsUsed: 1,
        durationMs: 86400000,
        maxIterations: 1000,
      },
    }
    await handle.store.persistSuspend(conv, approval)

    const s = prepareStatements(handle.worker.db)
    const row = s.selectPendingApprovalBySession.get(conv.id) as PendingApprovalRow
    expect(row.source_message).not.toBeNull()
    const rehydrated = reconstructPendingApproval(row)
    expect(rehydrated.sourceMessage).toEqual(sourceMessage)
    // The sanitizer itself is pinned in sourceMessageForResume.test.ts and the
    // executor call site in taskExecutor.test.ts; this fixture is hand-built, so
    // it only proves the column stores what it is given.
  })

  it('rebuilds the file version pins on the cold-start listing without the attachment bytes', async () => {
    const built = buildGfsFileReference({
      drive: 'main',
      resourceId: RID,
      gfsUri: `gfs://main/${RID}`,
      version: 3,
      name: 'notes.txt',
      declaredMediaType: null,
      byteLength: 4,
      classification: classifyBytes({
        bytes: new Uint8Array(0),
        totalByteLength: 4,
        declaredMediaType: null,
        filename: 'notes.txt',
      }),
    })
    if (!built.ok) throw new Error('fixture reference must build')

    handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'read the notes', 'task-cold')
    const incoming = {
      content: 'read the notes',
      channelType: 'rpc',
      channelId: 'chatllm',
      sender: 'user-1',
      timestamp: '2026-09-29T10:00:00Z',
      messageId: 'message-cold',
      attachments: [
        {
          id: 'file-1',
          kind: 'file',
          mimeType: 'text/plain',
          encoding: 'base64',
          filename: 'notes.txt',
          dataBase64: FILE_BYTES.toString('base64'),
        },
      ],
      fileReferences: [built.value],
      fileReferenceResolutions: [
        { availability: 'stale', reference: built.value, resolvedVersion: 5 },
      ],
    } as unknown as Parameters<typeof sourceMessageForResume>[0]
    await manager.suspendForApproval(conv, {
      request_id: 'req-cold',
      tool_name: 'internal__do',
      parameters: {},
      description: 'Approve internal__do',
      tool_call_id: 'call-cold',
      context_snapshot: [],
      sourceMessage: sourceMessageForResume(incoming),
      task_budget: {
        elapsedActiveMs: 0,
        iterationsUsed: 1,
        durationMs: 86400000,
        maxIterations: 1000,
      },
    })

    // A restarted pod has neither the cached conversation (whose in-memory
    // approval would be returned as is) nor its ordinals.
    handle.store['cache'].delete(SESSION_KEY)
    handle.store['ordinals'].clear()
    handle.store['sessionKeyById'].clear()

    const listings = await handle.store.loadAllPendingApprovals()
    // Liveness witness: the approval came back through the cold path.
    expect(listings).toHaveLength(1)
    const listed = listings[0]?.sourceMessage as ResumeSourceMessage | undefined
    expect(listed?.content).toBe('read the notes')
    expect(JSON.stringify(listed)).not.toContain(FILE_BYTES.toString('base64'))
    expect([...referencedFilePins(listed?.fileReferenceResolutions).values()]).toEqual([
      { version: 3, currentVersion: 5 },
    ])
  })

  it('fails loud on a corrupt source_message column instead of dropping the pins', async () => {
    handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'read the notes', 'task-corrupt')
    await handle.store.persistSuspend(conv, {
      request_id: 'req-corrupt',
      tool_name: 'internal__do',
      parameters: {},
      description: 'Approve internal__do',
      tool_call_id: 'call-corrupt',
      context_snapshot: [],
      sourceMessage: {
        content: 'read the notes',
        channelType: 'rpc',
        channelId: 'chatllm',
        sender: 'user-1',
        timestamp: '2026-09-28T10:00:00Z',
        messageId: 'message-1',
        hostRef: 'chatllm',
      },
      task_budget: {
        elapsedActiveMs: 0,
        iterationsUsed: 1,
        durationMs: 86400000,
        maxIterations: 1000,
      },
    })

    const s = prepareStatements(handle.worker.db)
    const row = s.selectPendingApprovalBySession.get(conv.id) as PendingApprovalRow
    // Liveness witness: the intact row reconstructs, so the throw below comes
    // from the corrupt column and not from an unrelated field.
    expect(reconstructPendingApproval(row).sourceMessage?.content).toBe('read the notes')
    expect(() => reconstructPendingApproval({ ...row, source_message: '{not json' })).toThrow()
  })

  it('reconstructs without a source message for legacy rows', async () => {
    handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'legacy approval', 'task-legacy')
    await handle.store.persistSuspend(conv, {
      request_id: 'req-legacy',
      tool_name: 'internal__do',
      parameters: {},
      description: 'Approve internal__do',
      tool_call_id: 'call-legacy',
      context_snapshot: [],
      task_budget: {
        elapsedActiveMs: 0,
        iterationsUsed: 1,
        durationMs: 86400000,
        maxIterations: 1000,
      },
    })

    const s = prepareStatements(handle.worker.db)
    const row = s.selectPendingApprovalBySession.get(conv.id) as PendingApprovalRow
    expect(row.source_message).toBeNull()
    expect(reconstructPendingApproval(row).sourceMessage).toBeUndefined()
  })
})
