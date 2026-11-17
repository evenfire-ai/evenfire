import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { logger } from '../../../logger'
import { ConversationManager } from '../../conversation/conversation'
import { recordDenial } from '../../conversation/denialPolicy'
import { type Conversation, ConversationState } from '../../types'
import { approvalLogId, syncEffectiveMode } from '../grantMemory'

const SENDER = 'sender-sentinel@example.test'
const THREAD = 'thread-sentinel@example.test'
const LIVE_OPEN = { ceiling: 'allow_all' as const, cap: 'allow_all' as const }

function seedGrants(conversation: Conversation): void {
  conversation.task_approved_tools = new Set(['http_request', 'cron_manage', 'shell_exec'])
  conversation.auto_approved_tools = new Set(['srv__tool', 'shell_exec'])
  conversation.auto_shell_grants = { wholeTool: true, commands: new Set(['ls']) }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('grant memory', () => {
  it('clears mode-scoped grants when the effective mode changes', async () => {
    const manager = new ConversationManager()
    const conv = await manager.getOrCreate('grant-change')
    seedGrants(conv)
    conv.last_effective_approval_mode = 'auto'

    await manager.setApprovalMode(conv, 'manual', LIVE_OPEN, 'route')

    expect(conv.task_approved_tools).toEqual(new Set(['cron_manage']))
    expect(conv.auto_approved_tools).toEqual(new Set(['srv__tool']))
    expect(conv.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    expect(conv.last_effective_approval_mode).toBe('manual')
    expect(conv.approval_mode).toBe('manual')
  })

  it('does not clear re-seeded grants when the effective mode is unchanged', async () => {
    const manager = new ConversationManager()
    const conv = await manager.getOrCreate('grant-idempotent')
    seedGrants(conv)
    conv.last_effective_approval_mode = 'auto'
    await manager.setApprovalMode(conv, 'manual', LIVE_OPEN, 'route')

    seedGrants(conv)
    const task = conv.task_approved_tools
    const auto = conv.auto_approved_tools
    const grants = conv.auto_shell_grants

    await manager.setApprovalMode(conv, 'manual', LIVE_OPEN, 'route')

    expect(conv.task_approved_tools).toBe(task)
    expect(task).toEqual(new Set(['http_request', 'cron_manage', 'shell_exec']))
    expect(conv.auto_approved_tools).toBe(auto)
    expect(auto).toEqual(new Set(['srv__tool', 'shell_exec']))
    expect(conv.auto_shell_grants).toBe(grants)
    expect(grants).toEqual({ wholeTool: true, commands: new Set(['ls']) })
    expect(conv.last_effective_approval_mode).toBe('manual')
  })

  it('sets an unset effective mode without clearing grants', async () => {
    const manager = new ConversationManager()
    const conv = await manager.getOrCreate('grant-unset')
    expect(conv.last_effective_approval_mode).toBeUndefined()
    seedGrants(conv)
    const task = conv.task_approved_tools
    const auto = conv.auto_approved_tools
    const grants = conv.auto_shell_grants

    const synced = syncEffectiveMode(conv, 'auto')

    expect(synced).toEqual({ changed: false })
    expect(conv.last_effective_approval_mode).toBe('auto')
    expect(conv.task_approved_tools).toBe(task)
    expect(conv.auto_approved_tools).toBe(auto)
    expect(conv.auto_shell_grants).toBe(grants)
    expect(grants.wholeTool).toBe(true)
    expect(grants.commands).toEqual(new Set(['ls']))

    conv.last_effective_approval_mode = undefined
    await manager.setApprovalMode(conv, 'manual', LIVE_OPEN, 'route')

    expect(conv.task_approved_tools).toBe(task)
    expect(task?.has('shell_exec')).toBe(true)
    expect(task?.has('cron_manage')).toBe(true)
    expect(conv.auto_approved_tools).toBe(auto)
    expect(auto.has('shell_exec')).toBe(true)
    expect(auto.has('srv__tool')).toBe(true)
    expect(conv.auto_shell_grants).toBe(grants)
    expect(grants.wholeTool).toBe(true)
    expect(conv.last_effective_approval_mode).toBe('manual')
  })

  it('resets auto shell grants on a shell denial and keeps them on a timeout', async () => {
    const manager = new ConversationManager()
    const denied = await manager.getOrCreate('grant-deny')
    denied.auto_shell_grants = { wholeTool: true, commands: new Set(['ls']) }
    denied.auto_approved_tools.add('shell_exec')

    recordDenial(denied, 'file_read', 'user-a')
    expect(denied.auto_shell_grants).toEqual({ wholeTool: true, commands: new Set(['ls']) })

    recordDenial(denied, 'shell_exec', 'user-a')
    expect(denied.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    expect(denied.auto_approved_tools.has('shell_exec')).toBe(false)

    const timedOut = await manager.getOrCreate('grant-timeout')
    timedOut.auto_shell_grants = { wholeTool: true, commands: new Set(['ls']) }
    const grants = timedOut.auto_shell_grants
    timedOut.state = ConversationState.AwaitingApproval
    timedOut.pending_approval = {
      request_id: 'req-timeout',
      tool_name: 'shell_exec',
      parameters: { command: 'ls' },
      description: 'Run ls',
      tool_call_id: 'tc-timeout',
      context_snapshot: [],
    }

    await manager.deny(timedOut, { record: false })

    expect(timedOut.auto_shell_grants).toBe(grants)
    expect(grants).toEqual({ wholeTool: true, commands: new Set(['ls']) })
    expect(timedOut.denials?.has('shell_exec')).toBeFalsy()
  })

  it('persists manual for a capped command and the requested mode for the route', async () => {
    const manager = new ConversationManager()
    const conv = await manager.getOrCreate('grant-command-cap')
    const persist = vi.spyOn(manager.getStore(), 'persistApprovalMode')
    const live = { ceiling: 'allow_all' as const, cap: 'manual' as const }

    const command = await manager.setApprovalMode(conv, 'allow_all', live, 'command')

    expect(persist).toHaveBeenLastCalledWith(conv, 'manual')
    expect(conv.approval_mode).toBe('manual')
    expect(conv.last_effective_approval_mode).toBe('manual')
    expect(command).toEqual({
      approvalMode: 'manual',
      modeCeiling: 'allow_all',
      channelCap: 'manual',
      effectiveApprovalMode: 'manual',
    })

    const route = await manager.setApprovalMode(conv, 'allow_all', live, 'route')

    expect(persist).toHaveBeenLastCalledWith(conv, 'allow_all')
    expect(conv.approval_mode).toBe('allow_all')
    expect(conv.last_effective_approval_mode).toBe('manual')
    expect(route).toEqual({
      approvalMode: 'allow_all',
      modeCeiling: 'allow_all',
      channelCap: 'manual',
      effectiveApprovalMode: 'manual',
    })

    await manager.setApprovalMode(conv, 'allow_all', { ceiling: 'manual', cap: 'manual' }, 'route')
    expect(conv.approval_mode).toBe('allow_all')

    await manager.setApprovalMode(conv, 'auto', { ceiling: 'manual', cap: 'allow_all' }, 'command')
    expect(conv.approval_mode).toBe('auto')

    await manager.setApprovalMode(conv, 'manual', LIVE_OPEN, 'command')
    expect(conv.approval_mode).toBe('manual')
  })

  it('logs one L1 line with hashed session and user ids', async () => {
    const manager = new ConversationManager()
    const conv = await manager.getOrCreate(`${SENDER}:email:INBOX:${THREAD}`, { userId: SENDER })
    expect(conv.id).toContain(SENDER)
    expect(conv.id).toContain(THREAD)
    expect(conv.user_id).toBe(SENDER)

    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined)
    try {
      await manager.setApprovalMode(conv, 'allow_all', { ceiling: 'auto', cap: 'manual' }, 'route')

      const l1 = info.mock.calls.filter(call => (call[0] as { event?: string }).event === 'L1')
      expect(l1).toHaveLength(1)
      const [fields, message] = l1[0]
      expect(fields).toMatchObject({
        event: 'L1',
        session: sha256(conv.id),
        user: sha256(conv.user_id ?? ''),
        requested: 'allow_all',
        ceiling: 'auto',
        channelCap: 'manual',
        effectiveApprovalMode: 'manual',
        writer: 'route',
      })
      expect(fields.session).toMatch(/^[0-9a-f]{64}$/)
      expect(fields.user).toMatch(/^[0-9a-f]{64}$/)
      expect(fields.session).not.toBe(fields.user)
      expect(approvalLogId(conv.id)).toBe(fields.session)
      expect(approvalLogId(conv.user_id ?? '')).toBe(fields.user)
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(debug).not.toHaveBeenCalled()

      const line = JSON.stringify([fields, message])
      expect(line).toContain('allow_all')
      expect(line).toContain('auto')
      expect(line).toContain('manual')
      expect(line).toContain('route')
      expect(line).not.toContain(SENDER)
      expect(line).not.toContain(THREAD)
      for (const call of [
        ...info.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
        ...debug.mock.calls,
      ]) {
        const emitted = JSON.stringify(call)
        expect(emitted).not.toContain(SENDER)
        expect(emitted).not.toContain(THREAD)
      }
    } finally {
      info.mockRestore()
      warn.mockRestore()
      error.mockRestore()
      debug.mockRestore()
    }
  })

  it('reports a mode change from syncEffectiveMode only when the value differs', async () => {
    const manager = new ConversationManager()
    const conv = await manager.getOrCreate('grant-sync-return')
    seedGrants(conv)

    expect(syncEffectiveMode(conv, 'auto')).toEqual({ changed: false })
    expect(syncEffectiveMode(conv, 'auto')).toEqual({ changed: false, previous: 'auto' })
    expect(conv.task_approved_tools?.has('shell_exec')).toBe(true)

    expect(syncEffectiveMode(conv, 'manual')).toEqual({ changed: true, previous: 'auto' })
    expect(conv.last_effective_approval_mode).toBe('manual')
    expect(conv.task_approved_tools).toEqual(new Set(['cron_manage']))
    expect(conv.auto_approved_tools.has('srv__tool')).toBe(true)
    expect(conv.auto_approved_tools.has('shell_exec')).toBe(false)
    expect(conv.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
  })
})
