/**
 * E2E: Context Mapper — verify the PR 1 route and disclosure boundaries.
 */
import { describe, expect, it } from 'vitest'
import { CTX_MAPPER_URL, getGlobalMcpInventory } from '../helpers.js'

describe('Context Mapper', () => {
  it('retains only the metadata-only global v1 inventory for the PR 2 proxy migration', async () => {
    const data = await getGlobalMcpInventory()
    expect(data.servers).toBeDefined()
    expect(Array.isArray(data.servers)).toBe(true)
    expect(data.contextRef).toBe('*')
    for (const server of data.servers) {
      expect(server).not.toHaveProperty('auth')
      expect(server).not.toHaveProperty('secretRef')
      expect(server).not.toHaveProperty('secretKey')
    }
  })

  it.each([
    '/api/v1/mcpservers/context/context1',
    '/api/v1/mcpservers/server-from-another-context/auth',
  ])('tombstones caller-selected legacy Host route %s', async path => {
    const response = await fetch(`${CTX_MAPPER_URL}${path}`)

    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toContain('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'gone' })
  })

  it('rejects the v2 Host inventory without an authenticated Host JWT', async () => {
    const response = await fetch(`${CTX_MAPPER_URL}/api/v2/hosts/self/mcpservers`)

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toContain('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' })
  })
})
