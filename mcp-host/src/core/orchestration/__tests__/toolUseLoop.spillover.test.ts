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
import { parseCodexCompletionRequestV1 } from '@clerum/llm-provider-attempt-contract'
import { createToolDescribeTool } from '../../../capabilities/toolCatalogTools'
import type { Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import { SpilloverStorage } from '../../spillover'
import { SpilloverReadTool } from '../../tools/spilloverRead'
import type { ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { DefaultLoopController } from '../loopConfig'
import { executeSingleTool } from '../toolUseLoop'
import { executeToolCalls } from '../toolUseLoopToolBatch'

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

  it('keeps a large discovered schema exact in spillover rather than flooding the next model request', async () => {
    const schema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `field_${i}`,
          { type: 'string', description: `Field ${i}` },
        ])
      ),
    }
    const describe = createToolDescribeTool(() => [
      { name: 'fixture__large_schema', serverName: 'fixture', inputSchema: schema },
    ])
    const definition = tool(describe.name, '')
    definition.execute = async args => {
      const result = await describe.execute(args, workspace)
      return {
        content: result.content ?? result.error ?? '',
        duration_ms: 0,
        is_error: !result.success,
      }
    }
    const result = await executeSingleTool(
      { id: 'describe-large', name: describe.name, arguments: { name: 'fixture__large_schema' } },
      configFor({ tools: [definition], storage, taskId: 'schema-task' })
    )
    expect(result.is_error).toBe(false)
    expect(result.spillover_ref).toBeDefined()
    expect(Buffer.byteLength(result.content)).toBeLessThan(8192)
    const saved = await storage.load(result.spillover_ref!)
    expect(JSON.parse(saved!.content).parameters).toEqual(schema)
    expect(JSON.parse(saved!.content).name).toBe('fixture__large_schema')
    const reader = new SpilloverReadTool(storage)
    const read = await executeSingleTool(
      { id: 'read-schema', name: reader.name(), arguments: { ref: result.spillover_ref } },
      configFor({ tools: [reader], storage, taskId: 'schema-task' })
    )
    expect(read.is_error).toBe(false)
    expect(read.spillover_ref).toBeUndefined()
    expect(read.content).toContain(JSON.stringify(schema))
    const request = parseCodexCompletionRequestV1({
      schemaVersion: 'codex-completion-request.v1',
      provider: 'codex-subscription',
      model: 'gpt-5.3-codex',
      requestId: 'schema-read',
      idempotencyKey: 'schema-read',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'read-schema', name: reader.name(), arguments: { ref: result.spillover_ref } },
          ],
        },
        { role: 'tool', content: read.content, toolCallId: 'read-schema', name: reader.name() },
      ],
    })
    expect(request.ok).toBe(true)
    const target = tool('fixture__large_schema', 'business-result')
    const invoked = await executeToolCalls(
      [
        {
          id: 'business-call',
          name: 'clerum__tool_call',
          arguments: { name: target.name(), arguments: { field_0: 'selected' } },
        },
      ],
      {
        ...configFor({ tools: [target], taskId: 'schema-task' }),
        loopController: new DefaultLoopController(),
        bridge: {
          nativeNames: new Set([reader.name(), 'clerum__tool_call']),
          getDeferrableCatalogNames: () => new Set([target.name()]),
        },
      } as never,
      0
    )
    expect(target.execute).toHaveBeenCalledExactlyOnceWith(
      { field_0: 'selected' },
      expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) })
    )
    expect(invoked.toolResults[0]).toMatchObject({
      tool_call_id: 'business-call',
      name: target.name(),
      is_error: false,
    })
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
