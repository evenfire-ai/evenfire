import { describe, expect, it } from 'vitest'
import { ConversationManager } from '../../conversation/conversation'
import type { ToolRegistry } from '../../interfaces'
import { ApprovalController } from '../approvalController'
import { UnifiedApprovalGateController } from '../mcpApprovalGateController'

// The real approval decision and the real approve() expansion, joined through one
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

describe('session-scoped approvals next to turn-wide MCP approvals', () => {
  it("an MCP turn-wide approval adds '*' that does not cover shell_exec", async () => {
    const h = await harness('scope-user:rpc:scope-agent:mcp-wildcard')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
    await h.approve()
    expect(h.conversation.auto_approved_tools).toEqual(new Set(['*', 'mongodb-server']))

    // Witness: '*' covers another MCP server's tool in the same turn.
    expect(await h.call('airtable-server__list_tables')).toBe('proceed')
    expect(await h.call('shell_exec')).toBe('suspend')
    expect(h.conversation.pending_approval?.tool_name).toBe('shell_exec')
  })

  it("keeps MCP behaviour: '*' covers other MCP tools in the turn and the server prefix persists", async () => {
    const h = await harness('scope-user:rpc:scope-agent:mcp-prefix')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
    await h.approve()
    expect(await h.call('airtable-server__list_tables')).toBe('proceed')
    expect(await h.call('mongodb-server__insert_many')).toBe('proceed')

    await h.nextTurn()

    expect(h.conversation.auto_approved_tools).toEqual(new Set(['mongodb-server']))
    // Witness: the persisted prefix still covers its server in the next turn.
    expect(await h.call('mongodb-server__aggregate')).toBe('proceed')
    expect(await h.call('airtable-server__list_tables')).toBe('suspend')
  })

  it("shell_exec approval after an MCP '*' covers shell_exec without revoking '*'", async () => {
    const h = await harness('scope-user:rpc:scope-agent:mcp-then-shell')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
    await h.approve()
    expect(await h.call('shell_exec')).toBe('suspend')
    await h.approve()

    expect(await h.call('shell_exec')).toBe('proceed')
    expect(await h.call('airtable-server__list_tables')).toBe('proceed')
    expect(await h.call('http_request')).toBe('suspend')
  })

  it("keeps workflow_trigger turn-wide: '*' covers other gated tools this turn, and a new turn asks again", async () => {
    const h = await harness('scope-user:rpc:scope-agent:workflow')
    expect(await h.call('workflow_trigger')).toBe('suspend')
    await h.approve()
    expect(h.conversation.auto_approved_tools).toEqual(new Set(['*']))

    // Witness: '*' from workflow_trigger covers the next workflow_trigger and an MCP tool.
    expect(await h.call('workflow_trigger')).toBe('proceed')
    expect(await h.call('mongodb-server__find')).toBe('proceed')

    await h.nextTurn()
    expect(await h.call('workflow_trigger')).toBe('suspend')
  })

  it('keeps workflow_trigger "always" approval across turns through its tool name', async () => {
    const h = await harness('scope-user:rpc:scope-agent:workflow-always')
    expect(await h.call('workflow_trigger')).toBe('suspend')
    await h.approve(true)
    expect(h.conversation.auto_approved_tools).toEqual(new Set(['*', 'workflow_trigger']))

    await h.nextTurn()

    expect(h.conversation.auto_approved_tools).toEqual(new Set(['workflow_trigger']))
    expect(await h.call('workflow_trigger')).toBe('proceed')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
  })
})
