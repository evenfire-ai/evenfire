import { describe, expect, it } from 'vitest'
import { RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER } from '@clerum/action-context-contracts'
import { redactUnknown } from '../logger'

describe('RPC Proxy edge credential log redaction', () => {
  it('redacts the dedicated credential header before structured logging', () => {
    const token = 'synthetic-edge-token-not-for-logs'

    expect(redactUnknown({ [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: token })).toEqual({
      [RPC_PROXY_MCP_HOST_EDGE_TOKEN_HEADER]: '[Redacted]',
    })
  })
})
