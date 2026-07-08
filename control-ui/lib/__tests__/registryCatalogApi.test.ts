import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRegistryCatalog, getRegistryEntryVersion } from '../api'

function makeRes(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: async () => body,
    text: async () => JSON.stringify(body ?? ''),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

// The registry's `tags` column is nullable, so a catalog row can arrive with
// `tags: null`. RegistryCatalog / the entry detail page call entry.tags.length /
// .some / .map directly, so a null crashes the whole page with
// "Cannot read properties of null (reading 'length')". Coerce tags to an array
// at the wrapper boundary so RegistryEntry.tags is always a real array.
describe('registry catalog api — tags coercion', () => {
  const baseEntry = {
    id: '1',
    name: '@evenfire-dev/e2eprobe',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'probe',
    author: 'x',
    origin: 'x',
    category: 'utility',
    trust_level: 'low',
    quality_tier: 'unverified',
    status: 'published',
    server_mode: null,
    transport: null,
    recipe_type: null,
    mcp_server_meta: null,
    recipe_meta: null,
    artifact_refs: null,
    downloads: 0,
    installs: 0,
    created_at: '2026-07-01',
  }

  it('getRegistryCatalog coerces a null `tags` field to an empty array', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(200, {
        data: [{ ...baseEntry, tags: null }],
        categories: [],
        installed: { catalogKeys: [], serverNames: [], recipeKeys: [] },
      })
    )
    const res = await getRegistryCatalog()
    expect(res.data[0].tags).toEqual([])
  })

  it('getRegistryCatalog leaves a real tags array untouched', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes(200, {
        data: [{ ...baseEntry, tags: ['db', 'sql'] }],
        categories: [],
        installed: { catalogKeys: [], serverNames: [], recipeKeys: [] },
      })
    )
    const res = await getRegistryCatalog()
    expect(res.data[0].tags).toEqual(['db', 'sql'])
  })

  it('getRegistryEntryVersion coerces a null `tags` field to an empty array', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(200, { ...baseEntry, tags: null }))
    const res = await getRegistryEntryVersion('@evenfire-dev/e2eprobe', '1.0.0')
    expect(res.tags).toEqual([])
  })
})
