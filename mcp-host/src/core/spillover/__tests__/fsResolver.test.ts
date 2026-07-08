import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ApprovalExpiredError } from '../../types'
import { FsSpilloverResolver } from '../fsResolver'
import { SpilloverStorage } from '../storage'

describe('FsSpilloverResolver', () => {
  let workspace: string
  let storage: SpilloverStorage
  let resolver: FsSpilloverResolver

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'spillover-resolver-'))
    storage = new SpilloverStorage({
      workspacePath: workspace,
      thresholdBytes: 8,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
    resolver = new FsSpilloverResolver({ storage })
  })

  afterEach(async () => {
    storage.stopGc()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('passes through inline messages unchanged (no spillover_ref)', async () => {
    const out = await resolver.resolve({ content: 'inline body', spillover_ref: undefined })
    expect(out).toBe('inline body')
  })

  it('swaps in the blob content when ref is alive', async () => {
    const summary = await storage.maybePersist({
      taskId: 'task-1',
      toolCallId: 'call-1',
      toolName: 'file_read',
      content: 'A'.repeat(64),
      isError: false,
    })
    const out = await resolver.resolve({
      content: '<summary>',
      spillover_ref: summary!.spillover_ref,
    })
    expect(out).toBe('A'.repeat(64))
  })

  it('throws ApprovalExpiredError when ref is missing', async () => {
    await expect(
      resolver.resolve({ content: '<summary>', spillover_ref: 'spillover://task-1/missing.json' })
    ).rejects.toBeInstanceOf(ApprovalExpiredError)
  })

  it('attaches context to the error when run inside withContext', async () => {
    await expect(
      resolver.withContext({ taskId: 't1', requestId: 'r1', toolName: 'file_read' }, () =>
        resolver.resolve({
          content: '<summary>',
          spillover_ref: 'spillover://t1/missing.json',
        })
      )
    ).rejects.toMatchObject({
      payload: {
        code: 'approval_expired',
        task_id: 't1',
        request_id: 'r1',
        tool_name: 'file_read',
        expired_refs: ['spillover://t1/missing.json'],
      },
    })
  })

  it('probe splits refs into alive vs expired', async () => {
    const summary = await storage.maybePersist({
      taskId: 'task-1',
      toolCallId: 'call-1',
      toolName: 'file_read',
      content: 'A'.repeat(64),
      isError: false,
    })
    const { alive, expired } = await resolver.probe([
      summary!.spillover_ref,
      'spillover://task-1/missing.json',
    ])
    expect(alive).toEqual([summary!.spillover_ref])
    expect(expired).toEqual(['spillover://task-1/missing.json'])
  })
})
