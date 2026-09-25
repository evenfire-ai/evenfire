import type { SecretEditState } from '@clerum/frontend-components'
import { CHANNEL_CREDENTIAL_FIELDS } from '@components/ChannelCredentialsPanel/constants'
import type { CredentialEditStates, CredentialKey } from '@components/ChannelCredentialsPanel/types'
import type { ChannelType } from './channelTypes'

export type CredentialOperation =
  | { kind: 'replace'; key: CredentialKey; label: string; value: string }
  | { kind: 'clear'; key: CredentialKey; label: string }

export function credentialStateIsDirty(state: SecretEditState | undefined): boolean {
  return state?.status === 'replaced' || state?.status === 'cleared'
}

export function buildCredentialOperationPlan(
  states: CredentialEditStates,
  validChannelTypes: readonly ChannelType[]
): { operations: CredentialOperation[]; invalidLabels: string[] } {
  const valid = new Set(validChannelTypes)
  const operations: CredentialOperation[] = []
  const invalidLabels: string[] = []

  for (const field of CHANNEL_CREDENTIAL_FIELDS) {
    const state = states[field.key]
    if (!credentialStateIsDirty(state)) continue
    if (!valid.has(field.channelType)) {
      invalidLabels.push(field.label)
      continue
    }
    if (state?.status === 'replaced') {
      const value = state.value.trim()
      if (value) operations.push({ kind: 'replace', key: field.key, label: field.label, value })
      else invalidLabels.push(field.label)
    } else if (state?.status === 'cleared') {
      operations.push({ kind: 'clear', key: field.key, label: field.label })
    }
  }
  return { operations, invalidLabels }
}

export function cleanCredentialStates(
  states: CredentialEditStates,
  successfulKeys: readonly CredentialKey[]
): CredentialEditStates {
  const successful = new Set(successfulKeys)
  return Object.fromEntries(
    Object.entries(states).map(([key, state]) => [
      key,
      successful.has(key as CredentialKey) ? { status: 'untouched' } : state,
    ])
  ) as CredentialEditStates
}
