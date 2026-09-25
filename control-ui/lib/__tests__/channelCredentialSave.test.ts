import { describe, expect, it } from 'vitest'
import {
  buildCredentialOperationPlan,
  cleanCredentialStates,
  credentialStateIsDirty,
} from '../channelCredentialSave'

describe('channel credential parent-save planning', () => {
  it.each([
    [undefined, false],
    [{ status: 'untouched' } as const, false],
    [{ status: 'restored' } as const, false],
    [{ status: 'cleared' } as const, true],
    [{ status: 'replaced', value: 'next' } as const, true],
  ])('classifies %j dirty state as %s', (state, expected) => {
    expect(credentialStateIsDirty(state)).toBe(expected)
  })

  it('builds deterministic replace and clear operations in field order', () => {
    expect(
      buildCredentialOperationPlan(
        {
          'slack-bot-token': { status: 'cleared' },
          'telegram-bot-token': { status: 'replaced', value: '  telegram-next  ' },
          'slack-signing-secret': { status: 'replaced', value: 'slack-next' },
        },
        ['telegram', 'slack']
      ).operations
    ).toEqual([
      {
        kind: 'replace',
        key: 'telegram-bot-token',
        label: 'Telegram Bot Token',
        value: 'telegram-next',
      },
      {
        kind: 'replace',
        key: 'slack-signing-secret',
        label: 'Slack Signing Secret',
        value: 'slack-next',
      },
      { kind: 'clear', key: 'slack-bot-token', label: 'Slack Bot User OAuth Token' },
    ])
  })

  it('treats untouched and restored values as preserve operations', () => {
    const plan = buildCredentialOperationPlan(
      {
        'telegram-bot-token': { status: 'untouched' },
        'slack-signing-secret': { status: 'restored' },
      },
      ['telegram', 'slack']
    )
    expect(plan).toEqual({ operations: [], invalidLabels: [] })
  })

  it('rejects blank replacements without retaining the value in an error', () => {
    const plan = buildCredentialOperationPlan(
      { 'telegram-bot-token': { status: 'replaced', value: '   ' } },
      ['telegram']
    )
    expect(plan.operations).toEqual([])
    expect(plan.invalidLabels).toEqual(['Telegram Bot Token'])
    expect(JSON.stringify(plan)).not.toContain('telegram-next')
  })

  it('rejects operations whose provider is absent from the proposed channel', () => {
    const plan = buildCredentialOperationPlan({ 'slack-bot-token': { status: 'cleared' } }, [
      'telegram',
    ])
    expect(plan.operations).toEqual([])
    expect(plan.invalidLabels).toEqual(['Slack Bot User OAuth Token'])
  })

  it('cleans only successful fields after a partial save', () => {
    const states = cleanCredentialStates(
      {
        'telegram-bot-token': { status: 'replaced', value: 'secret-one' },
        'slack-signing-secret': { status: 'cleared' },
      },
      ['telegram-bot-token']
    )
    expect(states['telegram-bot-token']).toEqual({ status: 'untouched' })
    expect(states['slack-signing-secret']).toEqual({ status: 'cleared' })
  })
})
