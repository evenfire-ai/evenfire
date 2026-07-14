/**
 * T1.5 §6.3 — `executeSingleTool` cross-cover with the real `SpilloverStorage`.
 *
 * These tests don't mock the storage — they spin a tmp workspace, drive a
 * single tool through `executeSingleTool`, and inspect both the returned
 * `ToolResult` and the on-disk blob.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type { Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import { SpilloverStorage } from '../../spillover'
import type { ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { executeSingleTool } from '../toolUseLoop'

function tool(name: string, output: string, isError = false): Tool {
  return {
    name: () => name,
    description: () => `Mock ${name}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    requiresSanitization: () => false,
    requiresApproval: () => false,
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({ content: output, duration_ms: 1, is_error: isError })
    ),
  }
}

function registry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map(t => [t.name(), t]))
  return {
    get: name => map.get(name) ?? null,
    listDefinitions: () =>
      tools.map(t => ({
        name: t.name(),
        description: t.description(),
        parameters: t.parametersSchema(),
      })),
    register: vi.fn(),
  }
}

function configFor(deps: {
  tools: Tool[]
  storage?: SpilloverStorage
  taskId?: string
  events?: SimpleEventEmitter
}) {
  const safety = new BasicSafety()
  return {
    toolRegistry: registry(deps.tools),
    toolOutputProcessor: new DefaultToolOutputProcessor(safety),
    safety,
    events: deps.events ?? new SimpleEventEmitter(),
    toolTimeout: 1000,
    progressReporter: undefined,
    toolProgressInterval: 0,
    spilloverStorage: deps.storage,
    taskId: deps.taskId,
  }
}

describe('executeSingleTool — T1.5 spillover wiring', () => {
  let workspace: string
  let storage: SpilloverStorage

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tooluseloop-spill-'))
    storage = new SpilloverStorage({
      workspacePath: workspace,
      thresholdBytes: 64,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
  })

  afterEach(async () => {
    storage.stopGc()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('persists oversized output and replaces content with the summary JSON', async () => {
    const big = 'X'.repeat(512)
    const events = new SimpleEventEmitter()
    const eventTypes: string[] = []
    events.on('spillover:persisted', e => eventTypes.push(e.type))

    const result = await executeSingleTool(
      { id: 'call-1', name: 'file_read', arguments: {} },
      configFor({ tools: [tool('file_read', big)], storage, taskId: 'taskA', events })
    )

    expect(result.is_error).toBe(false)
    expect(result.spillover_ref).toBe('spillover://taskA/call-1.json')
    const parsed = JSON.parse(result.content)
    expect(parsed.spillover_ref).toBe('spillover://taskA/call-1.json')
    expect(parsed.byte_size).toBe(big.length)
    expect(typeof parsed.head).toBe('string')
    expect(typeof parsed.fingerprint_sha256).toBe('string')
    expect(result.rawContent).toBe(big) // UI sees the real output
    expect(eventTypes).toContain('spillover:persisted')
  })

  it('ships content inline when below threshold (no spillover ref)', async () => {
    const small = 'tiny'
    const result = await executeSingleTool(
      { id: 'call-1', name: 'file_read', arguments: {} },
      configFor({ tools: [tool('file_read', small)], storage, taskId: 'taskA' })
    )
    expect(result.content).toBe(small)
    expect(result.spillover_ref).toBeUndefined()
  })

  it('never spills error outputs even if oversized', async () => {
    const big = 'ERR' + 'X'.repeat(512)
    const result = await executeSingleTool(
      { id: 'call-1', name: 'file_read', arguments: {} },
      configFor({ tools: [tool('file_read', big, true)], storage, taskId: 'taskA' })
    )
    expect(result.is_error).toBe(true)
    expect(result.content).toBe(big)
    expect(result.spillover_ref).toBeUndefined()
  })

  it('never spills the output of clerum__spillover_read (no recursion)', async () => {
    const big = 'X'.repeat(512)
    const result = await executeSingleTool(
      { id: 'call-1', name: 'clerum__spillover_read', arguments: {} },
      configFor({
        tools: [tool('clerum__spillover_read', big)],
        storage,
        taskId: 'taskA',
      })
    )
    expect(result.content).toBe(big)
    expect(result.spillover_ref).toBeUndefined()
  })

  it('skips spillover entirely when storage is undefined (pre-T1.5 behavior)', async () => {
    const big = 'X'.repeat(512)
    const result = await executeSingleTool(
      { id: 'call-1', name: 'file_read', arguments: {} },
      configFor({ tools: [tool('file_read', big)] })
    )
    expect(result.content).toBe(big)
    expect(result.spillover_ref).toBeUndefined()
  })
})
