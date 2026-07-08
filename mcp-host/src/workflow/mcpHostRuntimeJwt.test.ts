import { describe, expect, it } from 'vitest'
import {
  decodeMcpHostRuntimeJwtClaims,
  getJwtIssuedAt,
  getJwtRuntimeBinding,
  getMcpHostRuntimeCallerKey,
} from './mcpHostRuntimeJwt'

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.sig`
}

describe('mcpHostRuntimeJwt', () => {
  it('uses hostRefs[0] as the canonical caller and runtime binding over sub', () => {
    const token = jwtWithClaims({
      sub: 'mcp-host/chatllm',
      hostRefs: ['chatllm', 'sandbox-recipes/secondary'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      exp: 123,
      iat: 99,
    })

    expect(decodeMcpHostRuntimeJwtClaims(token)).toEqual({
      callerKey: 'chatllm',
      hostRef: 'chatllm',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      exp: 123,
      iat: 99,
    })
    expect(getMcpHostRuntimeCallerKey(token)).toBe('chatllm')
    expect(getJwtIssuedAt(token)).toBe(99)
    expect(getJwtRuntimeBinding(token)).toEqual({
      hostRef: 'chatllm',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
  })

  it('returns null caller key without falling back to sub or secondary hostRefs', () => {
    const token = jwtWithClaims({
      sub: 'mcp-host/chatllm',
      hostRefs: [' ', 'sandbox-recipes/secondary'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })

    expect(getMcpHostRuntimeCallerKey(token)).toBeNull()
    expect(getJwtRuntimeBinding(token)).toBeNull()
  })

  it('returns null claims and no runtime binding for malformed tokens', () => {
    expect(decodeMcpHostRuntimeJwtClaims('not-a-jwt')).toEqual({
      callerKey: null,
      hostRef: null,
      recipeNamespace: null,
      recipeName: null,
      exp: null,
      iat: null,
    })
    expect(getMcpHostRuntimeCallerKey('not-a-jwt')).toBeNull()
    expect(getJwtRuntimeBinding('not-a-jwt')).toBeNull()
  })
})
