export const CLERUM_GROUP = 'clerum.io'
export const CLERUM_VERSION = 'v1alpha1'

export type ClerumResourceType =
  | 'hosts'
  | 'contexts'
  | 'communicationchannels'
  | 'mcpservers'
  | 'llmhooks'
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

/**
 * Optimistic-concurrency preconditions for a Secret mutation: "act on THIS object, or
 * fail". Both fields come from a read the caller has already performed.
 *
 * WHY THIS EXISTS. `updateSecret` and `deleteSecret` are name-addressed by default — the
 * update re-reads to pick up the current `resourceVersion` (so it always wins the write)
 * and the delete carries no preconditions at all. That is the right default for a
 * single-owner Secret, where the caller IS the source of truth. It is wrong for one whose
 * ownership can change hands, because a caller that checked ownership and then mutated by
 * name will happily overwrite or delete whatever answers to that name now.
 *
 * Supplying these turns the mutation itself into the compare-and-swap: the API server
 * rejects it with 409 rather than the caller trying to prove freshness with a second
 * request it can never fuse to the write. Callers are expected to handle 409 — re-read,
 * decide whether the object is still theirs, and retry or surrender.
 *
 * `uid` is the identity check that survives a delete-and-recreate of the same name: data,
 * labels and annotations can all be reproduced by a new owner, the uid cannot.
 * `resourceVersion` is the change check — it says "something edited this", not "this is a
 * different object".
 *
 * OPTIONAL BY DESIGN. Omit them and both methods behave exactly as they always have; the
 * admin `/secrets` routes and inter-service token rotation are single-owner writers and
 * want the last-writer-wins default.
 */
export interface SecretPreconditions {
  uid?: string
  resourceVersion?: string
}
