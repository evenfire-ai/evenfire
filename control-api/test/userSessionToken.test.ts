import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../src/config.js'
import { verifyAdminToken } from '../src/utils/auth/adminAuthToken.js'
import { verifyInternalControlJwt } from '../src/utils/auth/internalControlToken.js'
import {
  verifyMcpHostAccessJwt,
  verifyMcpHostControlJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'
import { verifyOAuthBrokerJwt } from '../src/utils/auth/oauthBrokerJwtToken.js'
import { verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import {
  USER_SESSION_V2_AUDIENCE,
  USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS,
  USER_SESSION_V2_TTL_SECONDS,
  signUserSessionV2Token,
  verifyUserSessionV2Token,
} from '../src/utils/auth/userSessionV2Token.js'

const input = {
  sub: '11111111-1111-4111-8111-111111111111',
  sid: '22222222-2222-4222-8222-222222222222',
  jti: '33333333-3333-4333-8333-333333333333',
  sv: 1,
  email: 'user@example.com',
  auth_time: Math.floor(Date.now() / 1000),
  amr: ['pwd'],
}

describe('user-session v2 token contract', () => {
  it('issues the strict one-hour user/session identity contract', () => {
    const token = signUserSessionV2Token(input, input.auth_time)
    const decoded = jwt.decode(token) as jwt.JwtPayload

    expect(decoded).toMatchObject({
      iss: config.jwtIssuer,
      aud: USER_SESSION_V2_AUDIENCE,
      sub: input.sub,
      sid: input.sid,
      jti: input.jti,
      sv: 1,
      ver: 2,
      typ: 'user_session',
      iat: input.auth_time,
      exp: input.auth_time + USER_SESSION_V2_TTL_SECONDS,
      auth_time: input.auth_time,
      amr: ['pwd'],
      email: input.email,
    })
    for (const forbidden of [
      'teamId',
      'role',
      'memberships',
      'grants',
      'capabilities',
      'budgets',
      'credentials',
      'filesystemScope',
      'runtime',
      'providerPolicy',
      'auditOwner',
    ]) {
      expect(decoded).not.toHaveProperty(forbidden)
    }
  })

  it('rejects wrong audience, type, version, algorithm, times, and forbidden claims', () => {
    const wrongAudience = jwt.sign(
      { ...input, ver: 2, typ: 'user_session' },
      config.sessionJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.jwtIssuer,
        audience: 'profile-ui',
        expiresIn: 3600,
      }
    )
    const wrongType = jwt.sign({ ...input, ver: 2, typ: 'service' }, config.sessionJwtPrivateKey, {
      algorithm: 'RS256',
      issuer: config.jwtIssuer,
      audience: USER_SESSION_V2_AUDIENCE,
      expiresIn: 3600,
    })
    const forbiddenClaim = jwt.sign(
      { ...input, ver: 2, typ: 'user_session', role: 'admin' },
      config.sessionJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.jwtIssuer,
        audience: USER_SESSION_V2_AUDIENCE,
        expiresIn: 3600,
      }
    )
    const wrongVersion = jwt.sign(
      { ...input, ver: 3, typ: 'user_session' },
      config.sessionJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.jwtIssuer,
        audience: USER_SESSION_V2_AUDIENCE,
        expiresIn: 3600,
      }
    )
    const wrongAlgorithm = jwt.sign(
      { ...input, ver: 2, typ: 'user_session' },
      'not-the-session-key',
      {
        algorithm: 'HS256',
        issuer: config.jwtIssuer,
        audience: USER_SESSION_V2_AUDIENCE,
        expiresIn: 3600,
      }
    )
    const missingSid = jwt.sign(
      { ...input, sid: undefined, ver: 2, typ: 'user_session' },
      config.sessionJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.jwtIssuer,
        audience: USER_SESSION_V2_AUDIENCE,
        expiresIn: 3600,
      }
    )
    const expired = signUserSessionV2Token(input, Math.floor(Date.now() / 1000) - 7200)
    const future = signUserSessionV2Token(
      input,
      Math.floor(Date.now() / 1000) + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS + 1
    )

    expect(verifyUserSessionV2Token(wrongAudience)).toBeNull()
    expect(verifyUserSessionV2Token(wrongType)).toBeNull()
    expect(verifyUserSessionV2Token(wrongVersion)).toBeNull()
    expect(verifyUserSessionV2Token(wrongAlgorithm)).toBeNull()
    expect(verifyUserSessionV2Token(missingSid)).toBeNull()
    expect(verifyUserSessionV2Token(forbiddenClaim)).toBeNull()
    expect(verifyUserSessionV2Token(expired)).toBeNull()
    expect(verifyUserSessionV2Token(future)).toBeNull()
  })

  it('is rejected by every independently verified non-user trust plane', () => {
    const token = signUserSessionV2Token(input)

    expect(verifyRpcAccessToken(token)).toBeNull()
    expect(verifyAdminToken(token)).toBeNull()
    expect(verifyInternalControlJwt(token)).toBeNull()
    expect(verifyMcpHostAccessJwt(token)).toBeNull()
    expect(verifyMcpHostControlJwt(token)).toBeNull()
    expect(verifyOAuthBrokerJwt(token)).toBeNull()
  })
})
