import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'

type SecretMetadata = {
  metadata?: {
    labels?: Record<string, string>
    name?: string
  }
}

function secretName(item: unknown): string {
  return String((item as SecretMetadata).metadata?.name || '').trim()
}

function isHostSecret(item: unknown): boolean {
  const labels = (item as SecretMetadata).metadata?.labels || {}
  return String(labels[config.hostSecretLabelKey] || '') === config.hostSecretLabelValue
}

export function listHostSecrets(gateway: K8sGateway): Promise<Array<{ name: string }>> {
  return gateway.listSecrets(config.secretsNamespace).then(items =>
    items
      .filter(isHostSecret)
      .map(secretName)
      .filter(Boolean)
      .map(name => ({ name }))
  )
}
