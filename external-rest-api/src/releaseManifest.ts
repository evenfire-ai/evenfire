export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'master-440d8e0',
  externalRestApiVersion: '0.1.56',
  rpcProxyVersion: '0.1.36',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
