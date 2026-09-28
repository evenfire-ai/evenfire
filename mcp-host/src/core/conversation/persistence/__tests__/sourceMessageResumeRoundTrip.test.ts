/**
 * #666 R4-M2 — a pending approval persists the sanitized source message, so a
 * cold restart rebuilds the file-reference pins instead of silently unpinning
 * every referenced file. The row is whatever persistSuspend actually maps, not
 * a hand-written fixture.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { prepareStatements } from '../../../../db/statements'
import type { PendingApprovalRow } from '../../../../db/worker/protocol'
import type { ResumeSourceMessage } from '../../../types'
import { ConversationManager } from '../../conversation'
import { reconstructPendingApproval } from '../reconstruct'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-r4m2:rpc:agent:default'
const FILE_BYTES = Buffer.from('SENTINEL-666-resume-bytes')

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
            id: 'gfs:main:123@v3',
            source: {
              kind: 'gfs',
              drive: 'main',
              resourceId: '123',
              gfsUri: 'gfs://main/123',
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
    expect(row.source_message).not.toContain(FILE_BYTES.toString('base64'))
    const rehydrated = reconstructPendingApproval(row)
    expect(rehydrated.sourceMessage).toEqual(sourceMessage)
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
