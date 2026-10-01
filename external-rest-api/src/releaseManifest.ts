export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.10.0',
  externalRestApiVersion: '0.1.93',
  rpcProxyVersion: '0.1.112',
  desktopVersion: '0.10.0',
  minimumDesktopVersion: '0.1.252',
}
