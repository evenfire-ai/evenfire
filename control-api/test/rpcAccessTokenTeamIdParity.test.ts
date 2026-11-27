import { describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../src/config.js'
import { verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

/**
 * The V1 Host edge assertion carries the team control-api parses from the RPC token, and
 * rpc-proxy sends the team header from its own parse of the same token. The Host requires the
 * two to be equal, so both parsers must give the same team for every shape the claim can take.
 *
 * rpc-proxy's parser reads only its verification settings from its config; they are bound here
 * to the key pair and the issuer and audience control-api signs RPC tokens with.
 */
vi.mock('../../rpc-proxy/src/config.js', async () => {
  const { config: controlApiConfig } = await import('../src/config.js')
  return {
    config: {
      jwtPublicKey: controlApiConfig.rpcJwtPublicKey,
      jwtIssuer: controlApiConfig.rpcJwtIssuer,
      jwtAudience: controlApiConfig.rpcJwtAudience,
    },
  }
})

const { verifyRpcToken } = await import('../../rpc-proxy/src/authToken.js')

const TEAM_ID_SHAPES = [
  { name: 'a string', claims: { teamId: 'team-1' } },
  { name: 'a padded string', claims: { teamId: '  team-1  ' } },
  { name: 'absent', claims: {} },
  { name: 'null', claims: { teamId: null } },
  { name: 'a non-string value', claims: { teamId: 42 } },
] as const
const ACCESS_SCOPES = [
  { name: 'no accessScope', claims: {} },
  { name: "accessScope 'team'", claims: { accessScope: 'team' } },
  { name: "accessScope 'user'", claims: { accessScope: 'user' } },
] as const

function fixtureToken(claims: Record<string, unknown>): string {
  return jwt.sign(
    {
      sub: 'user-1',
      typ: 'user',
      scopes: ['host:status:read'],
      hostRefs: ['host-a'],
      jti: 'rpc-token-jti',
      ...claims,
    },
    config.rpcJwtPrivateKey,
    {
      algorithm: 'RS256',
      expiresIn: 300,
      issuer: config.rpcJwtIssuer,
      audience: config.rpcJwtAudience,
    }
  )
}

describe('RPC token team parsing is the same in control-api and rpc-proxy', () => {
  it.each(
    TEAM_ID_SHAPES.flatMap(team =>
      ACCESS_SCOPES.map(scope => ({
        name: `teamId ${team.name}, ${scope.name}`,
        claims: { ...scope.claims, ...team.claims },
      }))
    )
  )('$name', ({ claims }) => {
    const token = fixtureToken(claims)
    const controlApi = verifyRpcAccessToken(token)
    const rpcProxy = verifyRpcToken(token)
    expect(rpcProxy === null).toBe(controlApi === null)
    expect(rpcProxy?.teamId).toBe(controlApi?.teamId)
  })

  it('accepts the team shapes both parsers admit and gives the trimmed team', () => {
    // Witness that both parsers accept and parse, so the parity cases above compare values.
    const string = fixtureToken({ teamId: 'team-1' })
    const padded = fixtureToken({ teamId: '  team-1  ' })
    const user = fixtureToken({ accessScope: 'user', teamId: null })
    for (const parse of [verifyRpcAccessToken, verifyRpcToken]) {
      expect(parse(string)?.teamId).toBe('team-1')
      expect(parse(padded)?.teamId).toBe('team-1')
      expect(parse(user)).not.toBeNull()
      expect(parse(user)?.teamId).toBeNull()
    }
  })
})
