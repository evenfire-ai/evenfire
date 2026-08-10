export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.6.0',
  externalRestApiVersion: '0.1.63',
  rpcProxyVersion: '0.1.64',
  desktopVersion: '0.6.0',
  minimumDesktopVersion: '0.1.252',
}
