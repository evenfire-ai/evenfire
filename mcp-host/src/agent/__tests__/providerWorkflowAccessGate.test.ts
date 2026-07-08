import { describe, expect, it } from 'vitest'
import {
  looksLikeWorkflowAccessRequest,
  looksLikeWorkflowTriggerRequest,
  workflowAccessDeniedResponse,
} from '../providerWorkflowAccessGate'

describe('provider workflow access gate', () => {
  it.each([
    'List the workflow recipes I can run.',
    'what workflows are available?',
    'Show workflow details for risk-review',
    'Run risk-review with marker alpha',
    'Trigger the workflow recipe named risk-review',
    'Get the workflow status for risk-review',
    'Download the workflow result artifact for risk-review',
    'Download artifact for workflow risk-review',
    '/approve risk-review',
  ])('classifies workflow access request: %s', content => {
    expect(looksLikeWorkflowAccessRequest(content)).toBe(true)
  })

  it.each([
    'what is a workflow?',
    'Explain workflows',
    'Define a workflow',
    'Hello, summarize this conversation',
    'Run a shell command in the workspace',
    'Download the generated artifact',
    'Send me the output file',
  ])('allows normal chat or generic explanation: %s', content => {
    expect(looksLikeWorkflowAccessRequest(content)).toBe(false)
  })

  it('detects explicit or workflow-shaped trigger requests without matching generic run text', () => {
    expect(looksLikeWorkflowTriggerRequest('Run risk-review with marker alpha')).toBe(true)
    expect(looksLikeWorkflowTriggerRequest('Execute the workflow recipe named payroll')).toBe(true)
    expect(looksLikeWorkflowTriggerRequest('Run a command')).toBe(false)
    expect(
      looksLikeWorkflowTriggerRequest(
        'List the workflow recipes I can run. Include exact workflow recipe names only.'
      )
    ).toBe(false)
  })

  it('uses channel-specific verification copy', () => {
    expect(workflowAccessDeniedResponse('telegram')).toContain('Telegram conversation')
    expect(workflowAccessDeniedResponse('slack')).toContain('Slack workspace conversation')
  })
})
