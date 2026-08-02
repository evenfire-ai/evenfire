import type { ApiKeys } from '../../types'
import { PluginWorkloadError } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'

export interface BrokeredCredential {
  target: PromptBridgeTarget
  keys: ApiKeys
  llmSecretName: string
}

export interface CredentialBrokerClientOptions {
  baseUrl: string
  recipeNamespace: string
  recipeName: string
  getAccessToken: () => string
  fetchImpl?: typeof fetch
}

/**
 * Redeems one short-lived, target-bound authorization ticket at WRC. The
 * response contains credentials for exactly one provider attempt and is never
 * cached. Errors are deliberately collapsed to a terminal public error so the
 * caller cannot use promptBridge to enumerate provider configuration.
 */
export class PluginWorkloadSdkCredentialBrokerClient {
  constructor(private readonly opts: CredentialBrokerClientOptions) {}

  async resolve(input: {
    invocationId: string
    target: PromptBridgeTarget
    credentialTicket: string
    timeoutMs?: number
  }): Promise<BrokeredCredential> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/api/v1/workflow/${encodeURIComponent(
      this.opts.recipeName
    )}/plugin-workload-sdk/credentials`

    let response: Response
    try {
      const signal =
        input.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(Math.max(1, input.timeoutMs))
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.getAccessToken()}`,
        },
        body: JSON.stringify({
          recipeNamespace: this.opts.recipeNamespace,
          invocationId: input.invocationId,
          target: input.target,
          credentialTicket: input.credentialTicket,
        }),
        signal,
      })
    } catch {
      throw unavailable()
    }

    if (!response.ok) throw unavailable()
    const raw = await response.json().catch(() => null)
    if (!isBrokerResponse(raw, input.target)) throw unavailable()

    return {
      target: input.target,
      keys: { [input.target.provider]: raw.credentials } as ApiKeys,
      llmSecretName: raw.llmSecretName,
    }
  }
}

function isBrokerResponse(
  raw: unknown,
  expected: PromptBridgeTarget
): raw is { credentials: Record<string, string>; llmSecretName: string } {
  if (typeof raw !== 'object' || raw === null) return false
  const body = raw as Record<string, unknown>
  if (
    body.provider !== expected.provider ||
    body.model !== expected.model ||
    body.credentialSlot !== expected.credentialSlot ||
    typeof body.llmSecretName !== 'string' ||
    body.llmSecretName.length === 0 ||
    typeof body.credentials !== 'object' ||
    body.credentials === null ||
    Array.isArray(body.credentials)
  ) {
    return false
  }
  const credentials = body.credentials as Record<string, unknown>
  const entries = Object.entries(credentials)
  return (
    entries.length > 0 &&
    entries.every(
      ([key, value]) =>
        /^[a-z0-9][a-z0-9-]{0,127}$/.test(key) && typeof value === 'string' && value.length > 0
    )
  )
}

function unavailable(): PluginWorkloadError {
  return new PluginWorkloadError(
    'provider_unavailable',
    'authorized provider credentials are unavailable',
    false,
    'credential_unavailable'
  )
}
