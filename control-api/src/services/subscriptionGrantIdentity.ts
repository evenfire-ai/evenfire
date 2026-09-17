import { PROVIDER_AUTH_MODE, isLlmProviderId } from '@clerum/llm-providers'
import { isPlainObject } from '../utils/isPlainObject.js'
import {
  CODEX_CONNECTION_REF_ANNOTATION,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  isCodexUnassignedConnectionKey,
  readHostCodexConnectionRef,
} from './codexSubscriptionConnection.js'

export const SUBSCRIPTION_CONNECTION_REF_ANNOTATION =
  'clerum.io/subscription-connection-ref' as const

export type SubscriptionGrantAttestErrorCode = 'host_binding_mismatch' | 'unassigned_connection'

export type SubscriptionGrantAttestResult =
  | { ok: true; provider: string; connectionKey: string }
  | { ok: false; code: SubscriptionGrantAttestErrorCode; message: string }

function isOauthBroker(provider: string): boolean {
  return isLlmProviderId(provider) && PROVIDER_AUTH_MODE[provider] === 'oauth-broker'
}

function knownOauthBrokerIds(): string[] {
  return (Object.keys(PROVIDER_AUTH_MODE) as Array<keyof typeof PROVIDER_AUTH_MODE>).filter(
    id => PROVIDER_AUTH_MODE[id] === 'oauth-broker'
  )
}

function collectMatchingOauthBrokers(values: unknown[]): string[] {
  const providers: string[] = []
  for (const id of knownOauthBrokerIds()) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim() === id && !providers.includes(id)) {
        providers.push(id)
      }
    }
  }
  return providers
}

export function collectHostOauthBrokerProviders(spec: Record<string, unknown>): string[] {
  const values: unknown[] = []
  if (isPlainObject(spec.model)) values.push(spec.model.provider)
  if (Array.isArray(spec.allowedModels)) {
    for (const entry of spec.allowedModels) {
      if (isPlainObject(entry)) values.push(entry.provider)
    }
  }
  if (isPlainObject(spec.llmPolicy) && Array.isArray(spec.llmPolicy.fallbacks)) {
    for (const entry of spec.llmPolicy.fallbacks) {
      if (isPlainObject(entry)) values.push(entry.provider)
    }
  }
  return collectMatchingOauthBrokers(values)
}

export function collectRecipeOauthBrokerProviders(spec: Record<string, unknown>): string[] {
  const values: unknown[] = []
  if (isPlainObject(spec.agent)) values.push(spec.agent.provider)
  if (Array.isArray(spec.steps)) {
    for (const step of spec.steps) {
      if (isPlainObject(step) && isPlainObject(step.agent)) values.push(step.agent.provider)
    }
  }
  return collectMatchingOauthBrokers(values)
}

/**
 * Codex alias is read only when the attested provider is codex-subscription.
 * Grok (and any other broker) reads only the canonical annotation.
 * Disagree (both set, unequal) fails closed. Non-empty Codex alias on a
 * non-Codex provider fails closed.
 */
export function readSubscriptionConnectionRef(input: {
  provider: string
  annotations?: Record<string, string> | null
}):
  | { ok: true; connectionKey: string }
  | { ok: false; code: 'host_binding_mismatch'; message: string } {
  const annotations = input.annotations ?? {}
  const canonical =
    typeof annotations[SUBSCRIPTION_CONNECTION_REF_ANNOTATION] === 'string'
      ? annotations[SUBSCRIPTION_CONNECTION_REF_ANNOTATION].trim()
      : ''
  const alias =
    typeof annotations[CODEX_CONNECTION_REF_ANNOTATION] === 'string'
      ? annotations[CODEX_CONNECTION_REF_ANNOTATION].trim()
      : ''

  if (input.provider === 'codex-subscription') {
    if (canonical && alias && canonical !== alias) {
      return {
        ok: false,
        code: 'host_binding_mismatch',
        message: 'subscription connection annotations disagree',
      }
    }
    return { ok: true, connectionKey: readHostCodexConnectionRef(canonical || alias) }
  }

  if (alias) {
    return {
      ok: false,
      code: 'host_binding_mismatch',
      message: 'Codex connection annotation is not valid for this oauth-broker provider',
    }
  }
  return { ok: true, connectionKey: readHostCodexConnectionRef(canonical) }
}

export function attestLiveBrokerTarget(input: {
  requestedProvider: string
  liveBrokerProviders: string[]
}): Exclude<SubscriptionGrantAttestResult, { ok: true }> | { ok: true; provider: string } {
  if (!isOauthBroker(input.requestedProvider)) {
    return {
      ok: false,
      code: 'host_binding_mismatch',
      message: 'requested provider is not an oauth-broker target',
    }
  }
  if (!input.liveBrokerProviders.includes(input.requestedProvider)) {
    return {
      ok: false,
      code: 'host_binding_mismatch',
      message: 'requested oauth-broker provider is not a live target on this resource',
    }
  }
  return { ok: true, provider: input.requestedProvider }
}

export function attestRequestedBrokerProvider(input: {
  requestedProvider: string
  liveBrokerProviders: string[]
  liveConnectionRef: string
}): SubscriptionGrantAttestResult {
  const target = attestLiveBrokerTarget(input)
  if (!target.ok) return target
  const connectionKey = readHostCodexConnectionRef(input.liveConnectionRef)
  if (
    isCodexUnassignedConnectionKey(connectionKey) ||
    connectionKey === CODEX_UNASSIGNED_CONNECTION_KEY ||
    (input.requestedProvider === 'grok-subscription' && connectionKey === 'deployment-default')
  ) {
    return {
      ok: false,
      code: 'unassigned_connection',
      message: 'Host has no coding-plan subscription assigned',
    }
  }
  return { ok: true, provider: input.requestedProvider, connectionKey }
}
