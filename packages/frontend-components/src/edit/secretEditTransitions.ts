import type { SecretEditState } from './types'

export type SecretEditTransitionEvent =
  | { type: 'input'; value: string }
  | { type: 'clear' }
  | { type: 'restore' }

export function transitionSecretEditState(
  existingValue: boolean,
  event: SecretEditTransitionEvent
): SecretEditState {
  if (event.type === 'input') {
    if (event.value) return { status: 'replaced', value: event.value }
    return existingValue ? { status: 'cleared' } : { status: 'untouched' }
  }

  if (event.type === 'clear') {
    return existingValue ? { status: 'cleared' } : { status: 'untouched' }
  }

  return existingValue ? { status: 'restored' } : { status: 'untouched' }
}
