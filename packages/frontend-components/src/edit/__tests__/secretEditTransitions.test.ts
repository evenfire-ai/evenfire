import { describe, expect, it } from 'vitest'
import { transitionSecretEditState } from '../secretEditTransitions'

describe('transitionSecretEditState', () => {
  it.each([
    [false, { type: 'input', value: 'draft' }, { status: 'replaced', value: 'draft' }],
    [true, { type: 'input', value: 'draft' }, { status: 'replaced', value: 'draft' }],
    [false, { type: 'input', value: '' }, { status: 'untouched' }],
    [true, { type: 'input', value: '' }, { status: 'cleared' }],
    [false, { type: 'clear' }, { status: 'untouched' }],
    [true, { type: 'clear' }, { status: 'cleared' }],
    [false, { type: 'restore' }, { status: 'untouched' }],
    [true, { type: 'restore' }, { status: 'restored' }],
  ] as const)('maps existingValue=%s and event=%j to %j', (existingValue, event, expected) => {
    expect(transitionSecretEditState(existingValue, event)).toEqual(expected)
  })
})
