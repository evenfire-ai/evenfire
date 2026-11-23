import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../../logger'
import type { ApprovalMode } from '../../approval/approvalMode'
import { ConversationState, type PendingApproval } from '../../types'
import { ConversationManager } from '../conversation'

function approval(
  scope?: PendingApproval['authorization_scope'],
  toolName = 'shell_exec'
): PendingApproval {
  return {
    request_id: 'approval-scope-test',
    authorization_scope: scope,
    tool_name: toolName,
    parameters: { command: 'printf exact-call' },
    description: 'Unit approval scope',
    tool_call_id: 'tool-scope-test',
    context_snapshot: [],
  }
}

async function approvedScope(
  scope?: PendingApproval['authorization_scope'],
  always = false,
  toolName = 'shell_exec'
) {
  const manager = new ConversationManager()
  const conversation = await manager.getOrCreate('scope-user:rpc:scope-agent:chat')
  conversation.state = ConversationState.Processing
  await manager.suspendForApproval(conversation, approval(scope, toolName))
  await manager.approve(conversation, always)
  return conversation.auto_approved_tools
}

describe('approval authorization scope', () => {
  it('keeps an exact invocation from creating turn-wide or persistent grants', async () => {
    await expect(approvedScope('exact_invocation', true)).resolves.toEqual(new Set())
  })

  it('lets an ordinary card store only its exact tool name, never a wildcard', async () => {
    await expect(approvedScope('turn_tools', true, 'workflow_trigger')).resolves.toEqual(
      new Set(['workflow_trigger'])
    )
  })

  it('scopes turn-wide consent for shell_exec to the tool itself, without a wildcard', async () => {
    await expect(approvedScope('turn_tools', true)).resolves.toEqual(new Set(['shell_exec']))
  })

  it('treats a legacy unknown scope as exact rather than granting a wildcard', async () => {
    await expect(approvedScope(undefined, true)).resolves.toEqual(new Set())
  })

  it.each(['exact_invocation', undefined] as const)(
    'adds nothing for scope %s and keeps the grants already stored',
    async scope => {
      const manager = new ConversationManager()
      const conversation = await manager.getOrCreate('scope-user:rpc:scope-agent:legacy')
      conversation.state = ConversationState.Processing
      conversation.auto_approved_tools = new Set(['http_request', 'trusted-server'])
      await manager.suspendForApproval(conversation, approval(scope))
      await manager.approve(conversation, true)

      expect(conversation.auto_approved_tools).toEqual(new Set(['http_request', 'trusted-server']))
      expect(conversation.task_approved_tools?.size ?? 0).toBe(0)
    }
  )
})

describe('an Always answer after the effective mode left manual', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function answerAt(effectiveMode: ApprovalMode, toolName: string, alwaysApprove: boolean) {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const manager = new ConversationManager()
    const resolved = vi.spyOn(manager.getStore(), 'persistApprovalResolved')
    const conversation = await manager.getOrCreate(`scope-user:telegram:chat:${toolName}`)
    conversation.state = ConversationState.Processing
    await manager.suspendForApproval(conversation, approval('turn_tools', toolName))
    await manager.approve(conversation, alwaysApprove, 'scope-user', {
      effectiveMode,
      surface: 'channel',
    })
    const ignored = info.mock.calls
      .map(call => call[0] as Record<string, unknown>)
      .filter(fields => fields.event === 'always_approve_ignored')
    return { conversation, resolved, ignored }
  }

  it.each([
    ['auto', 'shell_exec'],
    ['allow_all', 'shell_exec'],
    ['auto', 'mcp__srv__tool'],
    ['allow_all', 'http_request'],
  ] as const)(
    'runs the call once at %s, stores no %s grant and logs why',
    async (mode, toolName) => {
      const { conversation, resolved, ignored } = await answerAt(mode, toolName, true)

      expect(conversation.state).toBe(ConversationState.Processing)
      expect(resolved).toHaveBeenCalledWith(conversation, 'approval-scope-test', 'approve')
      expect(conversation.auto_approved_tools).toEqual(new Set())
      expect(conversation.task_approved_tools?.size ?? 0).toBe(0)
      expect(ignored).toEqual([
        {
          event: 'always_approve_ignored',
          toolName,
          reason: 'mode_not_manual',
          effectiveMode: mode,
        },
      ])
    }
  )

  it('still stores the name in manual without that log', async () => {
    const { conversation, resolved, ignored } = await answerAt('manual', 'shell_exec', true)

    expect(resolved).toHaveBeenCalledTimes(1)
    expect(conversation.auto_approved_tools).toEqual(new Set(['shell_exec']))
    expect(ignored).toEqual([])
  })

  it('still stores cron_manage in auto without that log', async () => {
    const { conversation, resolved, ignored } = await answerAt('auto', 'cron_manage', true)

    expect(resolved).toHaveBeenCalledTimes(1)
    expect(conversation.auto_approved_tools).toEqual(new Set(['cron_manage']))
    expect(ignored).toEqual([])
  })

  it('does not log a plain approve, which asked for no grant', async () => {
    const { conversation, resolved, ignored } = await answerAt('auto', 'http_request', false)

    expect(resolved).toHaveBeenCalledTimes(1)
    expect(conversation.state).toBe(ConversationState.Processing)
    expect(conversation.task_approved_tools?.size ?? 0).toBe(0)
    expect(ignored).toEqual([])
  })
})
