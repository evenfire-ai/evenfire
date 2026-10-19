import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Request, Response } from 'express'
import request from 'supertest'
import { config as mcpHostConfig } from '../../mcp-host/src/config'
import { runtimeEdgeGuard } from '../../mcp-host/src/server/edgeRuntimeAuth'
import { handleMessageRoute } from '../../mcp-host/src/server/routes'
import type { RouteHandlers } from '../../mcp-host/src/server/routes'
import { resolveHostConnectionForUser } from '../../rpc-proxy/src/services/mcpProxyService.js'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { issueRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import { MRS_PROFILE_LOOKUP_RESPONSE_V1 } from './fixtures/mrsProfileLookupResponseV1.js'

const profileLookup = vi.hoisted(() => ({
  getMe: vi.fn(),
  request: vi.fn(),
}))
const proxyConfig = vi.hoisted(() => ({
  controlApiBaseUrl: 'http://control-api.test',
  controlApiServiceToken: 'service-token',
  controlApiServiceName: 'rpc-proxy',
  upstreamTimeoutMs: 1000,
  controlApiCacheTtlMs: 1000,
}))

vi.mock('../src/services/directory/membership.js', () => ({ getMe: profileLookup.getMe }))
vi.mock('../src/memberRegistrationServiceClient.js', () => ({
  memberRegistrationServiceRequest: profileLookup.request,
}))
vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return {
    ...actual,
    config: { ...actual.config, desktopProfileUiBaseUrl: 'https://profile.tenant.example' },
  }
})
vi.mock('../../rpc-proxy/src/config.js', () => ({ config: proxyConfig }))

const USER_ID = '00000000-0000-4000-8000-000000000001'
const TEAM_ID = '00000000-0000-4000-8000-000000000002'
const HOST_REF = mcpHostConfig.hostName
const USER_EMAIL = 'person@example.com'
const ACTIVATION_ORIGIN = 'https://profile.tenant.example'
const RAW_CONTENT = `Open ${ACTIVATION_ORIGIN}/open/apps/core/calendar?team=${TEAM_ID}`
const DIRECT_RUN_BINDING = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'profile-link-session',
  origin: 'direct_chat',
} as const

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function makeResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  }
  return res as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  profileLookup.getMe.mockReset()
  profileLookup.request.mockReset()
})

describe('Control API → rpc-proxy → mcp-host Profile context bridge', () => {
  it('forwards the first direct-chat message with context after delayed authorization and lookup', async () => {
    profileLookup.getMe.mockImplementation(async () => {
      await wait(400)
      return { id: USER_ID, email: USER_EMAIL }
    })
    profileLookup.request.mockImplementation(async () => {
      await wait(400)
      return MRS_PROFILE_LOOKUP_RESPONSE_V1
    })

    const gateway = {
      listResource: vi.fn(async () => {
        await wait(400)
        return [{ metadata: { name: HOST_REF }, spec: { enabled: true } }]
      }),
    }
    const directory = {
      getUserAgents: vi.fn(async () => {
        await wait(400)
        return { userId: USER_ID, agentNames: [HOST_REF] }
      }),
      getCurrentTeam: vi.fn(),
      getTeamAgents: vi.fn(),
    }
    const bindingService = {
      bind: vi.fn(async () => {
        await wait(400)
        return 'recorded'
      }),
    }
    const app = express()
    app.use(
      createRpcAccessUsersRouter(gateway as unknown as K8sGateway, {
        bindingService,
        directory: directory as never,
        bindingBudgetMs: 500,
        profileLinkAuthorizationBudgetMs: 1000,
        profileLinkContextBudgetMs: 1000,
      })
    )

    const issued = issueRpcAccessToken(
      { userId: USER_ID, teamId: TEAM_ID, role: 'member' },
      ['host:message:invoke'],
      [HOST_REF]
    )
    if (!issued) throw new Error('expected a signed Host access token')

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const proxyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const producerResponse = await request(app)
        .post(`/rpc/access/users/${USER_ID}/mcp-hosts/${HOST_REF}?profileLinkContext=1`)
        .set('x-rpc-access-token', issued.token)
        .send(DIRECT_RUN_BINDING)
        .expect(200)
      expect(init?.signal?.aborted).toBe(false)
      return new Response(JSON.stringify(producerResponse.body), {
        status: producerResponse.status,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', proxyFetch)

    const connection = await resolveHostConnectionForUser(USER_ID, HOST_REF, issued.token, {
      teamId: TEAM_ID,
      includeProfileLinkContext: true,
      directRunBinding: DIRECT_RUN_BINDING,
    })
    if ('denied' in connection) throw new Error('expected authorized Host connection')

    const edgeRequest = {
      headers: connection.headers,
      body: {
        content: RAW_CONTENT,
        channelType: 'rpc',
        channelId: 'agent-1',
        sender: 'untrusted-body-user',
        timestamp: '2026-10-19T12:00:00.000Z',
        messageId: 'message-1',
        hostRef: HOST_REF,
        profileLinkContext: {
          version: 1,
          userId: 'untrusted-body-user',
          teamId: 'other-team',
          hostRef: HOST_REF,
          profileUiBaseUrl: 'https://attacker.example',
        },
      },
      query: {},
    } as unknown as Request
    const response = makeResponse()
    const next = vi.fn()
    runtimeEdgeGuard(['rpc-proxy'])(edgeRequest, response, next)
    expect(next).toHaveBeenCalledOnce()

    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    await handleMessageRoute(edgeRequest, response, {
      messageHandler,
    } as unknown as RouteHandlers)

    expect(directory.getUserAgents).toHaveBeenCalledWith(USER_ID)
    expect(bindingService.bind).toHaveBeenCalledOnce()
    expect(timeoutSpy).toHaveBeenCalledWith(40_000)
    expect(profileLookup.getMe).toHaveBeenCalledWith(USER_ID, TEAM_ID)
    expect(profileLookup.request).toHaveBeenCalledWith('POST', '/invitations-flow/profile', {
      destinationBaseUrl: ACTIVATION_ORIGIN,
      body: { email: USER_EMAIL, domain: 'profile.tenant.example' },
      timeoutMs: 1000,
    })
    expect(proxyFetch).toHaveBeenCalledOnce()
    expect(connection.profileLinkContext).toEqual({
      version: 1,
      userId: USER_ID,
      teamId: TEAM_ID,
      hostRef: HOST_REF,
      profileUiBaseUrl: ACTIVATION_ORIGIN,
    })
    expect(messageHandler).toHaveBeenCalledOnce()
    expect(messageHandler.mock.calls[0][0]).toMatchObject({
      content: RAW_CONTENT,
      sender: USER_ID,
      metadata: { teamId: TEAM_ID },
      profileLinkContext: connection.profileLinkContext,
    })
    timeoutSpy.mockRestore()
  })
})
