import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  type ActionOperationId,
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { tokenDeclaresV2, verifyUserDelegationV2 } from './userDelegationV2.js'

const KEYPAIR = generateKeyPairSync('rsa', { modulusLength: 2048 })
const OTHER_KEYPAIR = generateKeyPairSync('rsa', { modulusLength: 2048 })
const SIGNING_KEY_PEM = KEYPAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const PUBLIC_KEY = KEYPAIR.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const NOW = 1_800_000_000

function claims(operationId: ActionOperationId = 'mcp.invoke') {
  const resource = canonicalResourceIdentity({
    environmentId: 'test',
    type: 'mcp_server',
    logicalId: 'mcp-server/weather',
    displayName: 'Weather',
  })
  const target = validateActionOperationTarget({
    operationId,
    resource,
    operationTarget:
      operationId === 'mcp.invoke'
        ? { serverNamespace: 'mcp-server', serverName: 'weather', toolName: 'forecast' }
        : { serverNamespace: 'mcp-server', serverName: 'weather' },
  })
  return {
    typ: 'user_delegation',
    ver: 2,
    sub: randomUUID(),
    sid: randomUUID(),
    sv: 3,
    jti: randomUUID(),
    iat: NOW - 10,
    exp: NOW + 120,
    operationIds: [operationId],
    scopes: [actionOperationScope(operationId)],
    resource,
    targets: { [operationId]: target },
    targetHashes: { [operationId]: hashActionTarget(target) },
    accessPathId: `ap1_${'A'.repeat(43)}`,
    authorizationRevision: `ar1_${'B'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'C'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
  }
}

function sign(
  overrides: Record<string, unknown> = {},
  options: { audience?: string; privateKey?: string } = {}
): string {
  return jwt.sign({ ...claims(), ...overrides }, options.privateKey ?? SIGNING_KEY_PEM, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience: options.audience ?? 'rpc-proxy',
  })
}

function verify(token: string) {
  return verifyUserDelegationV2(token, {
    publicKey: PUBLIC_KEY,
    issuer: 'control-api',
    audience: 'rpc-proxy',
    nowSeconds: NOW,
  })
}

describe('user delegation v2 verifier', () => {
  it('accepts the strict producer-shaped token', () => {
    expect(verify(sign())).toMatchObject({ typ: 'user_delegation', ver: 2 })
  })

  it('rejects a bad signature, token type, or audience', () => {
    const otherPrivateKey = OTHER_KEYPAIR.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
    expect(verify(sign({}, { privateKey: otherPrivateKey }))).toBeNull()
    expect(verify(sign({ typ: 'user' }))).toBeNull()
    expect(verify(sign({}, { audience: 'mcp-host' }))).toBeNull()
  })

  it('rejects mixed v1/v2 authority claims instead of falling back', () => {
    const token = sign({ teamId: randomUUID(), role: 'owner' })
    expect(tokenDeclaresV2(token)).toBe(true)
    expect(verify(token)).toBeNull()
  })

  it('rejects noncanonical scope ordering and target bindings', () => {
    expect(verify(sign({ scopes: ['action:mcp.tools.read'] }))).toBeNull()
    expect(
      verify(
        sign({
          targets: {
            'mcp.invoke': {
              serverNamespace: 'mcp-server',
              serverName: 'other',
              toolName: 'forecast',
            },
          },
        })
      )
    ).toBeNull()
  })
})
