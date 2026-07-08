import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MCP_SERVER_SECRET_NAMESPACE,
  DEFAULT_SANDBOX_SECRET_NAMESPACE,
  deriveMcpServerNs,
  resolveRecipeSecretNamespaces,
} from '../recipeSecretNamespaces'

describe('deriveMcpServerNs', () => {
  it('maps the bare sandbox namespace to the bare mcp-server namespace', () => {
    expect(deriveMcpServerNs('sandbox-recipes')).toBe('mcp-server')
  })

  it('preserves the tenant suffix (prefix-swap)', () => {
    expect(deriveMcpServerNs('sandbox-recipes-acme')).toBe('mcp-server-acme')
    expect(deriveMcpServerNs('sandbox-recipes-admintest1')).toBe('mcp-server-admintest1')
  })

  it('falls back to the bare default for an unexpected base', () => {
    expect(deriveMcpServerNs('foo-recipes')).toBe('mcp-server')
    expect(deriveMcpServerNs('')).toBe('mcp-server')
  })
})

describe('resolveRecipeSecretNamespaces', () => {
  it('EDIT: derives both namespaces from the recipe namespace when nothing is fetched', () => {
    expect(resolveRecipeSecretNamespaces({ recipeNamespace: 'sandbox-recipes-acme' })).toEqual({
      sandbox: 'sandbox-recipes-acme',
      mcpServer: 'mcp-server-acme',
    })
  })

  it('EDIT: prefers the fetched mcpServer when it pairs with the recipe sandbox namespace', () => {
    expect(
      resolveRecipeSecretNamespaces({
        recipeNamespace: 'sandbox-recipes-acme',
        // server reports a non-prefix-swap pairing; recipe ns matches sandbox -> trust it
        fetched: { sandbox: 'sandbox-recipes-acme', mcpServer: 'mcp-servers-acme' },
      })
    ).toEqual({ sandbox: 'sandbox-recipes-acme', mcpServer: 'mcp-servers-acme' })
  })

  it('EDIT: ignores a stale/old-backend fetched pair that does not match the recipe namespace, derives instead', () => {
    // Old control-api with no namespaces field -> getControlUINamespaces returns bare defaults.
    // The recipe lives in the tenant namespace, so we must derive, not use the bare fetched pair.
    expect(
      resolveRecipeSecretNamespaces({
        recipeNamespace: 'sandbox-recipes-acme',
        fetched: { sandbox: 'sandbox-recipes', mcpServer: 'mcp-server' },
      })
    ).toEqual({ sandbox: 'sandbox-recipes-acme', mcpServer: 'mcp-server-acme' })
  })

  it('CREATE: uses the fetched pair when no recipe namespace is known', () => {
    expect(
      resolveRecipeSecretNamespaces({
        fetched: { sandbox: 'sandbox-recipes-acme', mcpServer: 'mcp-server-acme' },
      })
    ).toEqual({ sandbox: 'sandbox-recipes-acme', mcpServer: 'mcp-server-acme' })
  })

  it('CREATE: falls back to bare defaults when nothing is fetched (single-tenant / old backend)', () => {
    expect(resolveRecipeSecretNamespaces({})).toEqual({
      sandbox: DEFAULT_SANDBOX_SECRET_NAMESPACE,
      mcpServer: DEFAULT_MCP_SERVER_SECRET_NAMESPACE,
    })
  })

  it('single-tenant EDIT collapses to the bare defaults (backward compatible)', () => {
    expect(resolveRecipeSecretNamespaces({ recipeNamespace: 'sandbox-recipes' })).toEqual({
      sandbox: 'sandbox-recipes',
      mcpServer: 'mcp-server',
    })
  })

  it('treats blank/whitespace recipe namespace as absent', () => {
    expect(
      resolveRecipeSecretNamespaces({
        recipeNamespace: '   ',
        fetched: { sandbox: 'sandbox-recipes-acme', mcpServer: 'mcp-server-acme' },
      })
    ).toEqual({ sandbox: 'sandbox-recipes-acme', mcpServer: 'mcp-server-acme' })
  })
})
