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

  // These all returned true on origin/dev (any hyphenated token plus a trigger verb).
  it.each([
    'run the daily-report',
    'can you run daily-report',
    'could you please run daily-report',
    'run daily-report now',
    'run daily-report please',
    'please run daily-report!',
    'run daily-report?',
    'trigger daily-report with region=eu',
    'Run "daily-report" now.',
    'execute daily-report using region=eu and dry-run=true',
  ])('recovers a direct named recipe request with a natural tail: %s', userText => {
    expect(shouldRecoverWorkflowTriggerTextResponse(userText, 'I can help with that.')).toBe(true)
  })

  it.each([
    'Run a shell command',
    'run daily-report with',
    'run daily-report and delete it',
    'run daily-report now and then rm -rf /',
    'Run quarterly-report and delete it',
    `Run ${'a'.repeat(129)}-report`,
  ])('does not infer a recipe from unrelated or oversized text: %s', userText => {
    expect(shouldRecoverWorkflowTriggerTextResponse(userText, 'I can help with that.')).toBe(false)
  })

  it.each([
    ['whitespace after the verb', `run${' '.repeat(200_000)}x`],
    ['leading whitespace', `${' '.repeat(200_000)}run`],
    ['one long token', `run ${'a'.repeat(200_000)}`],
    ['repeated hyphen groups', `run ${'a-'.repeat(100_000)}`],
    ['long tail of filler', `run daily-report${' now'.repeat(50_000)} !`],
    ['whitespace before a rejected tail', `run daily-report${' '.repeat(200_000)}x`],
    ['long punctuation run', `run daily-report${'!'.repeat(200_000)}x`],
    ['repeated verbs', 'run '.repeat(50_000)],
  ])('classifies adversarial input in linear time: %s', (_label, userText) => {
    expect(userText.length).toBeGreaterThanOrEqual(150_000)
    const started = performance.now()
    const result = shouldRecoverWorkflowTriggerTextResponse(userText, 'I can help with that.')
    const elapsedMs = performance.now() - started
    // Liveness witness: a boolean means the classifier ran to completion.
    expect(typeof result).toBe('boolean')
    expect(elapsedMs).toBeLessThan(100)
  })
})
