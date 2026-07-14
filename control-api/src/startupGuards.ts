import { readFileSync } from 'node:fs'

interface StartupGuardConfig {
  internalControlJwtWrcHmacSecret: string
  internalControlJwtHccHmacSecret: string
  allowedIssuanceNamespaces: string[]
  hostsNamespace: string
  sandboxNamespace: string
  communicationChannelsNamespace: string
}

export function validateStartupGuards(config: StartupGuardConfig): void {
  for (const [envName, value] of [
    ['INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET', config.internalControlJwtWrcHmacSecret],
    ['INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET', config.internalControlJwtHccHmacSecret],
  ] as const) {
    if (!value || /^replace-with-/.test(value)) {
      throw new Error(`[ControlAPI] ${envName} must be set to a non-placeholder value`)
    }
  }

  for (const expectedNamespace of [config.hostsNamespace, config.sandboxNamespace]) {
    if (!config.allowedIssuanceNamespaces.includes(expectedNamespace.toLowerCase())) {
      throw new Error(
        `[ControlAPI] CONTROL_API_ALLOWED_ISSUANCE_NAMESPACES must include ${expectedNamespace}`
      )
    }
  }

  const podNamespace = readPodNamespace()
  assertChannelsNamespace(podNamespace, config.communicationChannelsNamespace)
}

/**
 * Read the pod's own namespace from the mounted ServiceAccount token file.
 * Returns an empty string when the file is absent (local dev, CLERUM_DEV_MODE)
 * and never throws.
 */
export function readPodNamespace(): string {
  const SA_NS_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
  try {
    return readFileSync(SA_NS_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Assert that a per-tenant control-api (pod namespace ≠ 'control-plane') does
 * not use the bare default 'channels' namespace for CommunicationChannels.
 *
 * A tenant pod's own namespace is 'control-plane-<slug>', so:
 *   - podNamespace empty (dev, no SA file)     → skip (safe)
 *   - podNamespace === 'control-plane'         → skip (single-cluster)
 *   - podNamespace === 'control-plane-<slug>'  → enforce channels-ns ≠ 'channels'
 *
 * @param podNamespace  The pod's own Kubernetes namespace (or '' in dev).
 * @param channelsNs    The configured CONTROL_API_COMMUNICATION_CHANNELS_NAMESPACE.
 */
export function assertChannelsNamespace(podNamespace: string, channelsNs: string): void {
  if (!podNamespace || podNamespace === 'control-plane') return
  if (channelsNs === 'channels') {
    throw new Error(
      `[ControlAPI] CONTROL_API_COMMUNICATION_CHANNELS_NAMESPACE must be channels-<slug> ` +
        `for tenant ${podNamespace}, got '${channelsNs}'. ` +
        `Set CONTROL_API_COMMUNICATION_CHANNELS_NAMESPACE=channels-<slug> in the tenant deployment.`
    )
  }
}
