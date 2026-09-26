import { describe, expect, it } from 'vitest'
import { parseRpcProxyEdgeToken } from './config'

describe('parseRpcProxyEdgeToken', () => {
  it('requires a configured production credential', () => {
    expect(() => parseRpcProxyEdgeToken(undefined, true)).toThrow(
      'MCP_HOST_RPC_PROXY_EDGE_TOKEN is missing or invalid'
    )
  })

  it('trims and preserves a bounded credential', () => {
    expect(parseRpcProxyEdgeToken('  abcdefghijklmnop  ', true)).toBe('abcdefghijklmnop')
  })

  it('rejects credentials outside the accepted length', () => {
    expect(() => parseRpcProxyEdgeToken('short', false)).toThrow(
      'MCP_HOST_RPC_PROXY_EDGE_TOKEN is missing or invalid'
    )
    expect(() => parseRpcProxyEdgeToken('x'.repeat(4097), false)).toThrow(
      'MCP_HOST_RPC_PROXY_EDGE_TOKEN is missing or invalid'
    )
  })

  it('permits the existing local non-production fixture without a credential', () => {
    expect(parseRpcProxyEdgeToken(undefined, false)).toBe('')
  })
})
