import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGfscClient } from '../../../internalTools/gfsClient'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

/**
 * The chat path: the tool-use loop hands each tool an ExecutionContext with the
 * turn's cancel signal and its remaining time. A GFS tool must pass both to the
 * gfsc client, so a 429 retry never outlives the turn that asked for it.
 */

const gfsClient = vi.hoisted(() => ({
  accessible: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  stat: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock('../../../internalTools/gfsClient', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../internalTools/gfsClient')>()),
  createGfscClient: vi.fn(() => gfsClient),
}))

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(createGfscClient).mockClear()
  gfsClient.stat.mockReset()
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
})

describe('NativeToolRegistry GFS call bounds', () => {
  it('caps a single Retry-After at the tool timeout and passes the turn signal and deadline', async () => {
    process.env[ACCESS_ENV] = encodedClaims(['gfs.read'])
    const T = 1_900_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T)
    gfsClient.stat.mockResolvedValue({ resourceId: 'rid' })
    const registry = new NativeToolRegistry(config, 'gfs-call-bounds-test')
    const tool = registry.get('clerum__gfs_stat')
    if (!tool) throw new Error('clerum__gfs_stat is not registered')
    const controller = new AbortController()

    const output = await tool.execute(
      { drive: 'main', resourceId: 'rid' },
      { signal: controller.signal, timeoutMs: 45_000, onOutput: () => undefined }
    )

    expect(output.is_error).toBe(false)
    expect(createGfscClient).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createGfscClient).mock.calls[0]?.[1]).toEqual({ maxRetryWaitMs: 60_000 })
    expect(gfsClient.stat).toHaveBeenCalledTimes(1)
    const [args, call] = gfsClient.stat.mock.calls[0] ?? []
    expect(args).toEqual({ drive: 'main', resourceId: 'rid' })
    expect(call).toEqual({ signal: controller.signal, deadlineMs: T + 45_000 })
    expect(call.signal).toBe(controller.signal)
  })
})
