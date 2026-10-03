import { describe, expect, it } from 'vitest'
import { RPC_PROXY_MCP_HOST_EDGE_TOKEN_DEV_DEFAULT } from '@clerum/action-context-contracts'

// Importing the full runtime config intentionally requires a credential for
// non-dev Hosts. Seed an isolated test value for module initialization, then
// restore the worker environment before exercising the parser directly.
const previousCredential = process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN
process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN ??= 'test-rpc-proxy-edge-credential'
const { parseRpcProxyEdgeToken } = await import('./config')
if (previousCredential === undefined) delete process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN
else process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN = previousCredential

describe('parseRpcProxyEdgeToken', () => {
  it('requires a configured credential for every non-dev Host runtime', () => {
    expect(() => parseRpcProxyEdgeToken(undefined, true)).toThrow(
      'MCP_HOST_RPC_PROXY_EDGE_TOKEN is missing or invalid'
    )
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
