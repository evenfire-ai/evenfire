import { describe, expect, it } from 'vitest'
import { integrationNotConfigured } from '../src/oauth/integrationNotConfigured.js'

describe('integrationNotConfigured', () => {
  it('builds a hint pointing at the Secret name when only the name is reported', () => {
    expect(integrationNotConfigured('microsoft', 'sales-crm-oauth-microsoft')).toEqual({
      error: 'integration_not_configured',
      integration: 'microsoft',
      hint: 'create Secret sales-crm-oauth-microsoft to activate this integration',
    })
  })

  it('builds a hint pointing at the missing key when both name and key are reported', () => {
    expect(integrationNotConfigured('microsoft', 'sales-crm-oauth-microsoft/client_id')).toEqual({
      error: 'integration_not_configured',
      integration: 'microsoft',
      hint: 'create key client_id on Secret sales-crm-oauth-microsoft to activate this integration',
    })
  })

  it('preserves the integration id verbatim', () => {
    const body = integrationNotConfigured('salesforce-prod', 'a')
    expect(body.integration).toBe('salesforce-prod')
  })
})
