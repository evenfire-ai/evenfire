import { describe, expect, it } from 'vitest'
import { classifyErrorKind, describeSendFailure, errorRecoveryHint } from '../format'

describe('classifyErrorKind — host availability codes', () => {
  it('classifies host_waking messages as waking, even wrapped by Electron IPC', () => {
    expect(
      classifyErrorKind(
        "Error invoking remote method 'rpc:invokeHostMessage': " +
          'Error: host_waking: agent host "chatllm" is waking up — retry shortly'
      )
    ).toBe('waking')
  })

  it('classifies host_draining messages as waking', () => {
    expect(
      classifyErrorKind('host_draining: agent host "chatllm" is draining — retry shortly')
    ).toBe('waking')
  })

  it('keeps the existing classifications intact', () => {
    expect(classifyErrorKind('Gateway Timeout')).toBe('network')
    expect(classifyErrorKind('403 Forbidden')).toBe('auth')
    expect(classifyErrorKind('Upstream host unavailable 502')).toBe('upstream')
  })

  it('provides a waking-specific recovery hint', () => {
    expect(errorRecoveryHint('waking')).toContain('starting up')
  })
})

describe('describeSendFailure', () => {
  it('composes the access text for an auth failure', () => {
    const { summary, hint } = describeSendFailure('403 Forbidden: missing send scope', 'auth')
    expect(`${summary} ${hint}`).toBe(
      'Access issue while sending to this agent. You may not have access to this agent anymore. Sign in again or ask an admin for access.'
    )
  })

  it.each([
    ['waking', 'Agent is waking up.'],
    ['network', 'Temporary connection issue while sending to the agent.'],
    ['auth', 'Access issue while sending to this agent.'],
    ['validation', 'Unable to send message to this agent.'],
    ['upstream', 'Unable to send message to this agent.'],
    ['unknown', 'Unable to send message to this agent.'],
  ] as const)('gives the %s sentence and the hint of that kind', (kind, sentence) => {
    expect(describeSendFailure('a failure', kind)).toEqual({
      summary: sentence,
      hint: errorRecoveryHint(kind),
    })
  })

  it.each(['413 Payload Too Large: request entity too large', 'Payload Too Large'])(
    'names the size limit for "%s", whatever the kind',
    message => {
      const { summary, hint } = describeSendFailure(message, 'upstream')
      expect(summary).toBe(
        'The message is larger than the deployed runtime accepts (images or attached files).'
      )
      expect(hint).toContain('Send fewer or smaller attachments.')
    }
  )

  it('mentions no team in any hint', () => {
    const kinds = ['waking', 'network', 'auth', 'validation', 'upstream', 'unknown'] as const
    // Witness: every kind produced a hint.
    expect(kinds.map(kind => errorRecoveryHint(kind)).every(hint => hint.length > 0)).toBe(true)
    for (const kind of kinds) expect(errorRecoveryHint(kind).toLowerCase()).not.toContain('team')
  })
})
