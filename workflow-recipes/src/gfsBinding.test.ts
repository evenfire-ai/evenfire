import { describe, expect, it, vi } from 'vitest'
import { mintRecipeHostGfsToken } from './gfsBinding'

/**
 * P4-S05 — WRC 3rd-party host gfs token. WRC mints host:3rd:<recipeNs>/<name>
 * for a recipe's mcp-host; read scope; fail-loud on error.
 */

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

describe('mintRecipeHostGfsToken', () => {
  it('POSTs to the provisioner route for the recipe with the WRC bearer', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: 'tok',
        expiresInSeconds: 300,
        subject: 'host:3rd:sandbox-recipes/my-recipe',
      })
    ) as unknown as typeof fetch
    const out = await mintRecipeHostGfsToken('sandbox-recipes', 'my-recipe', {
      controlApiBaseUrl: 'http://control-api:8090',
      signToken: () => 'wrc-jwt',
      fetchFn,
    })

    expect(out.subject).toBe('host:3rd:sandbox-recipes/my-recipe')
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://control-api:8090/api/v1/auth/gfs/my-recipe/tokens')
    expect(init.headers.Authorization).toBe('Bearer wrc-jwt')
    expect(JSON.parse(init.body)).toEqual({ namespace: 'sandbox-recipes', scopes: ['gfs.read'] })
  })

  it('passes explicit recipe host scopes to control-api', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: 'tok',
        expiresInSeconds: 300,
        subject: 'host:3rd:sandbox-recipes/my-recipe',
      })
    ) as unknown as typeof fetch

    await mintRecipeHostGfsToken('sandbox-recipes', 'my-recipe', {
      controlApiBaseUrl: 'http://control-api:8090',
      signToken: () => 'wrc-jwt',
      fetchFn,
      scopes: ['gfs.read', 'gfs.write'],
    })

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      namespace: 'sandbox-recipes',
      scopes: ['gfs.read', 'gfs.write'],
    })
  })

  it('fails loud on a non-2xx response', async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 403 }) as Response
    ) as unknown as typeof fetch
    await expect(
      mintRecipeHostGfsToken('sandbox-recipes', 'r', {
        controlApiBaseUrl: 'http://x',
        signToken: () => 'j',
        fetchFn,
      })
    ).rejects.toThrow(/403/)
  })
})
