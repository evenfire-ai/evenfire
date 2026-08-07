import { signInternalControlJwt } from '../utils/internalControlSigner'

const DEFAULT_CONTROL_API_BASE_URL = 'http://control-api.control-plane.svc.cluster.local:8090'
const REQUEST_TIMEOUT_MS = 10_000

export interface PluginWorkloadSdkRevocationReceipt {
  state: 'missing' | 'revoking' | 'disabled' | 'conflict'
  revocationId?: string
  revoked: number
  fencedInvocations: number
  disabled?: number
}

export interface PluginWorkloadSdkRevocationClient {
  revoke(recipeNamespace: string, recipeName: string): Promise<PluginWorkloadSdkRevocationReceipt>
  finalize(
    recipeNamespace: string,
    recipeName: string,
    revocationId: string
  ): Promise<PluginWorkloadSdkRevocationReceipt>
}

/**
 * WRC-to-control-api revocation client. It carries only the recipe binding;
 * the signed internal JWT identifies WRC and is never exposed to the recipe
 * workload. A failed call is surfaced to the reconciler so teardown cannot
 * publish a false disabled state.
 */
export class HttpPluginWorkloadSdkRevocationClient implements PluginWorkloadSdkRevocationClient {
  constructor(
    private readonly baseUrl = process.env.CONTROL_API_BASE_URL?.trim() ||
      DEFAULT_CONTROL_API_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  revoke(recipeNamespace: string, recipeName: string): Promise<PluginWorkloadSdkRevocationReceipt> {
    return this.post('/api/v1/internal/plugin-workload-sdk/revoke', recipeNamespace, recipeName)
  }

  finalize(
    recipeNamespace: string,
    recipeName: string,
    revocationId: string
  ): Promise<PluginWorkloadSdkRevocationReceipt> {
    return this.post(
      '/api/v1/internal/plugin-workload-sdk/finalize-revocation',
      recipeNamespace,
      recipeName,
      revocationId
    )
  }

  private async post(
    path: string,
    recipeNamespace: string,
    recipeName: string,
    revocationId?: string
  ): Promise<PluginWorkloadSdkRevocationReceipt> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signInternalControlJwt()}`,
        },
        body: JSON.stringify({
          recipeNamespace,
          recipeName,
          ...(revocationId ? { revocationId } : {}),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(
          `Plugin Workload SDK revocation failed: HTTP ${response.status} for recipe "${recipeName}"`
        )
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error(
          `Plugin Workload SDK revocation returned invalid JSON for recipe "${recipeName}"`
        )
      }
      if (!isRevocationReceipt(body)) {
        throw new Error(
          `Plugin Workload SDK revocation returned an invalid receipt for recipe "${recipeName}"`
        )
      }
      if (
        path.endsWith('/finalize-revocation') &&
        body.state !== 'disabled' &&
        body.state !== 'missing'
      ) {
        throw new Error(
          `Plugin Workload SDK revocation did not confirm disabled state for recipe "${recipeName}"`
        )
      }
      return body
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(
          `Plugin Workload SDK revocation timed out after ${REQUEST_TIMEOUT_MS}ms for recipe "${recipeName}"`
        )
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }
}

function isRevocationReceipt(value: unknown): value is PluginWorkloadSdkRevocationReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    (record.state === 'missing' ||
      record.state === 'revoking' ||
      record.state === 'disabled' ||
      record.state === 'conflict') &&
    typeof record.revoked === 'number' &&
    Number.isInteger(record.revoked) &&
    record.revoked >= 0 &&
    typeof record.fencedInvocations === 'number' &&
    Number.isInteger(record.fencedInvocations) &&
    record.fencedInvocations >= 0 &&
    (record.revocationId === undefined ||
      (typeof record.revocationId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          record.revocationId
        )))
  )
}
