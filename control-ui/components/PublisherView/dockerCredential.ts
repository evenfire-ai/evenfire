import type { CreatedRegistryApiKey } from '../../lib/api'

export const DEFAULT_REGISTRY_HOST = 'registry.evenfire.ai'

export function buildDockerLoginCommand(registry: string, key: string): string {
  return `docker login ${registry} -u _ -p ${key}`
}

/**
 * The Docker namespace for an org scope. resolvePublishScope() returns the scope
 * already prefixed as `@<org>`, but a Docker repo path must not contain '@' (it
 * is the digest delimiter — `docker` rejects it with "invalid reference format"),
 * so the leading '@' is dropped.
 */
export function dockerNamespace(orgScope: string): string {
  return orgScope.replace(/^@/, '')
}

export function buildPushCoordinate(registry: string, orgScope: string): string {
  return `${registry}/${dockerNamespace(orgScope)}/<name>:<tag>`
}

/**
 * The fully-qualified image coordinate for a specific entry — the user never
 * composes this by hand (design spec §5.5), so malformed-path pushes become
 * unreachable rather than documented.
 */
export function buildImageCoordinate(
  registry: string,
  orgScope: string,
  name: string,
  tag: string
): string {
  return `${registry}/${dockerNamespace(orgScope)}/${name}:${tag}`
}

export function buildDockerTagCommand(
  registry: string,
  orgScope: string,
  name: string,
  tag: string
): string {
  return `docker tag <local-image> ${buildImageCoordinate(registry, orgScope, name, tag)}`
}

export function buildDockerPushCommand(
  registry: string,
  orgScope: string,
  name: string,
  tag: string
): string {
  return `docker push ${buildImageCoordinate(registry, orgScope, name, tag)}`
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
