import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogPolicyCase, catalogPolicyError } from '../../test/fixtures/llmProviderCatalogPolicy'
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
    const providers = [catalogPolicyCase('openai.default'), catalogPolicyCase('azure.default')]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ providers }))

    await expect(getLlmProviderCatalogPolicies()).resolves.toEqual(providers)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-providers/catalog-policy')
  })

  it('PUTs `{ auto_enable }` to the provider path and returns the saved entry', async () => {
    const saved = catalogPolicyCase('groq.override_on')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(saved))

    await expect(setLlmProviderCatalogAutoEnable('groq', true)).resolves.toEqual(saved)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-providers/groq/catalog-policy')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ auto_enable: true })
  })

  it('sends an explicit false rather than dropping the body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(catalogPolicyCase('openai.override_off')))

    await setLlmProviderCatalogAutoEnable('openai', false)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ auto_enable: false })
  })

  it('resets to the default by sending an explicit null, not an empty body', async () => {
    const reset = catalogPolicyCase('openai.reset')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(reset))

    await expect(setLlmProviderCatalogAutoEnable('openai', null)).resolves.toEqual(reset)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-providers/openai/catalog-policy')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ auto_enable: null })
  })

  it('encodes the provider segment of the path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(catalogPolicyError('not_found').body, 404))

    await setLlmProviderCatalogAutoEnable('a/b c', null).catch(() => undefined)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-providers/a%2Fb%20c/catalog-policy')
  })

  it('recognises the 503 refusal of a reset like that of a toggle', async () => {
    const { status, body } = catalogPolicyError('catalog_sync_in_progress')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, status))
    const caught = await setLlmProviderCatalogAutoEnable('openai', null).catch(e => e)
    expect(isCatalogSyncInProgressError(caught)).toBe(true)
  })

  it('recognises the 503 catalog_sync_in_progress refusal by its code', async () => {
    const { status, body } = catalogPolicyError('catalog_sync_in_progress')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, status))
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
      jsonResponse(catalogPolicyError('not_found').body, catalogPolicyError('not_found').status)
    )
    const missing = await setLlmProviderCatalogAutoEnable('codex', false).catch(e => e)
    expect(isCatalogSyncInProgressError(missing)).toBe(false)
  })
})
