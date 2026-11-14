import { describe, expect, it } from 'vitest'
import {
  type DecisionFeedbackInput,
  type DecisionFeedbackPlan,
  planDecisionFeedback,
} from '../src/decisionFeedback.js'
import type { McpHostDecisionResult } from '../src/mcpHostClient.js'

const T_STALE = 'This workflow approval is no longer pending.'
const T_RETRY_STALE =
  'Your earlier decision was not recorded: this workflow approval is no longer pending.'
const tSched = (seconds: number) =>
  `The assistant is busy. Your decision will be sent again in ${seconds} seconds. If the approval message has not changed a minute from now, choose again.`
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

const notice = (
  action: 'send_retry_scheduled' | 'send_failure' | 'send_retry_stale',
  text: string
): DecisionFeedbackPlan => ({ shared: null, notice: { action, text } })

const rows: Row[] = [
  {
    row: '5 first attempt ok',
    input: { decision: 'approve', attempt: 'first', result: { ok: true }, armed: null },
    expected: () => ({
      shared: { action: 'update_success', text: 'Approved. Workflow approval recorded.' },
      notice: null,
    }),
  },
  {
    row: '5 first attempt duplicate, deny',
    input: {
      decision: 'deny',
      attempt: 'first',
      result: { ok: true, duplicate: true },
      armed: null,
    },
    expected: () => ({
      shared: { action: 'update_success', text: 'Denied. Workflow approval recorded.' },
      notice: null,
    }),
  },
  {
    row: '9 retry ok',
    input: { decision: 'approve', attempt: 'retry', result: { ok: true }, armed: null },
    expected: () => ({
      shared: { action: 'update_success', text: 'Approved. Workflow approval recorded.' },
      notice: null,
    }),
  },
  {
    row: '3b other user refused by control-api',
    input: {
      decision: 'deny',
      attempt: 'first',
      result: { ok: false, status: 409, error: 'approval_requester_mismatch' },
      armed: null,
    },
    expected: () => notice('send_failure', tGen('deny')),
  },
  {
    row: '3c / 12 first attempt 429, retry not scheduled',
    input: { decision: 'approve', attempt: 'first', result: limited(7), armed: 'not_scheduled' },
    expected: () => notice('send_failure', tBusy(7)),
  },
  {
    row: '1b first attempt 429 while the same user retry is armed',
    input: { decision: 'deny', attempt: 'first', result: limited(7), armed: 'held' },
    expected: () => ({ shared: null, notice: null }),
  },
  {
    row: '7 first attempt 429, retry scheduled',
    input: { decision: 'approve', attempt: 'first', result: limited(7), armed: 'scheduled' },
    expected: () => notice('send_retry_scheduled', tSched(7)),
  },
  {
    row: '8 retry 429 again',
    input: { decision: 'approve', attempt: 'retry', result: limited(9), armed: null },
    expected: () => notice('send_failure', tBusy(9)),
  },
  ...STALE_RESULTS.map(result => ({
    row: `6 retry stale ${result.status} ${result.error}`,
    input: { decision: 'approve' as const, attempt: 'retry' as const, result, armed: null },
    expected: () => notice('send_retry_stale', T_RETRY_STALE),
  })),
  ...STALE_RESULTS.map(result => ({
    row: `13a / 3d first attempt stale ${result.status} ${result.error}`,
    input: { decision: 'deny' as const, attempt: 'first' as const, result, armed: null },
    expected: (): DecisionFeedbackPlan => ({
      shared: { action: 'update_stale', text: T_STALE },
      notice: null,
    }),
  })),
  ...DENIALS.flatMap(result =>
    (['first', 'retry'] as const).map(attempt => ({
      row: `${attempt === 'first' ? '13b' : '10'} ${attempt} denial ${result.status} ${result.error}`,
      input: { decision: 'approve' as const, attempt, result, armed: null },
      expected: (medium: 'slack' | 'teams') => notice('send_failure', tDeny(medium)),
    }))
  ),
  ...OTHER_FAILURES.flatMap(result =>
    (['first', 'retry'] as const).map(attempt => ({
      row: `${attempt === 'first' ? '13c' : '11'} ${attempt} failure ${result.status} ${result.error}`,
      input: { decision: 'deny' as const, attempt, result, armed: null },
      expected: () => notice('send_failure', tGen('deny')),
    }))
  ),
]

describe('planDecisionFeedback', () => {
  for (const medium of ['slack', 'teams'] as const) {
    it.each(rows)(`${medium}: row $row`, ({ input, expected }) => {
      expect(planDecisionFeedback({ ...input, medium })).toEqual(expected(medium))
    })
  }

  it('refuses a scheduled retry without the Host wait', () => {
    expect(() =>
      planDecisionFeedback({
        medium: 'slack',
        decision: 'approve',
        attempt: 'first',
        result: { ok: false, status: 504, error: 'mcp_host_unavailable' },
        armed: 'scheduled',
      })
    ).toThrow('a scheduled decision retry needs the Host admission wait')
  })

  it('never rewrites the approval message for a retry that is not recorded', () => {
    const failures = [...STALE_RESULTS, ...OTHER_FAILURES, ...DENIALS, limited(9)]
    const armedValues = ['scheduled', 'held', 'not_scheduled', null] as const
    let checked = 0
    let recorded = 0
    for (const medium of ['slack', 'teams'] as const) {
      for (const decision of ['approve', 'deny'] as const) {
        for (const armed of armedValues) {
          // Only a Host admission refusal with a wait can be armed.
          const results = armed === 'scheduled' ? [limited(9)] : failures
          for (const result of results) {
            const plan = planDecisionFeedback({ medium, decision, attempt: 'retry', result, armed })
            expect(plan.shared).toBeNull()
            checked += 1
          }
          // Witness: the same loop with a recorded decision does write it.
          const ok = planDecisionFeedback({
            medium,
            decision,
            attempt: 'retry',
            result: { ok: true },
            armed,
          })
          expect(ok.shared?.action).toBe('update_success')
          recorded += 1
        }
      }
    }
    expect(checked).toBe(2 * 2 * (3 * failures.length + 1))
    expect(recorded).toBe(2 * 2 * armedValues.length)
  })
})
