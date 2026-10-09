import { describe, expect, it } from 'vitest'
import { ConversationManager } from '../../conversation/conversation'
import type { ToolRegistry } from '../../interfaces'
import { ApprovalController } from '../approvalController'
import { UnifiedApprovalGateController } from '../mcpApprovalGateController'

// The real approval decision and the real approve() grants, joined through one
// conversation. The empty registry plus the per-tool overrides make every native
// tool here approval-gated; MCP tools are gated by their name.
const registry: ToolRegistry = { get: () => null, register: () => {}, listDefinitions: () => [] }
const gate = new UnifiedApprovalGateController(registry, {
  defaultPolicy: 'channel_users',
  channels: {},
  tools: { shell_exec: true, http_request: true, cron_manage: true, workflow_trigger: true },
})

async function harness(sessionKey: string) {
  const manager = new ConversationManager()
  const conversation = await manager.getOrCreate(sessionKey)
  const controller = new ApprovalController(conversation, gate)
  await manager.startTurn(conversation, 'First message', 'test-task')
  let callCount = 0

  /** One model-generated call: 'proceed', or 'suspend' after recording the card. */
  async function call(toolName: string): Promise<'proceed' | 'suspend'> {
    const decision = controller.beforeTool(toolName, {})
    if (decision === 'skip') throw new Error(`Unexpected skip for ${toolName}`)
    if (decision === 'proceed') return 'proceed'
    callCount += 1
    await manager.suspendForApproval(conversation, {
      ...decision.approval,
      tool_call_id: `tc-${callCount}`,
    })
    return 'suspend'
  }

  /** Approve the open card and consume it, as TaskExecutor.resumeAfterApproval does. */
  async function approve(always = false) {
    expect(conversation.pending_approval?.authorization_scope).toBe('turn_tools')
    await manager.approve(conversation, always)
    conversation.pending_approval = undefined
  }

  async function nextTurn() {
    await manager.completeTurn(conversation, 'Done')
    await manager.startTurn(conversation, 'Next message', 'test-task')
  }

  return { conversation, call, approve, nextTurn }
}

describe('per-call approvals next to session-scoped approvals', () => {
  it('an MCP approval runs that call only: no wildcard, no server prefix', async () => {
    const h = await harness('scope-user:rpc:scope-agent:mcp-per-call')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
    await h.approve()
    expect(h.conversation.auto_approved_tools).toEqual(new Set())

    // Witness: every later call asks, on the same server or another one.
    expect(await h.call('mongodb-server__insert_many')).toBe('suspend')
    await h.approve()
    expect(await h.call('airtable-server__list_tables')).toBe('suspend')
  })

  it('a plain shell_exec approval covers shell_exec for the task only', async () => {
    const h = await harness('scope-user:rpc:scope-agent:shell-task')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
    await h.approve()
    expect(await h.call('shell_exec')).toBe('suspend')
    await h.approve()

    expect(await h.call('shell_exec')).toBe('proceed')
    expect(await h.call('http_request')).toBe('suspend')
    await h.approve()
    expect(await h.call('airtable-server__list_tables')).toBe('suspend')
    await h.approve()

    await h.nextTurn()
    expect(await h.call('shell_exec')).toBe('suspend')
  })

  it('a plain workflow_trigger approval grants nothing, so the next call asks again', async () => {
    const h = await harness('scope-user:rpc:scope-agent:workflow')
    expect(await h.call('workflow_trigger')).toBe('suspend')
    await h.approve()
    expect(h.conversation.auto_approved_tools).toEqual(new Set())
    expect(h.conversation.task_approved_tools?.size ?? 0).toBe(0)

    expect(await h.call('workflow_trigger')).toBe('suspend')
    await h.approve()
    expect(await h.call('mongodb-server__find')).toBe('suspend')
  })

  it('Always approve stores only the exact tool name, across turns', async () => {
    const h = await harness('scope-user:rpc:scope-agent:workflow-always')
    expect(await h.call('workflow_trigger')).toBe('suspend')
    await h.approve(true)
    expect(h.conversation.auto_approved_tools).toEqual(new Set(['workflow_trigger']))

    await h.nextTurn()

    expect(h.conversation.auto_approved_tools).toEqual(new Set(['workflow_trigger']))
    expect(await h.call('workflow_trigger')).toBe('proceed')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
  })
})
