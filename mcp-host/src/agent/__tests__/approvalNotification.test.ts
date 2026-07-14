/**
 * Approval-notification text: the CLI-fallback branch must name the HTTP route
 * that actually exists. mcp-host serves approvals at
 * `POST /v1/runtime/approvals/approve` (server.ts:233) — the bare `POST /approve`
 * the notification used to print is a 404 (onboarding dry-run finding F16).
 */
import { describe, expect, it } from 'vitest'
import type { PendingApproval } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import { AgentStateMachine } from '../stateMachine'

function makeAgent(): AgentStateMachine {
  const queue = new MessageQueue()
  const lifecycle = new TaskLifecycle()
  return new AgentStateMachine(queue, lifecycle, { autoStart: false, taskDelay: 0 })
}

const approval: PendingApproval = {
  request_id: 'approval-123',
  tool_name: 'mock__add',
  parameters: { a: 1, b: 2 },
  description: 'add two numbers',
  tool_call_id: 'call-1',
  context_snapshot: [],
}

describe('buildApprovalNotification — CLI fallback route', () => {
  it('names the real served approve route, not a 404', () => {
    const agent = makeAgent()
    // buildApprovalNotification is private; it is a pure string builder.
    const build = (
      agent as unknown as {
        buildApprovalNotification: (a: PendingApproval, u: string, c?: string) => string
      }
    ).buildApprovalNotification.bind(agent)

    // No approvalConfig + non-workflow tool + no channel => CLI-fallback branch.
    const msg = build(approval, 'user-1', undefined)

    expect(msg).toContain('Please approve via CLI: POST /v1/runtime/approvals/approve')
    // Guard against regressing to the bare 404 route.
    expect(msg).not.toMatch(/POST \/approve(?![s/])/)
  })
})
