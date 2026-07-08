import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { SpilloverStorage } from '../../spillover'
import { SpilloverReadTool } from '../spilloverRead'

describe('SpilloverReadTool', () => {
  let workspace: string
  let storage: SpilloverStorage
  let tool: SpilloverReadTool

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'spillover-read-tool-'))
    storage = new SpilloverStorage({
      workspacePath: workspace,
      thresholdBytes: 8,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
    tool = new SpilloverReadTool(storage)
  })

  afterEach(async () => {
    storage.stopGc()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('declares safe defaults (sanitize, no approval)', () => {
    expect(tool.name()).toBe('clerum__spillover_read')
    expect(tool.requiresSanitization()).toBe(true)
    expect(tool.requiresApproval()).toBe(false)
  })

  it('returns the full blob content for a valid ref', async () => {
    const body = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const summary = await storage.maybePersist({
      taskId: 'taskA',
      toolCallId: 'call1',
      toolName: 'file_read',
      content: body,
      isError: false,
    })
    const out = await tool.execute({ ref: summary!.spillover_ref })
    expect(out.is_error).toBe(false)
    expect(out.content).toBe(body)
  })

  it('returns a byte-accurate slice for a valid range', async () => {
    const body = 'ABCDEFGHIJ'
    const summary = await storage.maybePersist({
      taskId: 'taskA',
      toolCallId: 'call1',
      toolName: 'file_read',
      content: body,
      isError: false,
    })
    const out = await tool.execute({
      ref: summary!.spillover_ref,
      range: { start: 2, end: 6 },
    })
    expect(out.is_error).toBe(false)
    expect(out.content).toBe('CDEF')
  })

  it('errors on invalid ranges', async () => {
    const summary = await storage.maybePersist({
      taskId: 'taskA',
      toolCallId: 'call1',
      toolName: 'file_read',
      content: 'X'.repeat(100),
      isError: false,
    })
    const out = await tool.execute({
      ref: summary!.spillover_ref,
      range: { start: 50, end: 10 },
    })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/invalid range/)
  })

  it('errors when ref is missing or malformed', async () => {
    const out1 = await tool.execute({})
    expect(out1.is_error).toBe(true)
    expect(out1.content).toMatch(/missing or invalid `ref`/)

    const out2 = await tool.execute({ ref: 'not-a-uri' })
    expect(out2.is_error).toBe(true)
    expect(out2.content).toMatch(/not found or expired/)
  })

  it('errors when the blob has been deleted (TTL)', async () => {
    const summary = await storage.maybePersist({
      taskId: 'taskA',
      toolCallId: 'call1',
      toolName: 'file_read',
      content: 'X'.repeat(100),
      isError: false,
    })
    await storage._testOnlyDelete('taskA', 'call1')
    const out = await tool.execute({ ref: summary!.spillover_ref })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/not found or expired/)
  })
})
