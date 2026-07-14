import type { CredentialSchema, RegistryEntry } from '../lib/api'
import { analyzeRegistryEgressSummary } from '../lib/egressModel'

const NO_CREDENTIAL_SCHEMA: CredentialSchema = {
  required: false,
  authType: 'none',
  keys: [],
}

export function getEmbeddedCredentialSchema(entry: RegistryEntry): CredentialSchema {
  const raw = entry.mcp_server_meta?.credentialSchema
  if (!raw || !Array.isArray(raw.keys)) return NO_CREDENTIAL_SCHEMA
  return {
    required: raw.required === true,
    authType: typeof raw.authType === 'string' ? raw.authType : 'none',
    keys: raw.keys.flatMap(key => {
      if (!key || typeof key !== 'object' || typeof key.name !== 'string') return []
      return [
        {
          name: key.name,
          label: typeof key.label === 'string' ? key.label : key.name,
          kind: typeof key.kind === 'string' ? key.kind : 'password',
          ...(typeof key.semanticType === 'string' ? { semanticType: key.semanticType } : {}),
          ...(typeof key.description === 'string' ? { description: key.description } : {}),
          ...(Array.isArray(key.enumValues) ? { enumValues: key.enumValues } : {}),
        },
      ]
    }),
  }
}

export function getExternalEgressNotice(entry: RegistryEntry): {
  targets: string[]
  ports: number[]
  isRemote: boolean
  wideCidr: boolean
  bindingCount: number
  blockingError?: string
} | null {
  const meta = entry.mcp_server_meta
  if (!meta) return null

  if (entry.server_mode === 'remote') {
    const remoteUrl = meta.remoteEndpoints?.[0]?.url
    if (!remoteUrl) return null
    try {
      const parsed = new URL(remoteUrl)
      return {
        targets: [parsed.hostname],
        ports: [parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443],
        isRemote: true,
        wideCidr: false,
        bindingCount: 1,
      }
    } catch {
      return {
        targets: [remoteUrl],
        ports: [443],
        isRemote: true,
        wideCidr: false,
        bindingCount: 1,
      }
    }
  }

  const analyzed = analyzeRegistryEgressSummary(meta.egressSummary)
  if (!analyzed) return null
  if (analyzed.mode === 'public-web') {
    return {
      targets: analyzed.targets,
      ports: analyzed.ports,
      isRemote: false,
      wideCidr: true,
      bindingCount: analyzed.bindingCount,
      blockingError: analyzed.blockingError,
    }
  }

  return {
    targets: analyzed.targets,
    ports: analyzed.ports,
    isRemote: false,
    wideCidr: false,
    bindingCount: analyzed.bindingCount,
    blockingError: analyzed.blockingError,
  }
}
