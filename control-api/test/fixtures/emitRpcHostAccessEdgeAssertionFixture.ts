import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { installControlApiJwtTestKeys } from '../../../scripts/testing/controlApiJwtTestKeys.js'
import type { K8sGateway } from '../../src/k8s.js'
import type { RpcAccessScope, RpcScope } from '../../src/profileTypes.js'
import type { RpcHostAccessDirectory } from '../../src/services/access/rpcHostAccessAuthorizer.js'

type FixtureInput = Readonly<{
  userId: string
  hostRef: string
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
}>

function unexpectedCall(name: string): never {
  throw new Error(`${name} is not part of the V1 Host access fixture`)
}

/**
 * Stands for rpc-proxy's call to the V1 Host access route: it signs a real RPC access token,
 * sends it through the real router and its token middleware, and prints the route's 200 body,
 * whose `edgeAssertion` is the assertion control-api issues for the Host.
 */
async function main(): Promise<void> {
  installControlApiJwtTestKeys()
  // Imported after the keys are installed: control-api reads its config when it loads.
  const [{ createRpcAccessUsersRouter }, { signRpcAccessToken }] = await Promise.all([
    import('../../src/routes/rpc-access/users.js'),
    import('../../src/utils/auth/rpcAuthToken.js'),
  ])
  const input = JSON.parse(process.argv[2] ?? '') as FixtureInput

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
  app.use(
    createRpcAccessUsersRouter(gateway as unknown as K8sGateway, {
      bindingService: { bind: async () => unexpectedCall('bindingService.bind') },
      directory,
    })
  )

  const rpcAccessToken = signRpcAccessToken({
    sub: input.userId,
    typ: 'user',
    accessScope: input.accessScope,
    teamId: input.teamId,
    scopes: input.scopes,
    hostRefs: [input.hostRef],
    jti: randomUUID(),
  })
  const response = await request(app)
    .get(`/rpc/access/users/${input.userId}/mcp-hosts/${input.hostRef}`)
    .set('x-rpc-access-token', rpcAccessToken)
  if (response.status !== 200) {
    throw new Error(`V1 Host access route answered ${response.status}`)
  }
  process.stdout.write(`${JSON.stringify(response.body)}\n`)
}

void main()
