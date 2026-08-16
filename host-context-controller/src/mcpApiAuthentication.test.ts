import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import {
  HCC_MCP_AUDIENCE,
  MCP_CREDENTIAL_READ_CAPABILITY,
  McpApiAuthenticationError,
  McpApiAuthenticator,
  McpApiVerifierConfigurationError,
  WORKFLOW_APPROVAL_AUDIENCE,
} from './mcpApiAuthentication'

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const authenticator = new McpApiAuthenticator({
  publicKey: pair.publicKey,
  issuer: 'control-api',
  hostNamespace: 'mcp-host',
})

function tokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'mcp-host/standalone',
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
    hostRefs: ['host-a'],
    host_uid: 'uid-a',
    scope: 'workflow:approval:request',
    workflowControlScopes: [],
    mcpCapabilities: [MCP_CREDENTIAL_READ_CAPABILITY],
    ...overrides,
  }
}

function sign(
  overrides: Record<string, unknown> = {},
  audience: string | string[] = [WORKFLOW_APPROVAL_AUDIENCE, HCC_MCP_AUDIENCE]
): string {
  return jwt.sign(tokenClaims(overrides), pair.privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience,
    expiresIn: 300,
    jwtid: `test-${Math.random()}`,
  })
}

function authenticate(token: string) {
  return authenticator.authenticate({ authorization: `Bearer ${token}` }, [
    'Authorization',
    `Bearer ${token}`,
  ])
}

describe('McpApiAuthenticator', () => {
  it('accepts the exact migration audience pair and returns only the Host principal', () => {
    expect(authenticate(sign())).toMatchObject({
      subject: 'mcp-host/standalone',
      hostName: 'host-a',
      hostUid: 'uid-a',
      namespace: 'mcp-host',
      audiences: [WORKFLOW_APPROVAL_AUDIENCE, HCC_MCP_AUDIENCE],
    })
  })

  it('accepts the exact HCC-only audience', () => {
    expect(authenticate(sign({}, HCC_MCP_AUDIENCE)).audiences).toEqual([HCC_MCP_AUDIENCE])
  })

  it.each([
    [WORKFLOW_APPROVAL_AUDIENCE],
    [[HCC_MCP_AUDIENCE, WORKFLOW_APPROVAL_AUDIENCE, 'third-resource']],
    [[HCC_MCP_AUDIENCE, HCC_MCP_AUDIENCE]],
  ])('rejects a non-exact audience set', audience => {
    expect(() => authenticate(sign({}, audience as string | string[]))).toThrow(
      McpApiAuthenticationError
    )
  })

  it.each([
    { mcpCapabilities: [] },
    { mcpCapabilities: [MCP_CREDENTIAL_READ_CAPABILITY, 'extra'] },
    { host_uid: undefined },
    { hostRefs: ['host-a', 'host-b'] },
    { recipeName: 'recipe-a', hostRefs: ['sandbox-recipes/recipe-a'] },
    { scope: 'workflow:approval:refresh' },
  ])('rejects a malformed or non-Host access contract', overrides => {
    expect(() => authenticate(sign(overrides))).toThrow(McpApiAuthenticationError)
  })

  it('rejects duplicate Authorization fields before verification', () => {
    const token = sign()
    expect(() =>
      authenticator.authenticate({ authorization: `Bearer ${token}` }, [
        'Authorization',
        `Bearer ${token}`,
        'authorization',
        `Bearer ${token}`,
      ])
    ).toThrow(McpApiAuthenticationError)
  })

  it('rejects wrong algorithm, issuer, expiration, and excessive lifetime', () => {
    const invalidTokens = [
      jwt.sign(tokenClaims(), 'attacker-secret', {
        algorithm: 'HS256',
        issuer: 'control-api',
        audience: HCC_MCP_AUDIENCE,
        expiresIn: 300,
        jwtid: 'wrong-algorithm',
      }),
      jwt.sign(tokenClaims(), pair.privateKey, {
        algorithm: 'RS256',
        issuer: 'other-issuer',
        audience: HCC_MCP_AUDIENCE,
        expiresIn: 300,
        jwtid: 'wrong-issuer',
      }),
      jwt.sign(tokenClaims(), pair.privateKey, {
        algorithm: 'RS256',
        issuer: 'control-api',
        audience: HCC_MCP_AUDIENCE,
        expiresIn: -10,
        jwtid: 'expired',
      }),
      jwt.sign(tokenClaims(), pair.privateKey, {
        algorithm: 'RS256',
        issuer: 'control-api',
        audience: HCC_MCP_AUDIENCE,
        expiresIn: 601,
        jwtid: 'excessive-lifetime',
      }),
      jwt.sign(tokenClaims({ iat: Math.floor(Date.now() / 1000) + 60 }), pair.privateKey, {
        algorithm: 'RS256',
        issuer: 'control-api',
        audience: HCC_MCP_AUDIENCE,
        expiresIn: 300,
        jwtid: 'future-issued-at',
      }),
      jwt.sign(tokenClaims(), pair.privateKey, {
        algorithm: 'RS256',
        issuer: 'control-api',
        audience: HCC_MCP_AUDIENCE,
        expiresIn: 300,
        jwtid: ' non-canonical-jti ',
      }),
    ]
    for (const token of invalidTokens) {
      expect(() => authenticate(token)).toThrow(McpApiAuthenticationError)
    }
  })

  it('fails closed on absent, malformed, or placeholder public keys', () => {
    expect(
      () =>
        new McpApiAuthenticator({ publicKey: '', issuer: 'control-api', hostNamespace: 'mcp-host' })
    ).toThrow(McpApiVerifierConfigurationError)
    expect(
      () =>
        new McpApiAuthenticator({
          publicKey: 'not-a-pem',
          issuer: 'control-api',
          hostNamespace: 'mcp-host',
        })
    ).toThrow(McpApiVerifierConfigurationError)
    expect(
      () =>
        new McpApiAuthenticator({
          publicKey: pair.privateKey,
          issuer: 'control-api',
          hostNamespace: 'mcp-host',
        })
    ).toThrow(McpApiVerifierConfigurationError)
  })
})
