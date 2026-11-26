import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { installControlApiJwtTestKeys } from '../../../scripts/testing/controlApiJwtTestKeys.js'
import type { K8sGateway } from '../../src/k8s.js'
import type { RpcHostAccessDirectory } from '../../src/services/access/rpcHostAccessAuthorizer.js'

type FixtureInput = Readonly<{ userId: string; hostRef: string }>

type GateCase =
  | 'gate_bearer_missing'
  | 'gate_service_name_missing'
  | 'gate_token_wrong'
  | 'gate_other_service'
  | 'caller_token_missing'
  | 'caller_token_unverifiable'
  | 'both_bad'
  | 'authorized'

type EmittedAnswer = {
  case: GateCase
  method: 'GET' | 'POST'
  status: number
  headers: Record<string, string>
  body: string
}

type CaseRequest = {
  case: GateCase
  serviceName: string | null
  serviceToken: string | null
  rpcAccessToken: string | null
  expectedStatus: number
}

function unexpectedCall(name: string): never {
  throw new Error(`${name} is not part of the internal service gate fixture`)
}

function requiredServiceToken(tokens: Record<string, string>, service: string): string {
  const configured = tokens[service]
  if (!configured) {
    throw new Error(`control-api config has no internal service token for ${service}`)
  }
  return configured
}

/** A signed RPC access token whose signature no longer verifies. */
function withAlteredSignature(signed: string): string {
  const [header, payload, signature] = signed.split('.')
  if (!header || !payload || !signature) throw new Error('RPC access token is not a JWS')
  const first = signature[0] === 'A' ? 'B' : 'A'
  return `${header}.${payload}.${first}${signature.slice(1)}`
}

/**
 * Stands for rpc-proxy's call to the V1 Host access route behind control-api's
 * internal service gate. It mounts, in the order of `app.ts`, the gate
 * (`requireInternalToken`, then `requireInternalService('rpc-proxy')` on `/rpc`)
 * and the real RPC access users router, sends each case as GET and as POST
 * (`authorized` as GET only), and prints one JSON line with every answer:
 * status, response headers and the raw body text. The service tokens are the
 * ones control-api's config holds at run time; the wrong token is random.
 * All cases go to one server bound on 127.0.0.1, which must serve each of them.
 */
