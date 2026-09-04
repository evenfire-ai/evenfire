import { describe, expect, it } from 'vitest'
import type { McpServerOAuth } from '../src/types'

// R1-M1: the HCC `McpServerOAuth.provider` union must mirror the full control-api
// adapter set (mcpserver.yaml `oauth.provider` enum). It previously omitted the
// U2 providers (monday/clickup/vercel), so it misrepresented the CRD. These are
// COMPILE-TIME assertions: the const declarations below fail `tsc`/`npm run build`
// against the narrow (5-value) union, which is the regression this locks.
describe('McpServerOAuth.provider union', () => {
  it('admits every provider the mcpserver CRD enum admits (8)', () => {
    const providers: McpServerOAuth['provider'][] = [
      'salesforce',
      'slack',
      'notion',
      'microsoft-graph',
      'google',
      'monday',
      'clickup',
      'vercel',
    ]
    expect(providers).toHaveLength(8)
  })

  it('types a monday OAuth server (U2 provider) without error', () => {
    const oauth: McpServerOAuth = {
      id: 'monday-personal',
      provider: 'monday',
      clientIdRef: { name: 'monday-oauth', key: 'client_id' },
      clientSecretRef: { name: 'monday-oauth', key: 'client_secret' },
    }
    expect(oauth.provider).toBe('monday')
  })
})
