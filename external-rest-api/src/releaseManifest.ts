export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.7.0',
  externalRestApiVersion: '0.1.82',
  rpcProxyVersion: '0.1.66',
  desktopVersion: '0.7.0',
  minimumDesktopVersion: '0.1.252',
}
