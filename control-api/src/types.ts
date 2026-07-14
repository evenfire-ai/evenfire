export const CLERUM_GROUP = 'clerum.io'
export const CLERUM_VERSION = 'v1alpha1'

export type ClerumResourceType =
  | 'hosts'
  | 'contexts'
  | 'communicationchannels'
  | 'mcpservers'
  | 'workflowrecipes'
  | 'workflowrecipepolicies'
  | 'sharedfilesystems'

export interface Metadata {
  name: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

export interface ClerumResource<TSpec = Record<string, unknown>> {
  apiVersion: `${typeof CLERUM_GROUP}/${typeof CLERUM_VERSION}`
  kind: string
  metadata: Metadata
  spec: TSpec
}

export interface ResourceListResponse {
  items: unknown[]
}

export interface HostOverview {
  host: unknown
  context: unknown | null
  communicationChannels: unknown[]
  mcpServers: unknown[]
  accessSummary: {
    telegramUserIds: string[]
    emails: string[]
    slackUserNames: string[]
  }
}

export interface SecretUpsertRequest {
  name: string
  namespace?: string
  type?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  data?: Record<string, string>
  stringData?: Record<string, string>
}
