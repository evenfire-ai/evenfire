import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { GfscWriteClient } from './gfs'

const DIRECT_KEY = 'MCP_HOST_GFS_TOKEN'
const FILE_KEY = 'MCP_HOST_GFS_TOKEN_FILE'
const AUTH_HEADER = 'authorization'
const AUTH_SCHEME = 'Bearer'

export const DEFAULT_GFS_ACCESS_FILE = '/var/run/clerum/workflow-tokens/mcp-host-gfs-token'
export const DEFAULT_GFSC_BASE_URL = 'http://gfsc.gfs.svc.cluster.local:8087'
export const DEFAULT_GFSC_WRITE_BASE_URL = 'http://gfsc-writer.gfs.svc.cluster.local:8087'

export interface GfsRuntimeEnv {
  get(key: string): string | undefined
  fileExists?(path: string): boolean
  readFile?(path: string): Promise<string>
  fetch?(input: string, init?: RequestInit): Promise<Response>
}

function envValue(env: GfsRuntimeEnv, key: string, fallback = ''): string {
  const value = env.get(key)?.trim()
  return value && value.length > 0 ? value : fallback
}

export function hasGfsRuntimeAccess(env: GfsRuntimeEnv): boolean {
  if (envValue(env, DIRECT_KEY)) return true
  const filePath = envValue(env, FILE_KEY, DEFAULT_GFS_ACCESS_FILE)
  return (env.fileExists ?? existsSync)(filePath)
}

export function createGfscClient(env: GfsRuntimeEnv): GfscWriteClient {
  const fetchFn = env.fetch ?? fetch
  const readerBase = envValue(env, 'MCP_HOST_GFSC_BASE_URL', DEFAULT_GFSC_BASE_URL).replace(
    /\/+$/,
    ''
  )
  const writerBase = envValue(
    env,
    'MCP_HOST_GFSC_WRITER_BASE_URL',
    DEFAULT_GFSC_WRITE_BASE_URL
  ).replace(/\/+$/, '')
  const readFileFn = env.readFile ?? ((path: string) => readFile(path, 'utf8'))

  async function accessValue(): Promise<string> {
    const direct = envValue(env, DIRECT_KEY)
    if (direct) return direct
    const filePath = envValue(env, FILE_KEY, DEFAULT_GFS_ACCESS_FILE)
    const value = (await readFileFn(filePath)).trim()
    if (!value) throw new Error(`${FILE_KEY} is empty`)
    return value
  }

  async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetchFn(`${baseUrl}${path}`, {
      ...init,
      headers: {
        [AUTH_HEADER]: `${AUTH_SCHEME} ${await accessValue()}`,
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`gfsc ${res.status}: ${body || res.statusText}`)
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) return res.json()
    return res.text()
  }

  return {
    accessible: ({ drive, cursor }) => {
      const q = new URLSearchParams({ drive })
      if (cursor) q.set('cursor', cursor)
      return request(readerBase, `/v1/accessible?${q}`)
    },
    list: ({ drive, resourceId, cursor }) => {
      const q = new URLSearchParams({ drive })
      if (cursor) q.set('cursor', cursor)
      return request(readerBase, `/v1/resources/${encodeURIComponent(resourceId)}/children?${q}`)
    },
    read: ({ drive, resourceId }) =>
      request(
        readerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}/content?drive=${encodeURIComponent(drive)}`
      ),
    stat: ({ drive, resourceId }) =>
      request(
        readerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}?drive=${encodeURIComponent(drive)}`
      ),
    resolve: ({ uri }) => request(readerBase, `/v1/resolve?uri=${encodeURIComponent(uri)}`),
    write: ({ drive, resourceId, content, ifMatch }) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}/content?drive=${encodeURIComponent(drive)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, ifMatch }),
        }
      ),
  }
}
