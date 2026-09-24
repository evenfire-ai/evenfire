import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'
import { readSecretOrNull } from '../../services/secretRead.js'
import { isLlmHostSecret } from './llmSecretIdentity.js'

type SecretMetadata = {
  metadata?: {
    labels?: Record<string, string>
    name?: string
  }
  // Data-key names only — `secretService.listSecrets` never returns the values.
  keys?: string[]
}

function secretName(item: unknown): string {
  return String((item as SecretMetadata).metadata?.name || '').trim()
}

function secretKeys(item: unknown): string[] {
  const keys = (item as SecretMetadata).keys
  return Array.isArray(keys) ? keys : []
}

function isHostSecret(item: unknown): boolean {
  const labels = (item as SecretMetadata).metadata?.labels || {}
  return String(labels[config.hostSecretLabelKey] || '') === config.hostSecretLabelValue
}

// The `keys` are the stored data-key names (values are never returned) — the UI
// uses them to light up the "present" chips when editing an LLM Secret.
export function listHostSecrets(
  gateway: K8sGateway
): Promise<Array<{ name: string; keys: string[] }>> {
  return gateway.listSecrets(config.secretsNamespace).then(items =>
    items
      .filter(isHostSecret)
      .map(item => ({ name: secretName(item), keys: secretKeys(item) }))
      .filter(row => row.name.length > 0)
  )
}

/**
 * Anti-spoofing guard for `spec.secretRef` on Host create/edit (soft only on a
 * missing Secret).
 *
 * A Host resolves its LLM credentials from the Secret named in
 * `spec.secretRef`, in `config.secretsNamespace`. Without a check, a Host could
 * be pointed at ANY in-namespace Secret (e.g. an mcp-host runtime-auth Secret),
 * turning the Host into a read primitive for whatever the referenced Secret
 * holds. This guard requires the referenced Secret — WHEN IT ALREADY EXISTS —
 * to be an LLM host Secret (host-secret label OR a name in LLM_SECRET_NAMES).
 *
 * Deliberately soft on 404 (missing Secret); fail-loud on every other read error:
 *   - secretRef absent or non-string → null (nothing to check).
 *   - referenced Secret does not exist yet (404) → null. `secretMode:'new'` may
 *     create the Secret out of band; HCC's per-Host Role only ever grants the
 *     referenced name, so a dangling ref simply fails closed at runtime.
 *   - any other read failure propagates: an apiserver or transport failure as a
 *     SecretReadError (502/503 via the global handler). A swallowed 403 would
 *     turn this check off for as long as an RBAC drift lasts.
 *   - referenced Secret exists AND is an LLM host Secret → null. This keeps
 *     `secretMode:'existing'` working for BOTH the shared `chatllm-api-keys`
 *     Secret (matched by name) and any other per-host labeled Secret (by label).
 *
 * RESIDUAL (flagged to security review): this is a TYPE gate, not an OWNER gate.
 * Two per-host Hosts' LLM Secrets both carry the host-secret label, so Host A
 * can still be pointed at Host B's LLM Secret. That cross-host reference stays
 * possible by design here — a hard owner-match would break shared-secret reuse
 * (`chatllm-api-keys`, and any intentionally shared per-host Secret).
 */
export async function validateHostSecretRef(
  gateway: K8sGateway,
  spec: Record<string, unknown>
): Promise<{ errors: Array<{ field: string; message: string }> } | null> {
  const raw = spec.secretRef
  if (typeof raw !== 'string' || !raw.trim()) return null
  const name = raw.trim()

  const existing = (await readSecretOrNull(gateway, name, config.secretsNamespace)) as {
    metadata?: { labels?: Record<string, string> }
  } | null
  if (!existing) return null

  if (isLlmHostSecret({ name, labels: existing.metadata?.labels })) return null

  return {
    errors: [
      {
        field: 'spec.secretRef',
        message: `secretRef "${name}" does not reference an LLM host Secret (missing the ${config.hostSecretLabelKey}=${config.hostSecretLabelValue} label)`,
      },
    ],
  }
}
