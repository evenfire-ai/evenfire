import { describe, expect, it } from 'vitest'
import { shouldRecoverWorkflowTriggerTextResponse } from './toolUseLoopIntentRecovery'

describe('shouldRecoverWorkflowTriggerTextResponse', () => {
  it('does not classify a native shell command marker as a workflow recipe', () => {
    expect(
      shouldRecoverWorkflowTriggerTextResponse(
        "Run exactly this command: printf 'PR849-SHELL-20260926'",
        'The command completed.'
      )
    ).toBe(false)
  })

  it('recovers when a named workflow recipe request receives a text-only answer', () => {
    expect(
      shouldRecoverWorkflowTriggerTextResponse(
        'Run the quarterly-report workflow recipe',
        'I cannot find that report.'
      )
    ).toBe(true)
  })

  it('recovers an explicit workflow recipe request without a hyphenated name', () => {
    expect(
      shouldRecoverWorkflowTriggerTextResponse(
        'Run the workflow recipe onboarding',
        'I cannot complete that request.'
      )
    ).toBe(true)
  })

  it.each([
    'Run "quarterly-report"',
    "Run 'quarterly-report'",
    'Run “quarterly-report”',
    'Run ‘quarterly-report’',
    'Please run quarterly-report',
    'Launch quarterly-report',
    'Run quarterly-report.',
    'Please launch “quarterly-report”.',
  ])('recovers a direct named recipe request: %s', userText => {
    expect(shouldRecoverWorkflowTriggerTextResponse(userText, 'I can help with that.')).toBe(true)
  })

  it.each([
    'Run a shell command',
    'Run quarterly-report and delete it',
    `Run ${'a'.repeat(129)}-report`,
  ])('does not infer a recipe from unrelated or oversized text: %s', userText => {
    expect(shouldRecoverWorkflowTriggerTextResponse(userText, 'I can help with that.')).toBe(false)
  })
})
