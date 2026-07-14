import { config } from './config'
import { gfsDefaultFactoryConfig } from './gfsConfig'
import type { GfsSeedClient } from './gfsReconciler'
import type { GlobalFileSystemCRD } from './types'
import { signInternalControlJwt } from './utils/internalControlSigner'

const REQUEST_TIMEOUT_MS = 10_000

/**
 * HCC → control-api seed client. After a GlobalFileSystem reaches Ready, the
 * reconciler asks control-api — the ONLY writer of gfs_resources rows (CC6) — to
 * materialize the drive's rootDirectories. The endpoint is idempotent, so a
 * retry on the next reconcile is safe. Mirrors the InternalControl-JWT auth and
 * fetch shape of mcpHostRuntimeTokenIssuerClient.
 */
export class ControlApiGfsSeedClient implements GfsSeedClient {
  async seedRootDirectories(gfs: GlobalFileSystemCRD): Promise<void> {
    const drive = gfsDefaultFactoryConfig().driveName
    const rootDirectories = gfs.spec.layout?.rootDirectories ?? []
    const url = `${config.controlApiBaseUrl}/api/v1/gfs/seed`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signInternalControlJwt()}`,
        },
        body: JSON.stringify({ drive, rootDirectories }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`gfs seed failed: HTTP ${response.status} for drive "${drive}"`)
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
