/**
 * evenfire pull-secret attach classification.
 *
 * Decides whether an installed local-mode McpServer image should carry the
 * `evenfire-registry-pull` imagePullSecret — i.e. when the image lives on the configured
 * evenfire registry host. The Secret itself is self-provisioned by control-api in
 * self-hosted mode (`registryPullSecretService`) and may also be pre-provisioned by an
 * external operator; this file only decides when to reference it by name.
 *
 * The identity primitives now live in `@clerum/workflow-runtime-core`, because WRC asks
 * the same question of recipe workloads and a second copy would drift. They are
 * re-exported here so existing imports keep working against one definition.
 */
import { isPlatformRegistryImage } from '@clerum/workflow-runtime-core'

export {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  imageRefHost,
  isPlatformRegistryImage,
  registryHostFromUrl,
} from '@clerum/workflow-runtime-core'

/**
 * True when a built McpServer spec should carry the evenfire pull secret:
 * a local-mode entry whose image host equals the configured registry host.
 *
 * Remote-mode entries run a fixed egress-proxy image, never a registry-hosted one, so the
 * `isLocal` term is what keeps this narrower than the shared predicate.
 */
export function shouldAttachEvenfirePullSecret(params: {
  isLocal: boolean
  image: unknown
  registryUrl: string
}): boolean {
  if (!params.isLocal) return false
  return isPlatformRegistryImage(params.image, params.registryUrl)
}
