import type { K8sGateway } from '../../k8s.js'

export function extractK8sStatusCode(err: unknown): number | undefined {
  const e = err as {
    statusCode?: number
    code?: number
    response?: { statusCode?: number; status?: number }
  }
  return e.statusCode ?? e.code ?? e.response?.statusCode ?? e.response?.status
}

export function ccCredentialsSecretName(ccName: string): string {
  return `cc-${ccName}-credentials`
}

function credentialsSecretRefName(spec: Record<string, unknown> | null | undefined): string | null {
  const ref = spec?.credentialsSecretRef
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null
  const name = (ref as { name?: unknown }).name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export async function preserveCommunicationChannelCredentialsSecretRef(
  gateway: K8sGateway,
  name: string,
  ns: string,
  spec: Record<string, unknown>,
  existingSpec?: Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  if (spec.credentialsSecretRef) return spec

  let existingSecretRefName = credentialsSecretRefName(existingSpec)
  if (existingSpec === undefined) {
    try {
      const existing = (await gateway.getResource('communicationchannels', name, ns)) as {
        spec?: Record<string, unknown>
      }
      existingSecretRefName = credentialsSecretRefName(existing.spec)
    } catch (err) {
      if (extractK8sStatusCode(err) !== 404) throw err
    }
  }

  if (existingSecretRefName) {
    return { ...spec, credentialsSecretRef: { name: existingSecretRefName } }
  }

  const defaultSecretName = ccCredentialsSecretName(name)
  try {
    await gateway.getSecret(defaultSecretName, ns)
    return { ...spec, credentialsSecretRef: { name: defaultSecretName } }
  } catch (err) {
    if (extractK8sStatusCode(err) !== 404) throw err
  }

  return spec
}
