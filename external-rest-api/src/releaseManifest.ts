export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.9.0',
  externalRestApiVersion: '0.1.84',
  rpcProxyVersion: '0.1.84',
  desktopVersion: '0.9.0',
  minimumDesktopVersion: '0.1.252',
}
