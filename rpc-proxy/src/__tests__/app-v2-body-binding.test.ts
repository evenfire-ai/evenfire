import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import request from 'supertest'
import type { ActionOperationId } from '@clerum/action-context-contracts'
import { ActionAuthorityCheckpointError } from '../actionAuthorityV2.js'
import { createApp } from '../app.js'

const authority = vi.hoisted(() => ({ authorizeActionV2: vi.fn() }))
vi.mock('../actionAuthorityV2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../actionAuthorityV2.js')>()),
  authorizeActionV2: authority.authorizeActionV2,
}))

type ProducerInput = {
  operationId: ActionOperationId
  resourceType: 'host' | 'mcp_server' | 'runtime_session' | 'sandbox_app'
  resourceId: string
  target: Record<string, string>
}

type Case = ProducerInput & {
  name: string
  method: 'post' | 'delete'
  path: string
  body: Record<string, unknown>
}

const repositoryRoot = resolve(process.cwd(), '..')
const tsx = resolve(repositoryRoot, 'rpc-proxy', 'node_modules', '.bin', 'tsx')
const producer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitBodyBoundRouteDelegationV2Fixture.ts'
)

const cases: Case[] = [
  {
    name: 'MCP invoke',
    method: 'post',
    path: '/api/v1/rpc/weather',
    operationId: 'mcp.invoke',
    resourceType: 'mcp_server',
    resourceId: 'mcp-server/weather',
    target: { serverNamespace: 'mcp-server', serverName: 'weather', toolName: 'forecast' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast' } },
  },
  {
    name: 'host message',
    method: 'post',
    path: '/api/v1/rpc/hosts/chatllm/messages',
    operationId: 'chat.message.invoke',
    resourceType: 'host',
    resourceId: 'mcp-host/chatllm',
    target: { hostRef: 'mcp-host/chatllm', channelType: 'rpc', channelId: 'chatllm' },
    body: { content: 'hello' },
  },
  {
    name: 'host wake',
    method: 'post',
    path: '/api/v1/rpc/hosts/chatllm/wake',
    operationId: 'host.wake',
    resourceType: 'host',
    resourceId: 'mcp-host/chatllm',
    target: { hostRef: 'mcp-host/chatllm', wakeReason: 'explicit' },
    body: { wakeReason: 'explicit' },
  },
  ...(['approve', 'deny'] as const).map(action => ({
    name: `approval ${action}`,
    method: 'post' as const,
    path: `/api/v1/rpc/hosts/chatllm/approvals/${action}`,
    operationId: 'task.manage' as const,
    resourceType: 'runtime_session' as const,
    resourceId: 'session-a',
    target: {
      hostRef: 'mcp-host/chatllm',
      taskId: '60000000-0000-4000-8000-000000000006',
      action,
      approvalRequestId: '70000000-0000-4000-8000-000000000007',
    },
    body: {
      taskId: '60000000-0000-4000-8000-000000000006',
      toolCallId: '70000000-0000-4000-8000-000000000007',
    },
  })),
  {
    name: 'model select',
    method: 'post',
    path: '/api/v1/rpc/hosts/chatllm/model',
    operationId: 'model.select',
    resourceType: 'runtime_session',
    resourceId: 'session-a',
    target: {
      hostRef: 'mcp-host/chatllm',
      agent: 'agent-a',
      chatId: 'chat-a',
      provider: 'openai',
      model: 'model-a',
    },
    body: { agent: 'agent-a', chatId: 'chat-a', provider: 'openai', model: 'model-a' },
  },
  ...(
    [
      ['post', 'authorize-url', 'sandbox.oauth.vend'],
      ['post', 'token', 'sandbox.oauth.vend'],
      ['delete', 'grant', 'sandbox.oauth.disconnect'],
    ] as const
  ).map(([method, suffix, operationId]) => ({
    name: `Sandbox OAuth ${suffix}`,
    method,
    path: `/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/${suffix}`,
    operationId,
    resourceType: 'sandbox_app' as const,
    resourceId: 'sandbox-recipes/r1',
    target: {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      oauthClientId: 'google-calendar',
    },
    body: { oauthClientId: 'google-calendar' },
  })),
]

const produced = new Map<string, { token: string; messageId: string | null }>()

beforeAll(() => {
  for (const testCase of cases) {
    const output = execFileSync(
      tsx,
      [
        producer,
        JSON.stringify({
          operationId: testCase.operationId,
          resourceType: testCase.resourceType,
          resourceId: testCase.resourceId,
          target: testCase.target,
        }),
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
    )
    produced.set(testCase.name, JSON.parse(output))
  }
})

beforeEach(() => {
  authority.authorizeActionV2.mockReset()
  authority.authorizeActionV2.mockRejectedValue(
    new ActionAuthorityCheckpointError(403, 'forbidden')
  )
})

describe('createApp v2 body-derived route binding', () => {
  it.each(cases)(
    'parses $name after identity authentication and before authority binding',
    async testCase => {
      const fixture = produced.get(testCase.name)
      if (!fixture) throw new Error(`missing producer fixture for ${testCase.name}`)
      const body = {
        ...testCase.body,
        ...(fixture.messageId ? { messageId: fixture.messageId } : {}),
      }
      const client = request(createApp())
      const response = await client[testCase.method](testCase.path)
        .set('authorization', `Bearer ${fixture.token}`)
        .send(body)

      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: 'forbidden' })
      expect(authority.authorizeActionV2).toHaveBeenCalledTimes(1)
      expect(authority.authorizeActionV2.mock.calls[0]?.[1]).toMatchObject({
        operationId: testCase.operationId,
        target: expect.objectContaining(testCase.target),
      })
    }
  )
})
