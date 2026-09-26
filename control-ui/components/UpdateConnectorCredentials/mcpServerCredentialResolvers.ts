import type { EnvSecret, EnvSecretKeyMapping, McpServerResource } from '@lib/api'

/**
 * Narrows `server.spec.envSecret` (typed as `unknown` on the generic
 * `AnyRecord` spec) into the shape UpdateConnectorCredentials needs. A
 * malformed or partial envSecret (missing name, keys not an array, or no
 * usable key mappings) is treated the same as "no envSecret" — there is
 * nothing safely rotatable through this form either way.
 */
export function resolveEnvSecret(spec: Record<string, unknown> | undefined): EnvSecret | undefined {
  const raw = spec?.envSecret
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as { name?: unknown; keys?: unknown }
  if (typeof candidate.name !== 'string' || !Array.isArray(candidate.keys)) return undefined
  const keys = candidate.keys.filter(
    (k): k is EnvSecretKeyMapping =>
      Boolean(k) &&
      typeof (k as EnvSecretKeyMapping).secretKey === 'string' &&
      typeof (k as EnvSecretKeyMapping).envVar === 'string'
  )
  if (keys.length === 0) return undefined
  return { name: candidate.name, keys }
}

/**
 * The Marketplace source (catalog-id / catalog-version annotations, falling
 * back to legacy labels) used to resolve operator-friendly credential labels
 * for the connector's declared keys.
 */
export function resolveRegistryCredentialSource(
  metadata: McpServerResource['metadata'] | undefined
): { name: string; version: string } | undefined {
  const labels = (metadata?.labels ?? {}) as Record<string, unknown>
  const annotations = (metadata?.annotations ?? {}) as Record<string, unknown>
  const name = String(
    annotations['clerum.io/catalog-id'] ?? labels['clerum.io/catalog-id'] ?? ''
  ).trim()
  const version = String(
    annotations['clerum.io/catalog-version'] ?? labels['clerum.io/catalog-version'] ?? ''
  ).trim()
  return name && version ? { name, version } : undefined
}
