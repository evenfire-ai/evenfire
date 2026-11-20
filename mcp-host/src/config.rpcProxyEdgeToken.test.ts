import { describe, expect, it } from 'vitest'
import { RPC_PROXY_MCP_HOST_EDGE_TOKEN_DEV_DEFAULT } from '@clerum/action-context-contracts'
import { parseRpcProxyEdgeToken } from './config'

describe('parseRpcProxyEdgeToken', () => {
  it('allows startup without the dormant V2 credential', () => {
    expect(parseRpcProxyEdgeToken(undefined, true)).toBe('')
  })

  it('trims and preserves a bounded credential when required', () => {
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

  it('uses the same explicit local development credential as RPC Proxy', () => {
    expect(parseRpcProxyEdgeToken(undefined, false)).toBe(RPC_PROXY_MCP_HOST_EDGE_TOKEN_DEV_DEFAULT)
  })
})
