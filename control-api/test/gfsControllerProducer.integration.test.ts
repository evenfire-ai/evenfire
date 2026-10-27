import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import type { GfsResource } from '../../gfs-controller/src/api/read'
import { GfsServingHandler, type ServingDeps } from '../../gfs-controller/src/api/serve'
import type { GfsVerifiedClaims } from '../../gfs-controller/src/auth/verify'
import type { AuthzContext } from '../../gfs-controller/src/authz/permissionClient'
import { RateLimiter } from '../../gfs-controller/src/quota/rateLimit'
import { type GfscReadClient, buildGfsReadTools } from '../../mcp-host/src/internalTools/gfs'
import { createGfscClient } from '../../mcp-host/src/internalTools/gfsClient'

const RESOURCE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const RESOURCE_RID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const RESOURCE_URI = `gfs://main/${RESOURCE_RID}`
const PROFILE_ORIGIN = 'https://profile.tenant.example'
const PROFILE_URL = buildGfsResourceWebLink(PROFILE_ORIGIN, RESOURCE_URI)
const RESOURCE_NAME = 'Quarterly Plan.xlsx'

const claims: GfsVerifiedClaims = {
  sub: 'user:user-1',
  drive: 'main',
  scopes: ['gfs.read'],
  pathBindings: [],
  iat: 0,
  exp: 0,
}

const context: AuthzContext = {
  drive: 'main',
  subjects: ['user:user-1'],
  isOperator: false,
  primarySubject: 'user:user-1',
}

const resource: GfsResource = {
  resourceId: RESOURCE_ID,
  drive: 'main',
  parentResourceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: RESOURCE_NAME,
  kind: 'file',
  pathCache: '/Finance/Quarterly Plan.xlsx',
  version: 5,
  bytes: 2048,
  blobKey: null,
  contentSha256: null,
  deletedAt: null,
  updatedAt: '2026-10-19T12:00:00.000Z',
}

function makeProducerDeps(authorize: ServingDeps['authorize']): ServingDeps {
  return {
    verifyToken: token => {
      expect(token).toBe('producer-token')
      return claims
    },
    resolveContext: async () => context,
    authorize,
    store: {
      getResource: async (drive, resourceId) =>
        drive === 'main' && resourceId === RESOURCE_RID ? resource : null,
      listChildren: async () => [],
    },
    blobs: {
      read: async () => {
        throw new Error('not used by resolve')
      },
    },
    rateLimit: {
      reads: new RateLimiter({ limit: 100, windowMs: 60_000 }),
      writes: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    },
  }
}

function producerFetch(handler: GfsServingHandler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const req = {
      url: `${url.pathname}${url.search}`,
      method: init?.method ?? 'GET',
      headers,
    } as unknown as IncomingMessage
    const captured: { status: number; body: string } = { status: 0, body: '' }
    const res = {
      writeHead(status: number) {
        captured.status = status
        return res
      },
      setHeader() {
        return res
      },
      end(body?: string | Uint8Array) {
        if (body !== undefined) captured.body += Buffer.from(body).toString('utf8')
        return res
      },
    } as unknown as ServerResponse

    const handled = await handler.tryHandle(req, res)
    if (!handled) throw new Error(`GFS producer did not handle ${url.pathname}`)
    return new Response(captured.body, {
      status: captured.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

describe('mcp-host consumes the GFS Controller resolve producer contract', () => {
  it('adds a Profile URL only after the real resolver endpoint authorizes and returns the resource', async () => {
    let permissionGranted = true
    const authorize = vi.fn(async () => ({ allowed: permissionGranted }))
    const handler = new GfsServingHandler(makeProducerDeps(authorize))
    const fetch = producerFetch(handler)
    const client = createGfscClient(
      {
        get: key => {
          if (key === 'MCP_HOST_GFS_TOKEN') return 'producer-token'
          if (key === 'MCP_HOST_GFSC_BASE_URL') return 'http://gfsc.producer.test'
          return undefined
        },
        fetch,
      },
      { maxRetryWaitMs: 0 }
    ) as unknown as GfscReadClient
    const tool = new Map(
      buildGfsReadTools(client, {
        referencedFiles: new Map(),
        profileLinkContext: {
          version: 1,
          userId: 'user-1',
          teamId: 'team-1',
          hostRef: 'chatllm',
          profileUiBaseUrl: PROFILE_ORIGIN,
        },
      }).map(entry => [entry.name, entry])
    ).get('clerum__gfs_resolve')!

    const allowed = await tool.execute({ uri: PROFILE_URL }, '')

    expect(allowed.success).toBe(true)
    expect(JSON.parse(allowed.content ?? '')).toMatchObject({
      ok: true,
      data: {
        gfsUri: RESOURCE_URI,
        name: RESOURCE_NAME,
        kind: 'file',
        path: '/Finance/Quarterly Plan.xlsx',
        profileUrl: PROFILE_URL,
      },
    })
    expect(authorize).toHaveBeenCalledWith(context, RESOURCE_RID, 'read')

    permissionGranted = false
    const denied = await tool.execute({ uri: PROFILE_URL }, '')

    expect(denied.success).toBe(false)
    expect(denied.error).toBe('GFS read failed (gfsc 403: forbidden)')
    expect(denied.error).not.toContain(PROFILE_URL)
    expect(JSON.stringify(denied)).not.toContain('profileUrl')
    expect(authorize).toHaveBeenCalledTimes(2)
  })
})
