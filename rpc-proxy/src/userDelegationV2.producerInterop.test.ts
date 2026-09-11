import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { AuthedRequest } from './middleware/auth.js'
import { bindRouteActionV2 } from './routeActionBindingV2.js'
import { verifyUserDelegationV2 } from './userDelegationV2.js'

const repositoryRoot = resolve(process.cwd(), '..')
const tsx = resolve(repositoryRoot, 'rpc-proxy', 'node_modules', '.bin', 'tsx')
const producer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitUserDelegationV2Fixture.ts'
)
const derivedViewProducer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitDerivedViewDelegationV2Fixture.ts'
)
const sandboxOAuthProducer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitSandboxOAuthDelegationV2Fixture.ts'
)
const runtimeSessionProducer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitRuntimeSessionDelegationV2Fixture.ts'
)

const runtimeRoutes = [
  [
    'session.read',
    {
      route: { path: '/rpc/hosts/:hostRef/sessions/search' },
      method: 'GET',
      params: { hostRef: 'chatllm' },
      query: {},
      body: undefined,
    },
  ],
  [
    'task.read',
    {
      route: { path: '/rpc/hosts/:hostRef/tasks/:taskId/result' },
      method: 'GET',
      params: { hostRef: 'chatllm', taskId: 'task-a' },
      query: {},
      body: undefined,
    },
  ],
  [
    'task.manage',
    {
      route: { path: '/rpc/hosts/:hostRef/tasks/:taskId/cancel' },
      method: 'POST',
      params: { hostRef: 'chatllm', taskId: 'task-a' },
      query: {},
      body: undefined,
    },
  ],
  [
    'model.read',
    {
      route: { path: '/rpc/hosts/:hostRef/models' },
      method: 'GET',
      params: { hostRef: 'chatllm' },
      query: { agent: 'agent-a', chatId: 'chat-a' },
      body: undefined,
    },
  ],
  [
    'model.select',
    {
      route: { path: '/rpc/hosts/:hostRef/model' },
      method: 'POST',
      params: { hostRef: 'chatllm' },
      query: {},
      body: {
        agent: 'agent-a',
        chatId: 'chat-a',
        provider: 'openai',
        model: 'model-a',
      },
    },
  ],
] as const

describe('Control API delegation producer to rpc-proxy verifier interoperability', () => {
  it('consumes a token emitted at test time by the real Control producer', () => {
    const output = execFileSync(tsx, [producer], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
    const fixture = JSON.parse(output) as { token: string }

    expect(verifyUserDelegationV2(fixture.token)).toMatchObject({
      typ: 'user_delegation',
      ver: 2,
      operationIds: ['host.wake'],
      scopes: ['action:host.wake'],
      accessPathId: `ap1_${'a'.repeat(43)}`,
      authorizationRevision: `ar1_${'b'.repeat(43)}`,
      behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    })
  })

  it.each(['sandbox.open', 'sandbox.reconnect', 'remote_desktop.open', 'remote_desktop.reconnect'])(
    'consumes a real exact derived-view delegation for %s',
    operationId => {
      const output = execFileSync(tsx, [derivedViewProducer, operationId], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env,
      })
      const fixture = JSON.parse(output) as { token: string; operationId: string }

      expect(verifyUserDelegationV2(fixture.token)).toMatchObject({
        typ: 'user_delegation',
        ver: 2,
        operationIds: [operationId],
        scopes: [`action:${operationId}`],
      })
    }
  )

  it.each(['sandbox.oauth.vend', 'sandbox.oauth.disconnect'])(
    'consumes a real exact recipe-client delegation for %s',
    operationId => {
      const output = execFileSync(tsx, [sandboxOAuthProducer, operationId], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env,
      })
      const fixture = JSON.parse(output) as { token: string; operationId: string }

      expect(verifyUserDelegationV2(fixture.token)).toMatchObject({
        typ: 'user_delegation',
        ver: 2,
        operationIds: [operationId],
        scopes: [`action:${operationId}`],
        targets: {
          [operationId]: {
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'r1',
            oauthClientId: 'google-calendar',
          },
        },
      })
    }
  )

  it.each(runtimeRoutes)(
    'binds a real runtime-session producer delegation for %s',
    (operationId, request) => {
      const output = execFileSync(tsx, [runtimeSessionProducer, operationId], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env,
      })
      const fixture = JSON.parse(output) as { token: string }
      const claims = verifyUserDelegationV2(fixture.token)

      expect(claims).not.toBeNull()
      expect(bindRouteActionV2(request as unknown as AuthedRequest, claims!)).toMatchObject({
        operationId,
        target: { hostRef: 'mcp-host/chatllm' },
      })
    }
  )
})
