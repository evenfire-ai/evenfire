/**
 * Cron×stateless — the approval notification shown to the END USER when the
 * stateless-cron gate suspends a cron_manage create/enable call. The message
 * must lead with the exact consequence prompt, not the generic
 * "Tool `x` requires approval." line — the user is deciding on cost, not on a
 * tool name.
 */
import { describe, expect, it } from 'vitest'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import { STATELESS_CRON_APPROVAL_PROMPT } from '../../core/extensions/mcpApprovalGateController'
import type { PendingApproval } from '../../core/types'
import { AgentStateMachine } from '../stateMachine'

type NotificationBuilder = {
  buildApprovalNotification(approval: PendingApproval, userId: string, channelType?: string): string
}

/**
 * buildApprovalNotification is a pure function of
 * (approval, this.approvalConfig, channelType) — invoke the prototype method
 * against a minimal receiver so no queue/lifecycle wiring is needed.
 */
function buildNotification(
  approval: PendingApproval,
  approvalConfig: ApprovalConfig | undefined,
  channelType?: string
): string {
  const proto = AgentStateMachine.prototype as unknown as NotificationBuilder
  return proto.buildApprovalNotification.call({ approvalConfig }, approval, 'user-1', channelType)
}

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: 'approval-test-1',
    tool_name: 'cron_manage',
    parameters: { action: 'create', name: 'daily', schedule: '0 0 * * *', task: 'do it' },
    description: STATELESS_CRON_APPROVAL_PROMPT,
    tool_call_id: 'call-1',
    context_snapshot: [],
    ...overrides,
  }
}

const channelConfig: ApprovalConfig = { defaultPolicy: 'channel_users', channels: {} }
const cliConfig: ApprovalConfig = { defaultPolicy: 'cli_only', channels: {} }

describe('buildApprovalNotification — cron×stateless prompt (cron×stateless)', () => {
  it('leads with the exact stateless prompt and telegram approve/deny instructions', () => {
    const msg = buildNotification(makeApproval(), channelConfig, 'telegram')
    expect(msg.startsWith(STATELESS_CRON_APPROVAL_PROMPT)).toBe(true)
    expect(msg).toContain('Reply /approve or /deny to this message.')
    expect(msg).not.toContain('requires approval')
  })

  it('uses the slack control instructions on slack', () => {
    const msg = buildNotification(makeApproval(), channelConfig, 'slack')
    expect(msg.startsWith(STATELESS_CRON_APPROVAL_PROMPT)).toBe(true)
    expect(msg).toContain('Use the approval controls to continue or cancel.')
  })

  it('falls back to the CLI instructions when the channel cannot approve', () => {
    const msg = buildNotification(makeApproval(), cliConfig, 'telegram')
    expect(msg.startsWith(STATELESS_CRON_APPROVAL_PROMPT)).toBe(true)
    expect(msg).toContain('Request ID: approval-test-1')
    expect(msg).toContain('Please approve via CLI: POST /v1/runtime/approvals/approve')
    // F16 guard: the server serves ONLY the full route; a bare `POST /approve` is a 404 instruction.
    expect(msg).not.toMatch(/POST \/approve(?![\w/])/)
  })

  it('keeps the generic lead for every other approval (regression guard)', () => {
    const msg = buildNotification(
      makeApproval({ description: 'Tool "cron_manage" requires approval before execution' }),
      channelConfig,
      'telegram'
    )
    expect(msg).toContain('Tool `cron_manage` requires approval.')
    expect(msg.startsWith(STATELESS_CRON_APPROVAL_PROMPT)).toBe(false)
  })
})

describe('buildApprovalNotification — re-ask cards', () => {
  it('keeps the stateless cost warning on a re-ask and says why it asks again', () => {
    const msg = buildNotification(makeApproval({ reask: 'denials_active' }), channelConfig, 'slack')

    expect(msg).toContain(STATELESS_CRON_APPROVAL_PROMPT)
    expect(msg).toContain('another tool was denied in this chat')
  })

  it('says that this tool was denied earlier', () => {
    const msg = buildNotification(
      makeApproval({
        tool_name: 'shell_exec',
        description: 'Tool shell_exec requires approval',
        parameters: { command: 'ls' },
        reask: 'denied',
      }),
      channelConfig,
      'telegram'
    )

    expect(msg).toContain('You denied this tool earlier in this chat.')
    expect(msg).toContain('Tool `shell_exec` requires approval.')
  })
})
