import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  CapabilityInputError,
  CapabilityTooLargeError,
  PLUGIN_GFS_IMAGE_MAX_BYTES,
  type PluginSdkDataSource,
  type ProviderContext,
  detectImageMime,
  getCapability,
  sortCapabilitiesForPrompt,
} from '../pluginSdkCapabilities.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

function source(overrides: Partial<PluginSdkDataSource> = {}): PluginSdkDataSource {
  return {
    getSessionState: async () => ({
      authenticated: true,
      me: {
        id: 'u1',
        email: 'a@example.com',
        name: 'A',
        picture: 'https://cdn.example/a.png',
        teamId: 't1',
        teamName: 'Acme',
        role: 'member',
      },
    }),
    listMyAgents: async () => [
      {
        name: 'scout',
        contextRef: 'context1',
        provider: 'claude',
        mcpServers: [{ name: 'search' }],
        gfsSubject: { type: 'host', id: '1st:ns/scout' },
      },
    ],
    getAccessCatalog: async () =>
      ({
        userContextIds: ['ctx-user'],
        teamContextIds: ['ctx-team', 'ctx-user'],
        mcpServersByAgent: { scout: ['search'] },
      }) as never,
    listAccessibleMcpServers: async () =>
      ({ servers: [{ name: 'search', url: 'http://internal:3000' }] }) as never,
    listAccessibleGfsResources: async () =>
      ({
        items: [
          {
            resourceId: 'r1',
            rid: 'r1',
            gfsUri: 'gfs://main/a.png',
            drive: 'main',
            parentResourceId: null,
            name: 'a.png',
            kind: 'file',
            path: '/a.png',
            version: 3,
            bytes: 10,
            sources: ['grant'],
            permissions: ['read'],
            coversDescendants: false,
          },
        ],
        nextCursor: null,
      }) as never,
    listGfsChildren: async () => ({ items: [], nextCursor: null }),
    downloadGfsUri: async () => ({
      resource: { gfsUri: 'gfs://main/a.png', name: 'a.png' } as never,
      bytes: PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) as ArrayBuffer,
    }),
    getPluginTheme: () => 'light',
    showPluginNotification: async () => ({ delivered: true }),
    ...overrides,
  }
}

function ctx(overrides: Partial<PluginSdkDataSource> = {}): ProviderContext {
  return {
    source: source(overrides),
    pluginId: 'ns/plugin',
    pluginTitle: 'Plugin',
    userId: 'u1',
  }
}

async function run(id: string, params: unknown = undefined, overrides = {}) {
  const descriptor = getCapability(id)
  if (!descriptor) throw new Error(`missing ${id}`)
  return descriptor.run(ctx(overrides), descriptor.validate(params))
}

describe('capability catalog invariants', () => {
  it('gives every capability consent copy and limits', () => {
    for (const [id, descriptor] of Object.entries(CAPABILITIES)) {
      expect(descriptor.id, id).toBe(id)
      expect(descriptor.consent.title.length, id).toBeGreaterThan(0)
      expect(descriptor.consent.dataDescription.length, id).toBeGreaterThan(0)
      expect(descriptor.limits.perMinute, id).toBeGreaterThan(0)
      expect(descriptor.limits.maxResponseBytes, id).toBeGreaterThan(0)
    }
  })

  it('marks only theme.read as consent-free', () => {
    const unscoped = Object.values(CAPABILITIES)
      .filter(descriptor => !descriptor.requiresConsent)
      .map(descriptor => descriptor.id)
    // Any addition here is a decision to hand a plugin something without asking.
    expect(unscoped).toEqual(['theme.read'])
  })

  it('sorts prompt rows most-sensitive-first', () => {
    expect(sortCapabilitiesForPrompt(['theme.read', 'agents.read', 'identity.read'])).toEqual([
      'identity.read',
      'agents.read',
      'theme.read',
    ])
  })
})

describe('minimize contracts', () => {
  it('identity.read returns exactly three fields and drops the avatar URL', async () => {
    const result = await run('identity.read')
    expect(Object.keys(result as object).sort()).toEqual(['email', 'name', 'userId'])
  })

  it('org.read returns exactly the team triple', async () => {
    const result = await run('org.read')
    expect(Object.keys(result as object).sort()).toEqual(['role', 'teamId', 'teamName'])
  })

  it('agents.read flattens MCP servers to names and exposes a stable id', async () => {
    const result = (await run('agents.read')) as { agents: Array<Record<string, unknown>> }
    expect(result.agents[0]).toEqual({
      id: '1st:ns/scout',
      name: 'scout',
      contextRef: 'context1',
      provider: 'claude',
      mcpServers: ['search'],
    })
  })

  it('mcp.read never leaks a server URL', async () => {
    const result = (await run('mcp.read')) as { servers: Array<Record<string, unknown>> }
    expect(result.servers[0]).toEqual({ name: 'search', agents: ['scout'] })
    expect(JSON.stringify(result)).not.toContain('internal')
  })

  it('contexts.read labels a context present in both lists as the user’s', async () => {
    const result = (await run('contexts.read')) as {
      contexts: Array<{ id: string; scope: string }>
    }
    expect(result.contexts).toEqual([
      { id: 'ctx-user', scope: 'user' },
      { id: 'ctx-team', scope: 'team' },
    ])
  })

  it('gfs.list returns metadata only', async () => {
    const result = (await run('gfs.list', {})) as { items: Array<Record<string, unknown>> }
    expect(Object.keys(result.items[0] ?? {}).sort()).toEqual([
      'bytes',
      'gfsUri',
      'kind',
      'name',
      'resourceId',
      'version',
    ])
  })
})