async function main(): Promise<void> {
  installControlApiJwtTestKeys()
  // Imported after the keys are installed: control-api reads its config when it loads.
  const [
    { config },
    { requireInternalService, requireInternalToken },
    { createRpcAccessUsersRouter },
    { signRpcAccessToken },
  ] = await Promise.all([
    import('../../src/config.js'),
    import('../../src/middleware/internalServiceAuth.js'),
    import('../../src/routes/rpc-access/users.js'),
    import('../../src/utils/auth/rpcAuthToken.js'),
  ])
  const input = JSON.parse(process.argv[2] ?? '') as FixtureInput
  if (!input.userId || !input.hostRef) {
    throw new Error('the fixture input needs userId and hostRef')
  }

  const rpcProxyToken = requiredServiceToken(config.internalServiceTokens, 'rpc-proxy')
  const otherServiceToken = requiredServiceToken(config.internalServiceTokens, 'external-rest-api')
  const wrongToken = randomBytes(24).toString('hex')

  // The user holds a direct directory grant for the Host, so the team lookups are never reached.
  const directory: RpcHostAccessDirectory = {
    getUserAgents: async userId => {
      if (userId !== input.userId) unexpectedCall(`getUserAgents(${userId})`)
      return { userId, agentNames: [input.hostRef] }
    },
    getCurrentTeam: async () => unexpectedCall('getCurrentTeam'),
    getTeamAgents: async () => unexpectedCall('getTeamAgents'),
  }
  const gateway = {
    listResource: async () => [{ metadata: { name: input.hostRef }, spec: { enabled: true } }],
    getResource: async () => unexpectedCall('getResource'),
    createResource: async () => unexpectedCall('createResource'),
    updateResource: async () => unexpectedCall('updateResource'),
    deleteResource: async () => unexpectedCall('deleteResource'),
  }
  const app = express()
  app.use(requireInternalToken)
  app.use('/rpc', requireInternalService('rpc-proxy'))
  app.use(
    createRpcAccessUsersRouter(gateway as unknown as K8sGateway, {
      bindingService: { bind: async () => unexpectedCall('bindingService.bind') },
      directory,
    })
  )

  const validRpcAccessToken = signRpcAccessToken({
    sub: input.userId,
    typ: 'user',
    accessScope: 'user',
    teamId: null,
    scopes: ['host:status:read', 'host:message:invoke'],
    hostRefs: [input.hostRef],
    jti: randomUUID(),
  })
  const unverifiableRpcAccessToken = withAlteredSignature(validRpcAccessToken)

  const refusals: CaseRequest[] = [
    {
      case: 'gate_bearer_missing',
      serviceName: 'rpc-proxy',
      serviceToken: null,
      rpcAccessToken: validRpcAccessToken,
      expectedStatus: 401,
    },
    {
      case: 'gate_service_name_missing',
      serviceName: null,
      serviceToken: rpcProxyToken,
      rpcAccessToken: validRpcAccessToken,
      expectedStatus: 401,
    },
    {
      case: 'gate_token_wrong',
      serviceName: 'rpc-proxy',
      serviceToken: wrongToken,
      rpcAccessToken: validRpcAccessToken,
      expectedStatus: 401,
    },
    {
      case: 'gate_other_service',
      serviceName: 'external-rest-api',
      serviceToken: otherServiceToken,
      rpcAccessToken: validRpcAccessToken,
      expectedStatus: 401,
    },
    {
      case: 'caller_token_missing',
      serviceName: 'rpc-proxy',
      serviceToken: rpcProxyToken,
      rpcAccessToken: null,
      expectedStatus: 401,
    },
    {
      case: 'caller_token_unverifiable',
      serviceName: 'rpc-proxy',
      serviceToken: rpcProxyToken,
      rpcAccessToken: unverifiableRpcAccessToken,
      expectedStatus: 401,
    },
    {
      case: 'both_bad',
      serviceName: 'rpc-proxy',
      serviceToken: wrongToken,
      rpcAccessToken: null,
      expectedStatus: 401,
    },
  ]
  const authorized: CaseRequest = {
    case: 'authorized',
    serviceName: 'rpc-proxy',
    serviceToken: rpcProxyToken,
    rpcAccessToken: validRpcAccessToken,
    expectedStatus: 200,
  }
  const path = `/rpc/access/users/${input.userId}/mcp-hosts/${input.hostRef}`
  const plan: Array<[CaseRequest, 'GET' | 'POST']> = [
    ...refusals.flatMap(
      (entry): Array<[CaseRequest, 'GET' | 'POST']> => [
        [entry, 'GET'],
        [entry, 'POST'],
      ]
    ),
    [authorized, 'GET'],
  ]

  // One server for every case, bound to the IPv4 loopback the client dials.
  // supertest's request(app) would listen on the wildcard, and this child runs
  // outside vitest, so scripts/testing/bind-loopback-in-tests.mjs does not apply.
  const server: Server = app.listen(0, '127.0.0.1')
  // Outside the try: listen(port, host) binds after an async lookup, and a listen
  // error must surface as itself, not as close()'s ERR_SERVER_NOT_RUNNING.
  await once(server, 'listening')
  const answers: EmittedAnswer[] = []
  try {
    const address = server.address() as AddressInfo | null
    if (address === null || address.address !== '127.0.0.1') {
      throw new Error(
        `the gate fixture server is not bound on 127.0.0.1: ${JSON.stringify(address)}`
      )
    }
    let served = 0
    server.on('request', () => {
      served++
    })
    for (const [entry, method] of plan) {
      const servedBefore = served
      let pending = method === 'GET' ? request(server).get(path) : request(server).post(path)
      if (entry.serviceToken !== null) {
        pending = pending.set('authorization', `Bearer ${entry.serviceToken}`)
      }
      if (entry.serviceName !== null) pending = pending.set('x-service-token', entry.serviceName)
      if (entry.rpcAccessToken !== null) {
        pending = pending.set('x-rpc-access-token', entry.rpcAccessToken)
      }
      if (method === 'POST') {
        pending = pending
          .set('content-type', 'application/json')
          .send(
            JSON.stringify({ runId: randomUUID(), sessionId: 'session-1', origin: 'direct_chat' })
          )
      }
      const response = await pending
      if (served !== servedBefore + 1) {
        throw new Error(`${entry.case} on ${method} was not answered by the fixture's own server`)
      }
      if (response.status !== entry.expectedStatus) {
        throw new Error(
          `${entry.case} on ${method} answered ${response.status}, expected ${entry.expectedStatus}`
        )
      }
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(response.headers as Record<string, unknown>)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
      }
      answers.push({
        case: entry.case,
        method,
        status: response.status,
        headers,
        body: response.text,
      })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())))
  }
  process.stdout.write(`${JSON.stringify(answers)}\n`)
}

void main()
