const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_K8S_NAME_LENGTH = 63
const LEGACY_STANDALONE_NAMESPACE = 'mcp-host'
const LEGACY_STANDALONE_NAME = 'standalone'

function isK8sName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_K8S_NAME_LENGTH && K8S_NAME_RE.test(value)
}

/**
 * Derive the durable first-party GFS principal for an HCC-managed Host.
 * Kubernetes namespace/name is the identity boundary. Display labels and the
 * Host UID are deliberately absent because runtime generation is separate.
 */
export function makeExpectedHostGfsSubject(namespace: string, name: string): string | null {
  if (!isK8sName(namespace) || !isK8sName(name)) return null
  // This subject belongs exclusively to the legacy fleet-wide grant migration.
  // A real Host must never acquire that historical shared principal.
  if (namespace === LEGACY_STANDALONE_NAMESPACE && name === LEGACY_STANDALONE_NAME) return null
  return `host:1st:${namespace}/${name}`
}
