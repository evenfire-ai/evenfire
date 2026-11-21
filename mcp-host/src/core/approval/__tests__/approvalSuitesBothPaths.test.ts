/**
 * Admission-level cases from sessionScopedApproval, deniedToolRerun.repro, and
 * approvedToolsLifecycle, through admitToolCall with the mode unset and manual.
 * The original suites stay unchanged.
 */
import { describe, expect, it } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { ApprovalController } from '../../extensions/approvalController'
import { UnifiedApprovalGateController } from '../../extensions/mcpApprovalGateController'
import type { Tool, ToolRegistry } from '../../interfaces'
import type { LoopConfig } from '../../orchestration/loopConfig'
import { admitToolCall } from '../../orchestration/toolCallPolicy'
import type { ToolCall } from '../../types'
import type { ApprovalModeInputs } from '../gateCause'

const FINDER = 'evenreach-finder__find_company_people'
const SEARCH = 'evenreach-query__search_crm'
const CREATE = 'evenreach-query__create_contact'
const SELECTED = 'alpha__record__read_082'

const manualMode: ApprovalModeInputs = {
  storedMode: () => 'manual',
  ceiling: () => 'manual',
  channelCap: () => 'allow_all',
  classifierAvailable: () => false,
  classify: async () => 'ESCALATE',
}

function tool(name: string, requiresApproval: boolean): Tool {
  return {
    name: () => name,
    description: () => name,
    parametersSchema: () => ({ type: 'object' }),
    requiresSanitization: () => false,
    requiresApproval: () => requiresApproval,
    execute: async () => ({ content: 'ran', is_error: false, duration_ms: 0 }),
  }
}

function registry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map(item => [item.name(), item]))
  return { get: name => byName.get(name) ?? null, listDefinitions: () => [], register: () => {} }
}

async function admit(
  mode: 'unset' | 'manual',
  tools: Tool[],
  call: ToolCall,
  options?: {
    approvalConfig?: ConstructorParameters<typeof UnifiedApprovalGateController>[1]
    task?: string[]
    always?: string[]
    denials?: Array<[string, string]>
  }
) {
  const reg = registry(tools)
  const conversation = makeFakeConversation({
    task_approved_tools: new Set(options?.task ?? []),
    auto_approved_tools: new Set(options?.always ?? []),
    denials: new Map(options?.denials ?? []),
  })
  const gate = new UnifiedApprovalGateController(reg, options?.approvalConfig)
  const controller = new ApprovalController(conversation, gate, {
    ...(mode === 'manual' ? { modeAware: true } : {}),
  })
  const config = {
    reasoning: {} as never,
    toolRegistry: reg,
    safety: {} as never,
    events: { emit: () => {}, on: () => {}, off: () => {} },
    conversation,
    loopController: controller,
    contextManager: {} as never,
    toolOutputProcessor: {
      beforeExecution: () => ({ is_valid: true, errors: [] }),
      afterExecution: (_name: string, output: { content: string }) => output.content,
    },
    maxIterations: 2,
    toolTimeout: 1000,
    toolProgressInterval: 0,
    ...(mode === 'manual' ? { approvalMode: manualMode } : {}),
  } as LoopConfig
  return admitToolCall(call, config, 0)
}

const scopedTools = {
  defaultPolicy: 'channel_users' as const,
  channels: {},
  tools: { shell_exec: true, http_request: true, cron_manage: true, workflow_trigger: true },
}

describe.each(['unset', 'manual'] as const)('admission suites on the %s path', mode => {
  it('an MCP approval suspends that call only', async () => {
    const tools = [tool('mongodb-server__find', false), tool('mongodb-server__insert_many', false)]
    const first = await admit(mode, tools, {
      id: 'tc-find',
      name: 'mongodb-server__find',
      arguments: {},
    })
    expect(first.kind).toBe('suspend')
    if (first.kind === 'suspend') expect(first.approval.authorization_scope).toBe('turn_tools')
    const granted = await admit(
      mode,
      tools,
      { id: 'tc-insert', name: 'mongodb-server__insert_many', arguments: {} },
      { task: ['mongodb-server__find'] }
    )
    expect(granted.kind).toBe('suspend')
  })

  it('a shell task grant covers shell only, and workflow grants nothing until Always', async () => {
    const tools = [
      tool('shell_exec', true),
      tool('http_request', true),
      tool('workflow_trigger', true),
    ]
    const shell = await admit(
      mode,
      tools,
      { id: 'tc-shell', name: 'shell_exec', arguments: {} },
      { approvalConfig: scopedTools }
    )
    expect(shell.kind).toBe('suspend')
    const covered = await admit(
      mode,
      tools,
      { id: 'tc-shell-2', name: 'shell_exec', arguments: {} },
      { approvalConfig: scopedTools, task: ['shell_exec'] }
    )
    expect(covered.kind).toBe('execute')
    const http = await admit(
      mode,
      tools,
      { id: 'tc-http', name: 'http_request', arguments: {} },
      { approvalConfig: scopedTools, task: ['shell_exec'] }
    )
    expect(http.kind).toBe('suspend')
    const workflow = await admit(
      mode,
      tools,
      { id: 'tc-wf', name: 'workflow_trigger', arguments: { name: 'wf' } },
      { approvalConfig: scopedTools }
    )
    expect(workflow.kind).toBe('suspend')
    const always = await admit(
      mode,
      tools,
      { id: 'tc-wf-2', name: 'workflow_trigger', arguments: { name: 'wf' } },
      { approvalConfig: scopedTools, always: ['workflow_trigger'] }
    )
    expect(always.kind).toBe('execute')
  })

  it('a denied tool and an unapproved sibling suspend after another tool was approved', async () => {
    const tools = [tool(FINDER, false), tool(SEARCH, false), tool(CREATE, false)]
    const denied = await admit(
      mode,
      tools,
      { id: 'tc-finder', name: FINDER, arguments: { company: 'Kungfu.ai' } },
      { denials: [[FINDER, 'user-a']], always: [SEARCH] }
    )
    expect(denied.kind).toBe('suspend')
    if (denied.kind === 'suspend') {
      expect(denied.approval.tool_name).toBe(FINDER)
      expect(denied.approval.authorization_scope).toBe('exact_invocation')
      expect(denied.approval.reask).toBe('denied')
    }
    const sibling = await admit(
      mode,
      tools,
      { id: 'tc-create', name: CREATE, arguments: {} },
      { denials: [[FINDER, 'user-a']], always: [SEARCH] }
    )
    expect(sibling.kind).toBe('suspend')
    const approved = await admit(
      mode,
      tools,
      { id: 'tc-search', name: SEARCH, arguments: { q: 'Kungfu.ai' } },
      { denials: [[FINDER, 'user-a']], always: [SEARCH] }
    )
    expect(approved.kind).toBe('execute')
  })

  it('an approved-catalog MCP call suspends before execution', async () => {
    let executed = 0
    const selected = tool(SELECTED, false)
    selected.execute = async () => {
      executed += 1
      return { content: 'ran', is_error: false, duration_ms: 0 }
    }
    const admission = await admit(mode, [selected], {
      id: 'selected-call',
      name: SELECTED,
      arguments: {},
    })
    expect(admission.kind).toBe('suspend')
    if (admission.kind === 'suspend') expect(admission.approval.tool_name).toBe(SELECTED)
    expect(executed).toBe(0)
  })
})
