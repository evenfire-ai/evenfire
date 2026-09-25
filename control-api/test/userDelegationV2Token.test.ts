import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../src/config.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  USER_DELEGATION_V2_MAX_TTL_SECONDS,
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'

const principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  sid: '00000000-0000-4000-8000-000000000002',
  sessionVersion: 3,
}
const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: 'host',
  logicalId: 'mcp-host/chatllm',
})
const accessPathId = `ap1_${'a'.repeat(43)}`
const authorizationRevision = `ar1_${'b'.repeat(43)}`

function issue(overrides: Partial<Parameters<typeof issueUserDelegationV2>[0]> = {}) {
  const prepared = prepareActionOperationTarget({
    operationId: 'chat.message.invoke',
    resource,
    operationTarget: {
      hostRef: 'mcp-host/chatllm',
      channelType: 'rpc',
      channelId: 'chatllm',
    },
    allocateMessageId: () => '00000000-0000-4000-8000-000000000003',
  })
  return issueUserDelegationV2({
    principal,
    operationIds: ['chat.message.invoke'],
    resource,
    preparedTargets: { 'chat.message.invoke': prepared },
    accessPathId,
    authorizationRevision,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
    issuedAtSeconds: Math.floor(Date.now() / 1000),
    ...overrides,
  })
}

describe('user delegation v2 token producer', () => {
  it('round-trips the real producer through the strict verifier', () => {
    const claims = verifyUserDelegationV2(issue())
    expect(claims).toMatchObject({
      typ: 'user_delegation',
      ver: 2,
      sub: principal.userId,
      sid: principal.sid,
      sv: principal.sessionVersion,
      operationIds: ['chat.message.invoke'],
      scopes: ['action:chat.message.invoke'],
      accessPathId,
      authorizationRevision,
      pathKind: 'direct',
      effectiveTeamId: null,
    })
    expect(claims?.targets['chat.message.invoke']?.messageId).toBe(
      '00000000-0000-4000-8000-000000000003'
    )
    expect(claims?.targetHashes['chat.message.invoke']).toMatch(/^ath2_[A-Za-z0-9_-]{43}$/)
  })

  it('caps the lifetime and rejects path/team binding substitution', () => {
    const token = issue({ ttlSeconds: USER_DELEGATION_V2_MAX_TTL_SECONDS + 500 })
    const claims = verifyUserDelegationV2(token)
    expect(claims!.exp - claims!.iat).toBe(USER_DELEGATION_V2_MAX_TTL_SECONDS)
    expect(() => issue({ pathKind: 'direct', effectiveTeamId: principal.userId })).toThrow(
      'user_delegation_binding_invalid'
    )
  })

  it('rejects unknown claims even when signed by the real producer key', () => {
    const valid = issue()
    const decoded = jwt.decode(valid, { json: true })!
    const { iat: _iat, exp: _exp, iss: _iss, aud: _aud, ...claims } = decoded
    const forged = jwt.sign(
      { ...claims, unexpectedAuthority: 'team-admin' },
      config.rpcJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.rpcJwtIssuer,
        audience: config.rpcJwtAudience,
        expiresIn: 60,
      }
    )
    expect(verifyUserDelegationV2(forged)).toBeNull()
  })
})
