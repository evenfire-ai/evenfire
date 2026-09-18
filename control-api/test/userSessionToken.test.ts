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
  it('issues only the strict one-hour user and session identity contract', () => {
    const token = signUserSessionV2Token(input, input.auth_time)
    const decoded = jwt.decode(token) as jwt.JwtPayload

    expect(decoded).toEqual({
      sub: input.sub,
      sid: input.sid,
      jti: input.jti,
      sv: 1,
      ver: 2,
      typ: 'user_session',
      email: input.email,
      auth_time: input.auth_time,
      amr: ['pwd'],
      iat: input.auth_time,
      exp: input.auth_time + USER_SESSION_V2_TTL_SECONDS,
      aud: USER_SESSION_V2_AUDIENCE,
      iss: config.jwtIssuer,
    })
  })

  it('rejects wrong trust, shape, time, and authority-bearing claims', () => {
    const sign = (payload: Record<string, unknown>, options: jwt.SignOptions = {}) =>
      jwt.sign(payload, config.sessionJwtPrivateKey, {
        algorithm: 'RS256',
        issuer: config.jwtIssuer,
        audience: USER_SESSION_V2_AUDIENCE,
        expiresIn: USER_SESSION_V2_TTL_SECONDS,
        ...options,
      })

    const wrongAudience = sign(input, { audience: 'profile-ui' })
    const wrongType = sign({ ...input, ver: 2, typ: 'service' })
    const wrongVersion = sign({ ...input, ver: 3, typ: 'user_session' })
    const forbiddenClaim = sign({ ...input, ver: 2, typ: 'user_session', role: 'admin' })
    const unknownClaim = sign({ ...input, ver: 2, typ: 'user_session', debug: true })
    const missingSid = sign({ ...input, sid: undefined, ver: 2, typ: 'user_session' })
    const malformedSid = sign({ ...input, sid: 'not-a-uuid', ver: 2, typ: 'user_session' })
    const wrongAlgorithm = jwt.sign(
      { ...input, ver: 2, typ: 'user_session' },
      'not-the-session-key',
      {
        algorithm: 'HS256',
        issuer: config.jwtIssuer,
        audience: USER_SESSION_V2_AUDIENCE,
        expiresIn: USER_SESSION_V2_TTL_SECONDS,
      }
    )
    const expired = signUserSessionV2Token(input, Math.floor(Date.now() / 1000) - 7200)
    const future = signUserSessionV2Token(
      input,
      Math.floor(Date.now() / 1000) + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS + 1
    )

    for (const token of [
      wrongAudience,
      wrongType,
      wrongVersion,
      forbiddenClaim,
      unknownClaim,
      missingSid,
      malformedSid,
      wrongAlgorithm,
      expired,
      future,
    ]) {
      expect(verifyUserSessionV2Token(token)).toBeNull()
    }
  })

  it('is rejected by every independent non-user trust plane', () => {
    const token = signUserSessionV2Token(input)

    expect(verifyRpcAccessToken(token)).toBeNull()
    expect(verifyAdminToken(token)).toBeNull()
    expect(verifyInternalControlJwt(token)).toBeNull()
    expect(verifyMcpHostAccessJwt(token)).toBeNull()
    expect(verifyMcpHostControlJwt(token)).toBeNull()
    expect(verifyOAuthBrokerJwt(token)).toBeNull()
  })
})
