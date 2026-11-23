/**
 * The typed-git redirect in the tool batch: its result shows as a tool step
 * in progress (start and complete, once), other admission results stay
 * silent, and compliance is counted on the next model turn's batch.
 */
import { describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import { GIT_REDIRECT_TEXT, gitRedirectCounter } from '../../approval/gitRedirect'
import type { Tool, ToolRegistry } from '../../interfaces'
import type { Conversation, ToolCall } from '../../types'
import type { LoopConfig } from '../loopConfig'
import { executeToolCalls } from '../toolUseLoopToolBatch'

function makeConfig(options: { validates?: boolean } = {}) {
  const gitRead = {
    name: () => 'git_read',
    requiresApproval: () => true,
    execute: async () => ({ content: 'git_read ran', duration_ms: 1, is_error: false }),
  } as unknown as Tool
  const toolRegistry: ToolRegistry = {
    get: name => (name === 'git_read' ? gitRead : null),
    listDefinitions: () => [],
    register: () => {},
  }
  const reportToolStart = vi.fn()
  const reportToolComplete = vi.fn()
  const conversation = {
    id: 'conv',
    auto_approved_tools: new Set<string>(),
  } as unknown as Conversation
  const config = {
    toolRegistry,
    conversation,
    safety: {
      sanitizeOutput: (_name: string, content: string) => ({
        content,
        was_modified: false,
        warnings: [],
      }),
      wrapForLlm: (_name: string, content: string) => content,
    },
    toolOutputProcessor: {
      beforeExecution: () =>
        options.validates === false
          ? { is_valid: false, errors: ['bad input'] }
          : { is_valid: true, errors: [] },
      afterExecution: (_name: string, out: { content: string }) => out.content,
    },
    events: { emit: () => {}, on: () => {}, off: () => {} },
    loopController: {
      shouldAccept: () => true,
      onTextRejected: () => null,
      onExhaustion: () => '',
      refreshTools: async (t: unknown) => t,
      beforeTool: (name: string, parameters: Record<string, unknown>, id: string) => ({
        type: 'suspend',
        cause: 'ordinary',
        approval: {
          request_id: `r-${id}`,
          tool_name: name,
          parameters,
          description: name,
          tool_call_id: id,
          context_snapshot: [],
        },
      }),
    },
    progressReporter: { reportToolStart, reportToolComplete },
    approvalMode: {
      storedMode: () => 'auto',
      ceiling: () => 'allow_all',
      channelCap: () => 'allow_all',
      classifierAvailable: () => false,
      classify: async () => 'APPROVE',
      approvalTools: () => undefined,
    },
    toolTimeout: 5000,
    toolProgressInterval: 0,
    maxIterations: 5,
  } as unknown as LoopConfig
  return { config, reportToolStart, reportToolComplete, conversation }
}

const shell = (command: string, id: string): ToolCall => ({
  id,
  name: 'shell_exec',
  arguments: { command },
})

async function followed(): Promise<Record<string, number>> {
  const metric = await (register.getSingleMetric('git_redirect_total') ?? gitRedirectCounter).get()
  return Object.fromEntries(metric.values.map(v => [String(v.labels.followed), v.value]))
}

describe('typed-git redirect in the tool batch', () => {
  it('a reported result emits one start and one complete with its literal content', async () => {
    const { config, reportToolStart, reportToolComplete } = makeConfig()
    const { toolResults } = await executeToolCalls([shell('git status', 'c1')], config, 0)
    expect(toolResults).toEqual([
      { tool_call_id: 'c1', name: 'shell_exec', content: GIT_REDIRECT_TEXT, is_error: false },
    ])
    expect(reportToolStart).toHaveBeenCalledTimes(1)
    expect(reportToolStart.mock.calls[0][0]).toMatchObject({
      toolCallId: 'c1',
      toolName: 'shell_exec',
    })
    expect(reportToolComplete).toHaveBeenCalledTimes(1)
    expect(reportToolComplete.mock.calls[0][0]).toMatchObject({
      toolCallId: 'c1',
      toolName: 'shell_exec',
      isError: false,
    })
    expect(JSON.stringify(reportToolComplete.mock.calls[0][0].outputPreview)).toContain(
      'Not run. In auto approval mode'
    )
  })

  it('a result that is not reported emits nothing', async () => {
    const { config, reportToolStart, reportToolComplete } = makeConfig({ validates: false })
    const { toolResults } = await executeToolCalls([shell('git status', 'c1')], config, 0)
    expect(toolResults[0]).toMatchObject({ is_error: true })
    expect(reportToolStart).not.toHaveBeenCalled()
    expect(reportToolComplete).not.toHaveBeenCalled()
  })

  it('a git_read call through the discovery bridge counts as followed', async () => {
    gitRedirectCounter.reset()
    const { config } = makeConfig()
    await executeToolCalls([shell('git status', 'c1')], config, 0)
    await executeToolCalls(
      [
        {
          id: 'b1',
          name: 'clerum__tool_call',
          arguments: { name: 'git_read', arguments: { subcommand: 'status' } },
        },
      ],
      config,
      1
    )
    expect(await followed()).toEqual({ yes: 1 })
  })

  it('counts on the next batch whether the model called git_read, once', async () => {
    gitRedirectCounter.reset()
    const { config, conversation } = makeConfig()
    await executeToolCalls([shell('git status', 'c1'), shell('git log', 'c2')], config, 0)
    // The redirect's own batch does not count itself.
    expect(await followed()).toEqual({})
    expect(conversation.git_redirect_pending).toBe(true)

    await executeToolCalls(
      [{ id: 'g1', name: 'git_read', arguments: { subcommand: 'status' } }],
      config,
      1
    )
    expect(await followed()).toEqual({ yes: 1 })
    expect(conversation.git_redirect_pending).toBe(false)

    await executeToolCalls([shell('git diff', 'c3')], config, 2)
    await executeToolCalls([shell('ls', 'c4')], config, 3)
    expect(await followed()).toEqual({ yes: 1, no: 1 })
  })
})
