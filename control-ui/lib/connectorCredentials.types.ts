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
