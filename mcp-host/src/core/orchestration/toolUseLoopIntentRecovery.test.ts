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
})
