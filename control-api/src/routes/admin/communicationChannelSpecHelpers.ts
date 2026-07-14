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

export async function preserveCommunicationChannelCredentialsSecretRef(
  gateway: K8sGateway,
  name: string,
  ns: string,
  spec: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (spec.credentialsSecretRef) return spec

  let existingSecretRef: { name?: string } | undefined
  try {
    const existing = (await gateway.getResource('communicationchannels', name, ns)) as {
      spec?: { credentialsSecretRef?: { name?: string } }
    }
    existingSecretRef = existing.spec?.credentialsSecretRef
  } catch (err) {
    if (extractK8sStatusCode(err) !== 404) throw err
  }

  if (existingSecretRef?.name) {
    return { ...spec, credentialsSecretRef: { name: existingSecretRef.name } }
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
