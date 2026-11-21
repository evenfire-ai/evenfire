import { describe, expect, it } from 'vitest'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
import { redactUnknown } from '../logger'

describe('Host edge assertion log redaction', () => {
  it('redacts the edge assertion header before structured logging', () => {
    const assertion = 'synthetic.edge-assertion.not-for-logs'

    expect(
      redactUnknown({
        [HOST_EDGE_ASSERTION_HEADER]: assertion,
        'x-clerum-edge-caller': 'rpc-proxy',
      })
    ).toEqual({
      [HOST_EDGE_ASSERTION_HEADER]: '[Redacted]',
      'x-clerum-edge-caller': 'rpc-proxy',
    })
  })
})
