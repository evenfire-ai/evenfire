import { config } from './config.js'
import { ApiError, requestJson } from './httpClient.js'

export type ContextSharedFilesystemSummary = {
  name: string
  mountPath: string
  phase: string | null
  pvcName: string | null
  message: string | null
}

export type SharedFileEntry = {
  name: string
  kind: 'file' | 'directory' | 'other'
  size: number
  mtime: string
}

export type SharedFileListResult = {
  path: string
  entries: SharedFileEntry[]
  truncated: boolean
}

type WfcEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

function url(path: string): string {
  return `${config.externalRestApiBaseUrl.replace(/\/+$/, '')}${path}`
}

function unwrap<T>(payload: WfcEnvelope<T>): T {
  if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
    throw new Error('Unexpected response from workspace-files-controller')
  }
  if (!payload.ok) {
    throw new ApiError(
      `${payload.error.code}: ${payload.error.message}`,
      400,
      JSON.stringify(payload)
    )
  }
  return payload.data
}

export class SharedFilesClient {
  async listAttached(
    sessionToken: string,
    contextId: string
  ): Promise<{ items: ContextSharedFilesystemSummary[] }> {
    return requestJson<{ items: ContextSharedFilesystemSummary[] }>(
      'GET',
      url(`/api/v1/me/contexts/${encodeURIComponent(contextId)}/shared-filesystems`),
      { token: sessionToken }
    )
  }

  async listDirectory(
    sessionToken: string,
    contextId: string,
    sfsName: string,
    relPath: string
  ): Promise<SharedFileListResult> {
    const qs = `?path=${encodeURIComponent(relPath || '/')}`
    const envelope = await requestJson<WfcEnvelope<SharedFileListResult>>(
      'GET',
      url(
        `/api/v1/me/contexts/${encodeURIComponent(contextId)}/shared-filesystems/` +
          `${encodeURIComponent(sfsName)}/proxy/v1/files${qs}`
      ),
      { token: sessionToken }
    )
    return unwrap(envelope)
  }

  /**
   * Download a single file. Returns the body as a Buffer so the IPC handler
   * can route the bytes into a user-selected save path.
   */
  async downloadFile(
    sessionToken: string,
    contextId: string,
    sfsName: string,
    relPath: string
  ): Promise<{ bytes: Buffer; filename: string; contentType: string | null }> {
    const target =
      url(
        `/api/v1/me/contexts/${encodeURIComponent(contextId)}/shared-filesystems/` +
          `${encodeURIComponent(sfsName)}/proxy/v1/files/download`
      ) + `?path=${encodeURIComponent(relPath)}`
    const response = await fetch(target, {
      method: 'GET',
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(
        `${response.status} ${response.statusText}: ${body}`,
        response.status,
        body
      )
    }
    const buf = Buffer.from(await response.arrayBuffer())
    const cd = response.headers.get('content-disposition') || ''
    const match = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)
    const fallback = relPath.split('/').filter(Boolean).pop() || 'download'
    return {
      bytes: buf,
      filename: match?.[1]?.trim() || fallback,
      contentType: response.headers.get('content-type'),
    }
  }
}
