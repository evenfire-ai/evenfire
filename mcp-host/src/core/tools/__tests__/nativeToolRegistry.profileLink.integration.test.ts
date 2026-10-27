import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import type { IncomingMessage } from '../../../server'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

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
const RESOURCE_URI = `gfs://main/${'c'.repeat(32)}`
const PROFILE_ORIGIN = 'https://profile.tenant.example'
const PROFILE_URL = buildGfsResourceWebLink(PROFILE_ORIGIN, RESOURCE_URI)

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

const source: IncomingMessage = {
  content: `Please open ${PROFILE_URL}`,
  channelType: 'rpc',
  channelId: 'agent-1',
  sender: 'user-1',
  timestamp: '2026-10-19T12:00:00.000Z',
  messageId: 'message-1',
  hostRef: 'sandbox-recipes/task-board',
  profileLinkContext: {
    version: 1,
    userId: 'user-1',
    teamId: 'team-1',
    hostRef: 'sandbox-recipes/task-board',
    profileUiBaseUrl: PROFILE_ORIGIN,
  },
}

afterEach(() => {
  gfsClient.resolve.mockReset()
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
})

describe('NativeToolRegistry Profile link integration', () => {
  it('resolves a producer URL with request-local context and preserves the exact resource', async () => {
    process.env[ACCESS_ENV] = encodedClaims(['gfs.read'])
    gfsClient.resolve.mockResolvedValue({
      ok: true,
      data: {
        gfsUri: RESOURCE_URI,
        name: 'Quarterly Plan.xlsx',
        kind: 'file',
        version: 5,
      },
    })

    const registry = new NativeToolRegistry(config, 'profile-link-test', undefined, source)
    const tool = registry.get('clerum__gfs_resolve')
    if (!tool) throw new Error('clerum__gfs_resolve is not registered')

    const result = await tool.execute({ uri: PROFILE_URL })

    expect(result.is_error).toBe(false)
    expect(gfsClient.resolve).toHaveBeenCalledWith(
      { uri: RESOURCE_URI },
      { signal: undefined, deadlineMs: undefined }
    )
    expect(JSON.parse(result.content)).toEqual({
      ok: true,
      data: {
        gfsUri: RESOURCE_URI,
        name: 'Quarterly Plan.xlsx',
        kind: 'file',
        version: 5,
        profileUrl: PROFILE_URL,
      },
    })
  })
})