describe('gfs.read', () => {
  it('returns a data: URI, because the embed CSP allows data: and not blob:', async () => {
    const result = (await run('gfs.read', { uri: 'gfs://main/a.png', as: 'dataUrl' })) as {
      dataUrl: string
      mimeType: string
    }
    expect(result.mimeType).toBe('image/png')
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('refuses a file whose bytes are not the image it claims to be', async () => {
    const notAnImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await expect(
      run(
        'gfs.read',
        { uri: 'gfs://main/a.png', as: 'dataUrl' },
        {
          downloadGfsUri: async () => ({
            resource: { gfsUri: 'gfs://main/a.png', name: 'a.png' } as never,
            bytes: notAnImage.buffer.slice(
              notAnImage.byteOffset,
              notAnImage.byteOffset + notAnImage.byteLength
            ) as ArrayBuffer,
          }),
        }
      )
    ).rejects.toBeInstanceOf(CapabilityInputError)
  })

  it('refuses an image over the size ceiling', async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(PLUGIN_GFS_IMAGE_MAX_BYTES)])
    await expect(
      run(
        'gfs.read',
        { uri: 'gfs://main/a.png', as: 'dataUrl' },
        {
          downloadGfsUri: async () => ({
            resource: { gfsUri: 'gfs://main/a.png', name: 'a.png' } as never,
            bytes: huge.buffer.slice(
              huge.byteOffset,
              huge.byteOffset + huge.byteLength
            ) as ArrayBuffer,
          }),
        }
      )
    ).rejects.toBeInstanceOf(CapabilityTooLargeError)
  })

  it('rejects a non-gfs uri and an unknown mode at validation time', () => {
    const descriptor = getCapability('gfs.read')
    expect(() => descriptor?.validate({ uri: 'https://evil.example/x', as: 'dataUrl' })).toThrow()
    expect(() => descriptor?.validate({ uri: 'gfs://main/a', as: 'binary' })).toThrow()
    expect(() => descriptor?.validate({ uri: 'gfs://main/a', as: 'text', extra: 1 })).toThrow()
  })

  it('refuses bytes that are not valid UTF-8 in text mode', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0xfd])
    await expect(
      run(
        'gfs.read',
        { uri: 'gfs://main/a.bin', as: 'text' },
        {
          downloadGfsUri: async () => ({
            resource: { gfsUri: 'gfs://main/a.bin', name: 'a.bin' } as never,
            bytes: binary.buffer.slice(
              binary.byteOffset,
              binary.byteOffset + binary.byteLength
            ) as ArrayBuffer,
          }),
        }
      )
    ).rejects.toBeInstanceOf(CapabilityInputError)
  })
})

describe('detectImageMime', () => {
  it('identifies renderable formats by magic bytes', () => {
    expect(detectImageMime(PNG)).toBe('image/png')
    expect(detectImageMime(JPEG)).toBe('image/jpeg')
  })

  it('does not identify SVG, which is deliberately unsupported', () => {
    expect(detectImageMime(Buffer.from('<svg></svg>'))).toBeNull()
  })

  it('survives a file shorter than any magic prefix', () => {
    expect(detectImageMime(Buffer.from([0x01]))).toBeNull()
  })
})

describe('notifications.notify', () => {
  it('strips control characters and enforces length caps', () => {
    const descriptor = getCapability('notifications.notify')
    const params = descriptor?.validate({ title: 'New\u0000 lead\u001b', body: 'x' })
    expect(params?.title).toBe('New  lead')
    expect(() => descriptor?.validate({ title: 'x'.repeat(121) })).toThrow()
    expect(() => descriptor?.validate({ title: 'ok', body: 'x'.repeat(401) })).toThrow()
    expect(() => descriptor?.validate({ body: 'no title' })).toThrow()
  })

  it('passes the host-owned plugin title through for attribution', async () => {
    let seen: { pluginTitle?: string } = {}
    await run(
      'notifications.notify',
      { title: 'Hello' },
      {
        showPluginNotification: async (input: { pluginTitle?: string }) => {
          seen = input
          return { delivered: true }
        },
      }
    )
    expect(seen.pluginTitle).toBe('Plugin')
  })
})
