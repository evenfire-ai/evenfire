import { CODEX_UNASSIGNED_CONNECTION_KEY } from './codexSubscription'

export const SUBSCRIPTION_CREDENTIAL_PREFIX = 'sub:'

export type ParsedCredentialSelect =
  | { kind: 'empty' }
  | { kind: 'secret'; name: string }
  | { kind: 'subscription'; connectionKey: string }

export function credentialSelectValue(secretRef: string, connectionRef: string): string {
  const key = connectionRef.trim()
  if (key && key !== CODEX_UNASSIGNED_CONNECTION_KEY) {
    return `${SUBSCRIPTION_CREDENTIAL_PREFIX}${key}`
  }
  return secretRef.trim()
}

export function parseCredentialSelect(value: string): ParsedCredentialSelect {
  const trimmed = value.trim()
  if (!trimmed) return { kind: 'empty' }
  if (trimmed.startsWith(SUBSCRIPTION_CREDENTIAL_PREFIX)) {
    const connectionKey = trimmed.slice(SUBSCRIPTION_CREDENTIAL_PREFIX.length).trim()
    if (!connectionKey || connectionKey === CODEX_UNASSIGNED_CONNECTION_KEY) {
      return { kind: 'empty' }
    }
    return { kind: 'subscription', connectionKey }
  }
  return { kind: 'secret', name: trimmed }
}
