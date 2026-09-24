import { CODEX_UNASSIGNED_CONNECTION_KEY } from './codexSubscription'

export const SUBSCRIPTION_CREDENTIAL_PREFIX = 'sub:'

export type ParsedCredentialSelect =
  | { kind: 'empty' }
  | { kind: 'secret'; name: string }
  | {
      kind: 'subscription'
      provider: 'codex-subscription' | 'grok-subscription'
      connectionKey: string
    }

export function credentialSelectValue(
  secretRef: string,
  connectionRef: string,
  provider: 'codex-subscription' | 'grok-subscription' = 'codex-subscription'
): string {
  const key = connectionRef.trim()
  if (key && key !== CODEX_UNASSIGNED_CONNECTION_KEY) {
    return `${SUBSCRIPTION_CREDENTIAL_PREFIX}${provider}:${key}`
  }
  return secretRef.trim()
}

export function parseCredentialSelect(value: string): ParsedCredentialSelect {
  const trimmed = value.trim()
  if (!trimmed) return { kind: 'empty' }
  if (trimmed.startsWith(SUBSCRIPTION_CREDENTIAL_PREFIX)) {
    const rest = trimmed.slice(SUBSCRIPTION_CREDENTIAL_PREFIX.length).trim()
    if (!rest || rest === CODEX_UNASSIGNED_CONNECTION_KEY) {
      return { kind: 'empty' }
    }
    const grokPrefix = 'grok-subscription:'
    const codexPrefix = 'codex-subscription:'
    if (rest.startsWith(grokPrefix)) {
      const connectionKey = rest.slice(grokPrefix.length).trim()
      if (!connectionKey || connectionKey === CODEX_UNASSIGNED_CONNECTION_KEY) {
        return { kind: 'empty' }
      }
      return { kind: 'subscription', provider: 'grok-subscription', connectionKey }
    }
    if (rest.startsWith(codexPrefix)) {
      const connectionKey = rest.slice(codexPrefix.length).trim()
      if (!connectionKey || connectionKey === CODEX_UNASSIGNED_CONNECTION_KEY) {
        return { kind: 'empty' }
      }
      return { kind: 'subscription', provider: 'codex-subscription', connectionKey }
    }
    return { kind: 'subscription', provider: 'codex-subscription', connectionKey: rest }
  }
  return { kind: 'secret', name: trimmed }
}
