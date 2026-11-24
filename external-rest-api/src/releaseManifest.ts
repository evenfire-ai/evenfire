export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.12.1',
  externalRestApiVersion: '0.1.200',
  rpcProxyVersion: '0.1.168',
  desktopVersion: '0.12.1',
  minimumDesktopVersion: '0.1.252',
}
