import { describe, expect, it } from 'vitest'
import type { CommunicationChannelCRD, CommunicationChannelSpec } from '../src/types'

describe('CommunicationChannelCRD type', () => {
  it('compiles with a minimal CRD object', () => {
    const cc: CommunicationChannelCRD = {
      name: 'tgtestjose2',
      namespace: 'channels',
      spec: { hostRef: 'development' },
    }
    expect(cc.spec.hostRef).toBe('development')
  })

  it('CommunicationChannelSpec intentionally models only hostRef', () => {
    // HCC only inspects hostRef; the full CC schema (telegram/email/slack) is
    // owned by the per-Host channel-reader pod's own watch — we deliberately
    // model only what HCC needs here.
    const spec: CommunicationChannelSpec = { hostRef: 'marketing' }
    expect(spec.hostRef).toBe('marketing')
  })
})
