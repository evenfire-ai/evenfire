export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.8.1',
  externalRestApiVersion: '0.1.82',
  rpcProxyVersion: '0.1.78',
  desktopVersion: '0.8.1',
  minimumDesktopVersion: '0.1.252',
}
