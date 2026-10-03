import { RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER } from '@clerum/action-context-contracts'

/** Add the canonical synthetic service proof to mounted RPC Proxy test traffic. */
export function withRpcProxyEdgeTestAuthentication(
  headers: Record<string, string>
): Record<string, string> {
  const token = process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN
  if (!token) throw new Error('Vitest RPC Proxy edge credential is not configured')
  return {
    ...headers,
    'x-service-token': 'rpc-proxy',
    [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: token,
  }
}
