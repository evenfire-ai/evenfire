import type { CreatedRegistryApiKey } from '../../lib/api'

export const DEFAULT_REGISTRY_HOST = 'example.com'

export function buildDockerLoginCommand(registry: string, key: string): string {
  return `docker login ${registry} -u _ -p ${key}`
}

export function buildPushCoordinate(registry: string, orgScope: string): string {
  return `${registry}/${orgScope}/<name>:<tag>`
}

export function deriveDockerconfigjson(registry: string, key: string): string {
  return JSON.stringify(
    {
      auths: {
        [registry]: {
          username: '_',
          password: key,
          auth: btoa(`_:${key}`),
        },
      },
    },
    null,
    2
  )
}

/**
 * Prefer the registry-built dockerconfigjson/registry when the additive
 * push-credential fields are present; otherwise derive them client-side from
 * the (already-in-browser) plaintext key. Same trust boundary either way.
 */
export function resolveDockerCredential(created: CreatedRegistryApiKey): {
  registry: string
  dockerconfigjson: string
} {
  const registry = created.registry || DEFAULT_REGISTRY_HOST
  const dockerconfigjson = created.dockerconfigjson || deriveDockerconfigjson(registry, created.key)
  return { registry, dockerconfigjson }
}
