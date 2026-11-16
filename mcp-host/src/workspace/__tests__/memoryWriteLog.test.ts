import { describe, expect, it } from 'vitest'
import type { WorkerOp } from '../../db/worker/protocol'
import { type MemoryWriteEntry, SqliteMemoryWriteLog } from '../memoryWriteLog'

// The adapter's column mapping, field by field. The real-worker test proves the
// row lands; this one proves each entry field reaches its own column.

function capturingQueue() {
  const ops: WorkerOp[] = []
  return {
    ops,
    queue: {
      async enqueueSync<T = unknown>(op: WorkerOp): Promise<T> {
        ops.push(op)
        return undefined as T
      },
    },
  }
}

describe('SqliteMemoryWriteLog', () => {
  it.each<[string, MemoryWriteEntry]>([
    [
      'collective replace',
      {
        userKey: '0123456789abcdef',
        scope: 'collective',
        relativePath: 'memories/team.md',
        mode: 'replace',
        contentSha256: 'ab'.repeat(32),
        writtenAt: 1_700_000_000.25,
      },
    ],
    [
      'user append',
      {
        userKey: 'fedcba9876543210',
        scope: 'user',
        relativePath: 'memory/notes.md',
        mode: 'append',
        contentSha256: 'cd'.repeat(32),
        writtenAt: 1_700_000_123.5,
      },
    ],
  ])('maps every field of a %s entry to its column', async (_label, entry) => {
    const { ops, queue } = capturingQueue()
    await new SqliteMemoryWriteLog(queue).record(entry)
    expect(ops).toEqual([
      {
        kind: 'insert_memory_write',
        payload: {
          user_key: entry.userKey,
          scope: entry.scope,
          relative_path: entry.relativePath,
          mode: entry.mode,
          content_sha256: entry.contentSha256,
          written_at: entry.writtenAt,
        },
      },
    ])
  })
})
