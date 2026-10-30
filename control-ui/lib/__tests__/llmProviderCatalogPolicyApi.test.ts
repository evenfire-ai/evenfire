import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_POLICY_NOT_FOUND_BODY,
  CATALOG_SYNC_IN_PROGRESS_BODY,
  buildCatalogPolicy,
} from '../../test/fixtures/llmProviderCatalogPolicy'
import {
  getLlmProviderCatalogPolicies,
  isCatalogSyncInProgressError,
  setLlmProviderCatalogAutoEnable,
} from '../api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('llm provider catalog-policy api helpers', () => {
  it('GETs the policy list and unwraps `providers`', async () => {
    const providers = [buildCatalogPolicy('openai'), buildCatalogPolicy('azure')]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ providers }))

    await expect(getLlmProviderCatalogPolicies()).resolves.toEqual(providers)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-providers/catalog-policy')
  })

  it('PUTs `{ auto_enable }` to the provider path and returns the saved entry', async () => {
    const saved = buildCatalogPolicy('openrouter', {
      auto_enable: true,
      updated_at: '2026-10-30T10:00:00.000Z',
      updated_by: 'admin',
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(saved))

    await expect(setLlmProviderCatalogAutoEnable('openrouter', true)).resolves.toEqual(saved)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-providers/openrouter/catalog-policy')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ auto_enable: true })
  })

  it('sends an explicit false rather than dropping the body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(buildCatalogPolicy('openai')))

    await setLlmProviderCatalogAutoEnable('openai', false)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ auto_enable: false })
  })

  it('recognises the 503 catalog_sync_in_progress refusal by its code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(CATALOG_SYNC_IN_PROGRESS_BODY, 503)
    )
    const caught = await setLlmProviderCatalogAutoEnable('openai', false).catch(e => e)
    expect(isCatalogSyncInProgressError(caught)).toBe(true)
  })

  it('does not treat a bare gateway 503 or a 404 as a running sync', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('upstream unavailable', { status: 503 })
    )
    const gateway = await setLlmProviderCatalogAutoEnable('openai', false).catch(e => e)
    expect(isCatalogSyncInProgressError(gateway)).toBe(false)

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(CATALOG_POLICY_NOT_FOUND_BODY, 404)
    )
    const missing = await setLlmProviderCatalogAutoEnable('codex', false).catch(e => e)
    expect(isCatalogSyncInProgressError(missing)).toBe(false)
  })
})
