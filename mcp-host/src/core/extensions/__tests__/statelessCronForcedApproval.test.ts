import { describe, expect, it } from 'vitest'
import { CronScheduler } from '../../../agent/cronScheduler'
import { MessageQueue } from '../../../queue/messageQueue'
import { ConversationManager } from '../../conversation/conversation'
import type { ToolRegistry } from '../../interfaces'
import { CronManageTool } from '../../tools/cronManage'
import { ApprovalController } from '../approvalController'
import {
  STATELESS_CRON_APPROVAL_PROMPT,
  UnifiedApprovalGateController,
} from '../mcpApprovalGateController'

// The real gate, ApprovalController and approve() joined through one
// conversation. On a stateless host with cron management allowed, cron_manage
// create/enable is a forced approval; every other cron_manage action follows
// the per-task session rule.
function gateFor(options: { stateless: boolean; cronManageGateOnly?: boolean }) {
  const cronTool = new CronManageTool(
    new CronScheduler(new MessageQueue(), { allowEnabledJobs: true }),
    undefined,
    options.stateless,
    true
  )
  const registry: ToolRegistry = {
    get: name => (name === 'cron_manage' ? cronTool : null),
    register: () => {},
    listDefinitions: () => [],
  }
  return new UnifiedApprovalGateController(
    registry,
    { defaultPolicy: 'channel_users', channels: {}, tools: { shell_exec: true } },
    undefined,
    { statelessLifecycle: options.stateless, cronManageGateOnly: options.cronManageGateOnly }
  )
}

async function harness(
  sessionKey: string,
  options: { stateless: boolean; cronManageGateOnly?: boolean } = { stateless: true }
) {
  const manager = new ConversationManager()
  const conversation = await manager.getOrCreate(sessionKey)
  const gate = gateFor(options)
  const controller = new ApprovalController(conversation, gate, { forcedApprovalGate: gate })
  await manager.startTurn(conversation, 'First message', 'test-task')
  let callCount = 0

  /** One model-generated call: 'proceed', or 'suspend' after recording the card. */
  async function call(
    toolName: string,
    params: Record<string, unknown> = {}
  ): Promise<'proceed' | 'suspend'> {
    const decision = controller.beforeTool(toolName, params)
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
    await manager.approve(conversation, always)
    conversation.pending_approval = undefined
  }

  async function nextTurn() {
    await manager.completeTurn(conversation, 'Done')
    await manager.startTurn(conversation, 'Next message', 'test-task')
  }

  return { conversation, call, approve, nextTurn }
}

const list = { action: 'list' }
const create = { action: 'create', name: 'nightly', schedule: '0 0 * * *', task: 'report' }
const enable = { action: 'enable', jobId: 'job-1' }

describe('stateless cron_manage create/enable forced approval', () => {
  it('after a plain cron_manage list approval in the task, create still suspends with exact scope', async () => {
    const h = await harness('cron-user:rpc:cron-agent:plain-list')
    expect(await h.call('cron_manage', list)).toBe('suspend')
    expect(h.conversation.pending_approval?.authorization_scope).toBe('turn_tools')
    await h.approve()
    expect(h.conversation.task_approved_tools).toEqual(new Set(['cron_manage']))

    // Witness: the per-task approval covers a later list call.
    expect(await h.call('cron_manage', list)).toBe('proceed')
    expect(await h.call('cron_manage', create)).toBe('suspend')
    expect(h.conversation.pending_approval).toMatchObject({
      tool_name: 'cron_manage',
      authorization_scope: 'exact_invocation',
      description: STATELESS_CRON_APPROVAL_PROMPT,
    })
  })

  it('after an "always" cron_manage approval, enable still suspends in a later task', async () => {
    const h = await harness('cron-user:rpc:cron-agent:always')
    expect(await h.call('cron_manage', list)).toBe('suspend')
    await h.approve(true)
    await h.nextTurn()
    expect(h.conversation.auto_approved_tools).toEqual(new Set(['cron_manage']))

    // Witness: the "always" approval covers list in the new task.
    expect(await h.call('cron_manage', list)).toBe('proceed')
    expect(await h.call('cron_manage', enable)).toBe('suspend')
    expect(h.conversation.pending_approval).toMatchObject({
      tool_name: 'cron_manage',
      authorization_scope: 'exact_invocation',
    })
  })

  it('after an MCP approval, create still suspends with exact scope', async () => {
    const h = await harness('cron-user:rpc:cron-agent:wildcard')
    expect(await h.call('mongodb-server__find')).toBe('suspend')
    await h.approve()
    // The MCP approval ran that call only: no wildcard, no server prefix.
    expect(h.conversation.auto_approved_tools).toEqual(new Set())

    expect(await h.call('cron_manage', create)).toBe('suspend')
    expect(h.conversation.pending_approval?.authorization_scope).toBe('exact_invocation')
  })

  it('approving a forced create card stores no approval, so the next create asks again', async () => {
    const h = await harness('cron-user:rpc:cron-agent:exact-card')
    expect(await h.call('cron_manage', create)).toBe('suspend')
    const firstCard = h.conversation.pending_approval
    expect(firstCard?.authorization_scope).toBe('exact_invocation')
    await h.approve(true)

    expect(h.conversation.task_approved_tools).toBeUndefined()
    expect(h.conversation.auto_approved_tools).toEqual(new Set())
    expect(await h.call('cron_manage', create)).toBe('suspend')
    // Witness: a new card replaced the approved one.
    expect(h.conversation.pending_approval?.request_id).not.toBe(firstCard?.request_id)
    expect(h.conversation.pending_approval?.authorization_scope).toBe('exact_invocation')
    // The exact approval did not cover list either.
    await h.approve()
    expect(await h.call('cron_manage', list)).toBe('suspend')
  })

  it('on a non-stateless host a plain cron_manage approval covers create for the rest of the task', async () => {
    const h = await harness('cron-user:rpc:cron-agent:stateful', { stateless: false })
    expect(await h.call('cron_manage', create)).toBe('suspend')
    expect(h.conversation.pending_approval).toMatchObject({
      authorization_scope: 'turn_tools',
      description: 'Tool "cron_manage" requires approval before execution',
    })
    await h.approve()

    expect(await h.call('cron_manage', create)).toBe('proceed')
    expect(await h.call('cron_manage', enable)).toBe('proceed')
    await h.nextTurn()
    expect(await h.call('cron_manage', create)).toBe('suspend')
  })

  it('keeps the cron-sourced gate-only path: create suspends and every other call proceeds', async () => {
    const h = await harness('cron-user:rpc:cron-agent:gate-only', {
      stateless: true,
      cronManageGateOnly: true,
    })
    expect(await h.call('cron_manage', list)).toBe('proceed')
    expect(await h.call('shell_exec', { command: 'true' })).toBe('proceed')
    expect(await h.call('cron_manage', create)).toBe('suspend')
    expect(h.conversation.pending_approval).toMatchObject({
      tool_name: 'cron_manage',
      authorization_scope: 'exact_invocation',
      description: STATELESS_CRON_APPROVAL_PROMPT,
    })
  })
})
