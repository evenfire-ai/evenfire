import type { ReleaseManifest } from './releaseManifest.js'

export function buildDesktopReleasePolicy(
  manifest: ReleaseManifest,
  configuredReleaseBaseUrl: string
) {
  const tag = `v${manifest.desktopVersion}`
  const encodedTag = encodeURIComponent(tag)
  const releaseBaseUrl = configuredReleaseBaseUrl.replace(/\/+$/, '')

  return {
    releaseId: manifest.releaseId,
    externalRestApiVersion: manifest.externalRestApiVersion,
    rpcProxyVersion: manifest.rpcProxyVersion,
    desktopVersion: manifest.desktopVersion,
    compatibleDesktopVersions: manifest.compatibleDesktopVersions,
    minimumDesktopVersion: manifest.minimumDesktopVersion,
    releaseTag: tag,
    releaseUrl: `${releaseBaseUrl}/tag/${encodedTag}`,
  }
}
