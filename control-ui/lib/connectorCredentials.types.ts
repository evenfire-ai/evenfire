import type { EnvSecret, McpServerResource } from '@lib/api'
import type { McpSecretSummary } from '@lib/oauthInstall.types'

export type AttachMode = 'create-new' | 'use-existing'

export type AttachCredentialRow = {
  id: string
  secretKey: string
  envVar: string
  value: string
}

export type AttachValidation = {
  message: string
  field?: string
}

export type AttachCredentialsRequest = {
  serverName: string
  expectedUid?: string
  mode: AttachMode
  secretName: string
  rows: AttachCredentialRow[]
  selectedSecret?: McpSecretSummary
  onSecretWritten: () => void
}

export type AttachedCredentials = {
  server: McpServerResource
  cutoff: string
  affectedConnectors: string[]
}

export type AttachPayload = {
  reference: EnvSecret
  data: Record<string, string>
}

/**
 * Validation switches for credential selection. `storedKeysOnly` marks the
 * reference-only reuse flows: every key must already be stored in the selected
 * Secret and credential values are forbidden. The keyless-attach flow omits it
 * because it may write new keys into a shared Secret.
 */
export type AttachValidationOptions = {
  storedKeysOnly?: boolean
}

export type ExistingCredentialSelection = {
  secret?: McpSecretSummary
  rows: AttachCredentialRow[]
  ready: boolean
}

export type ChangeCredentialReferenceRequest = {
  serverName: string
  server: McpServerResource
  selection: ExistingCredentialSelection
}
