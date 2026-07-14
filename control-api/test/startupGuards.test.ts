import { describe, expect, it } from 'vitest'
import { validateStartupGuards } from '../src/startupGuards.js'

const BASE_CONFIG = {
  internalControlJwtWrcHmacSecret: 'test-wrc-internal-control-secret',
  internalControlJwtHccHmacSecret: 'test-hcc-internal-control-secret',
  allowedIssuanceNamespaces: ['mcp-host', 'sandbox-recipes'],
  hostsNamespace: 'mcp-host',
  sandboxNamespace: 'sandbox-recipes',
  communicationChannelsNamespace: 'channels',
}

describe('validateStartupGuards', () => {
  it('accepts non-placeholder InternalControl secrets and complete issuance namespace allowlist', () => {
    expect(() => validateStartupGuards(BASE_CONFIG)).not.toThrow()
  })

  it('rejects empty or placeholder InternalControl secrets', () => {
    expect(() =>
      validateStartupGuards({ ...BASE_CONFIG, internalControlJwtWrcHmacSecret: '' })
    ).toThrow(/INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET/)

    expect(() =>
      validateStartupGuards({
        ...BASE_CONFIG,
        internalControlJwtHccHmacSecret: 'replace-with-internal-control-secret',
      })
    ).toThrow(/INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET/)
  })

  it('rejects startup when configured hosts namespace is missing from issuance allowlist', () => {
    expect(() =>
      validateStartupGuards({
        ...BASE_CONFIG,
        allowedIssuanceNamespaces: ['sandbox-recipes'],
      })
    ).toThrow(/CONTROL_API_ALLOWED_ISSUANCE_NAMESPACES must include mcp-host/)
  })

  it('rejects startup when configured sandbox namespace is missing from issuance allowlist', () => {
    expect(() =>
      validateStartupGuards({
        ...BASE_CONFIG,
        allowedIssuanceNamespaces: ['mcp-host'],
      })
    ).toThrow(/CONTROL_API_ALLOWED_ISSUANCE_NAMESPACES must include sandbox-recipes/)
  })

  it('compares configured namespaces case-insensitively against normalized allowlist entries', () => {
    expect(() =>
      validateStartupGuards({
        ...BASE_CONFIG,
        hostsNamespace: 'MCP-HOST',
        sandboxNamespace: 'SANDBOX-RECIPES',
      })
    ).not.toThrow()
  })
})
