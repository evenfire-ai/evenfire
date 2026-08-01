/**
 * Plugin Workload SDK — domain types (spec §9, §10, §13, §14).
 *
 * These are the request/response shapes plugin workloads see. They contain
 * NO provider keys, bearer tokens, user contact data, or control-api
 * internals — the anti-corruption layer guarantees nothing else leaks.
 */

export const PLUGIN_WORKLOAD_SDK_PURPOSES = [
  'summarization',
  'classification',
  'extraction',
  'generation',
  'translation',
  'question_answering',
  'analysis',
] as const
export type PluginWorkloadSdkPurpose = (typeof PLUGIN_WORKLOAD_SDK_PURPOSES)[number]

export const DEFAULT_IDEMPOTENCY_KEY_PATTERN = '^[a-zA-Z0-9_-]{1,128}$'
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128
export const DEFAULT_MAX_REQUEST_CONTENT_BYTES = 128 * 1024
export const DEFAULT_MAX_TITLE_BYTES = 256
export const DEFAULT_MAX_BODY_BYTES = 4096

export interface PromptBridgeRequest {
  model?: string
  provider?: string
  targetRef?: string
  modelPolicyRef?: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
  purpose: string
  idempotencyKey: string
  metadata?: Record<string, unknown>
}

export interface PromptBridgeTarget {
  targetRef: string
  provider: string
  model: string
  credentialSlot: string
}

export interface PromptBridgeResult {
  invocationId: string
  model: string
  servedTarget: PromptBridgeTarget
  fallbackUsed: boolean
  policyRevision: number
  usage: { inputTokens: number; outputTokens: number }
  content: string
  finishReason: 'complete' | 'length' | 'content_filter'
  correlationId: string
  createdAt: string
}

export interface ClientNotificationRequest {
  eventType: string
  target?: { targetRef: string }
  userRef?: string
  idempotencyKey: string
  notification: {
    title: string
    body: string
    data?: Record<string, unknown>
    actionRef?: { type: string; id: string; urlRef?: string }
    deliveryPolicyRef?: string
    correlationId?: string
  }
}

export interface ClientNotificationResult {
  notificationId: string
  status: 'accepted' | 'delivered' | 'failed'
  target: { targetRef?: string; userRef?: string }
  eventType: string
  title: string
  body: string
  data?: Record<string, unknown>
  actionRef?: { type: string; id: string; urlRef?: string }
  deliveryPolicyRef?: string
  correlationId?: string
  createdAt: string
}
