/**
 * Non-secret provider env source (AWS_REGION, VERTEX_PROJECT_ID/VERTEX_LOCATION,
 * AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_API_VERSION, …).
 *
 * Operators set these under Control UI Host → Environment, which writes the
 * per-Host `host-<ref>-env` ConfigMap / `host-<ref>-env-secret` Secret. HCC does
 * NOT `envFrom` those into the pod; mcp-host reads them through its watched
 * ConfigStore. The drivers therefore take a lookup function instead of reading
 * `process.env` directly.
 *
 * The values are deliberately NOT injected into `process.env`: that would leak
 * per-Host (possibly secret-tier) entries into every child process (shell tool,
 * recipe sub-processes). The lookup stays in-process.
 */
import { type LlmProvider, descriptorFor } from './registryCore'

/** Resolve a non-secret provider env var by name; undefined when unset. */
export type ProviderEnvLookup = (name: string) => string | undefined

/** Default source: the pod's own environment (dev mode, recipe pods, tests). */
export const processEnvLookup: ProviderEnvLookup = name => process.env[name]

/** Names of the non-secret env vars `provider` declares in its descriptor. */
export function providerNonSecretEnvNames(provider: LlmProvider): readonly string[] {
  return descriptorFor(provider).nonSecretEnv.map(v => v.envName)
}

/**
 * Restrict `source` to the non-secret env names `provider` declares. Any other
 * name resolves to undefined, so a driver can never read an arbitrary per-Host
 * entry (e.g. a credential) through this channel.
 */
export function providerEnvLookup(
  provider: LlmProvider,
  source: ProviderEnvLookup
): ProviderEnvLookup {
  const allowed = new Set(providerNonSecretEnvNames(provider))
  return name => (allowed.has(name) ? source(name) : undefined)
}

/**
 * Stable fingerprint of the declared non-secret env values for `provider`, used
 * to detect a Host → Environment edit that should rebuild the live provider.
 */
export function providerEnvFingerprint(provider: LlmProvider, source: ProviderEnvLookup): string {
  return JSON.stringify(
    providerNonSecretEnvNames(provider).map(name => [name, source(name) ?? null])
  )
}

/**
 * Change detector for the live-provider rebuild on a Host → Environment edit.
 * Captures the declared non-secret values of `provider` now; each call returns
 * true only when they differ from the previous observation, so unrelated
 * per-Host env edits (e.g. a GITHUB_TOKEN rotation) do not rebuild the provider.
 */
export function createProviderEnvChangeDetector(
  provider: LlmProvider,
  source: ProviderEnvLookup
): () => boolean {
  let last = providerEnvFingerprint(provider, source)
  return () => {
    const next = providerEnvFingerprint(provider, source)
    if (next === last) return false
    last = next
    return true
  }
}
