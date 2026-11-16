import { describe, expect, it } from 'vitest'
import {
  type DecisionFeedbackInput,
  type DecisionFeedbackPlan,
  planDecisionFeedback,
} from '../src/decisionFeedback.js'
import type { McpHostDecisionResult } from '../src/mcpHostClient.js'

const T_STALE = 'This workflow approval is no longer pending.'
const tBusy = (seconds: number) => `The assistant is busy. Try again in ${seconds} seconds.`
const tGen = (decision: 'approve' | 'deny') =>
  `I could not ${decision} this workflow approval. Try again in a moment.`
const tDeny = (medium: 'slack' | 'teams') =>
  `You are not allowed to decide this workflow approval from this ${medium === 'teams' ? 'Teams' : 'Slack'} conversation.`

const limited = (seconds: number): McpHostDecisionResult => ({
  ok: false,
  status: 429,
  error: 'runtime_service_admission_limited',
  retryAfterSeconds: seconds,
})

const STALE_RESULTS: McpHostDecisionResult[] = [
  { ok: false, status: 409, error: 'approval_not_pending' },
  { ok: false, status: 403, error: 'approval_not_pending' },
  { ok: false, status: 409, error: 'approval_route_not_found' },
]

const OTHER_FAILURES: McpHostDecisionResult[] = [
  { ok: false, status: 409, error: 'approval_requester_mismatch' },
  { ok: false, status: 409, error: 'approval_not_authorized' },
  { ok: false, status: 409, error: 'approval_expired' },
  { ok: false, status: 409, error: 'approval_binding_mismatch' },
  { ok: false, status: 504, error: 'mcp_host_unavailable' },
  { ok: false, status: 429, error: 'runtime_service_admission_limited' },
  { ok: false, status: 400, error: 'invalid_reader_decision_command' },
]

const DENIALS: McpHostDecisionResult[] = [
  { ok: false, status: 403, error: 'cross_bot_mismatch' },
  { ok: false, status: 403, error: 'approval_not_found' },
  { ok: false, status: 403, error: 'consulta_failed' },
  { ok: false, status: 409, error: 'not_authorized' },
]

type Row = {
  row: string
  input: Omit<DecisionFeedbackInput, 'medium'>
  expected: (medium: 'slack' | 'teams') => DecisionFeedbackPlan
}

const notice = (text: string): DecisionFeedbackPlan => ({
  shared: null,
  notice: { action: 'send_failure', text },
})

const rows: Row[] = [
  {
    row: 'recorded',
    input: { decision: 'approve', result: { ok: true } },
    expected: () => ({
      shared: { action: 'update_success', text: 'Approved. Workflow approval recorded.' },
      notice: null,
    }),
  },
  {
    row: 'recorded as a duplicate, deny',
    input: { decision: 'deny', result: { ok: true, duplicate: true } },
    expected: () => ({
      shared: { action: 'update_success', text: 'Denied. Workflow approval recorded.' },
      notice: null,
    }),
  },
  {
    row: 'refused by the Host admission limit',
    input: { decision: 'approve', result: limited(7) },
    expected: () => notice(tBusy(7)),
  },
  ...STALE_RESULTS.map(result => ({
    row: `no longer pending ${result.status} ${result.error}`,
    input: { decision: 'deny' as const, result },
    expected: (): DecisionFeedbackPlan => ({
      shared: { action: 'update_stale', text: T_STALE },
      notice: null,
    }),
  })),
  ...DENIALS.map(result => ({
    row: `denial ${result.status} ${result.error}`,
    input: { decision: 'approve' as const, result },
    expected: (medium: 'slack' | 'teams') => notice(tDeny(medium)),
  })),
  ...OTHER_FAILURES.map(result => ({
    row: `failure ${result.status} ${result.error}`,
    input: { decision: 'deny' as const, result },
    expected: () => notice(tGen('deny')),
  })),
]

describe('planDecisionFeedback', () => {
  for (const medium of ['slack', 'teams'] as const) {
    it.each(rows)(`${medium}: $row`, ({ input, expected }) => {
      expect(planDecisionFeedback({ ...input, medium })).toEqual(expected(medium))
    })
  }

  it('rewrites the approval message only for a recorded decision or a stale approval', () => {
    const notShared = [...OTHER_FAILURES, ...DENIALS, limited(9)]
    let notices = 0
    let shared = 0
    for (const medium of ['slack', 'teams'] as const) {
      for (const decision of ['approve', 'deny'] as const) {
        for (const result of notShared) {
          const plan = planDecisionFeedback({ medium, decision, result })
          expect(plan.shared).toBeNull()
          expect(plan.notice?.action).toBe('send_failure')
          notices += 1
        }
        // Witness: the same loop does write the approval message for the
        // results that may change it.
        for (const result of [{ ok: true }, ...STALE_RESULTS]) {
          const plan = planDecisionFeedback({ medium, decision, result })
          expect(plan.notice).toBeNull()
          expect(plan.shared?.action).toBe(result.ok ? 'update_success' : 'update_stale')
          shared += 1
        }
      }
    }
    expect(notices).toBe(2 * 2 * notShared.length)
    expect(shared).toBe(2 * 2 * (1 + STALE_RESULTS.length))
  })
})
