import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { UnifiedApprovalGateController } from '../../extensions/mcpApprovalGateController'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { ShellTool } from '../../tools/shell'
import type { AgentEvent, RespondResult } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

// Real processes would run; the spy only observes whether one was started.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

let workspacePath: string

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'clerum-shell-nul-loop-'))
  vi.mocked(spawn).mockClear()
})

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true })
})

function scriptedReasoning(results: RespondResult[]): ReasoningPort {
  let index = 0
  const next = async (): Promise<RespondResult> =>
    results[index++] ?? { type: 'error', error: new Error('No more results') }
  return { respondWithTools: vi.fn(next), continueWithToolResults: vi.fn(next) }
}

function registryWith(tool: Tool): ToolRegistry {
  return {
    get: (name: string) => (name === tool.name() ? tool : null),
    listDefinitions: () => [
      { name: tool.name(), description: tool.description(), parameters: tool.parametersSchema() },
    ],
    register: vi.fn(),
  }
}

async function runShellCall(command: string) {
  const registry = registryWith(new ShellTool(workspacePath, 5_000, ['PATH']))
  const reasoning = scriptedReasoning([
    { type: 'tool_calls', calls: [{ id: 'tc_nul', name: 'shell_exec', arguments: { command } }] },
    { type: 'text', content: 'done' },
  ])
  const events = new SimpleEventEmitter()
  const blocked: AgentEvent[] = []
  events.on('safety:input_blocked', event => blocked.push(event))
  const config = buildLoopConfig({
    reasoning,
    toolRegistry: registry,
    safety: new BasicSafety(),
    events,
    conversation: makeFakeConversation(),
    loopController: new UnifiedApprovalGateController(registry),
  })
  const result = await runToolUseLoop(config, [{ role: 'user', content: 'run it' }])
  return { result, blocked, reasoning }
}

describe('shell_exec NUL commands through the tool loop (#1020)', () => {
  it('X5: BasicSafety rejects a NUL command before approval and no process is spawned', async () => {
    const { result, blocked, reasoning } = await runShellCall('printf a\0b')

    expect(result.type).not.toBe('need_approval')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.data).toMatchObject({
      toolName: 'shell_exec',
      errors: ['shell_exec.command must not contain NUL characters'],
    })
    // Witness: the loop reached the model again with the validation error as the tool result.
    expect(reasoning.continueWithToolResults).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(reasoning.continueWithToolResults).mock.calls[0])).toContain(
      'Parameter validation failed: shell_exec.command must not contain NUL characters'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('X5 witness: the same command without NUL reaches approval', async () => {
    const { result, blocked } = await runShellCall('printf ab')

    expect(blocked).toEqual([])
    expect(result.type).toBe('need_approval')
    if (result.type === 'need_approval') {
      expect(result.approval.tool_name).toBe('shell_exec')
      expect(result.approval.tool_call_id).toBe('tc_nul')
    }
    expect(spawn).not.toHaveBeenCalled()
  })
})
