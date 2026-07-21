import { describe, expect, it, vi } from 'vitest'
import { mintRecipeHostGfsToken } from './gfsBinding'

/**
 * P4-S05 — WRC 3rd-party host gfs token. WRC mints host:3rd:<recipeNs>/<name>
 * for a recipe's mcp-host; read scope; fail-loud on error.
 */

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function jwt(payload: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.unverified-signature`
}

const expectedSubject = 'host:3rd:sandbox-recipes/my-recipe'

function validBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: jwt({ sub: expectedSubject, scopes: ['gfs.read'] }),
    expiresInSeconds: 300,
    subject: expectedSubject,
    ...overrides,
  }
}

describe('mintRecipeHostGfsToken', () => {
  it('returns a token only for the exact requested recipe subject', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: jwt({ sub: expectedSubject, scopes: ['gfs.read'] }),
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

  it('fails closed when control-api returns a different recipe subject', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: 'tok',
        expiresInSeconds: 300,
        subject: 'host:3rd:sandbox-recipes/other-recipe',
      })
    ) as unknown as typeof fetch

    await expect(
      mintRecipeHostGfsToken('sandbox-recipes', 'my-recipe', {
        controlApiBaseUrl: 'http://control-api:8090',
        signToken: () => 'wrc-jwt',
        fetchFn,
      })
    ).rejects.toThrow(
      'gfs recipe host token subject mismatch: expected host:3rd:sandbox-recipes/my-recipe, received host:3rd:sandbox-recipes/other-recipe'
    )
  })

  it('passes explicit recipe host scopes to control-api', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: jwt({ sub: expectedSubject, scopes: ['gfs.read', 'gfs.write'] }),
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

  describe('issued token claims', () => {
    it.each([
      ['a non-JWT token', 'opaque-token', 'not a well-formed JWT'],
      [
        'a JWT with an empty signature',
        `${jwt({}).split('.').slice(0, 2).join('.')}.`,
        'not a well-formed JWT',
      ],
      ['a JWT with invalid base64url', 'header.%%%.signature', 'not a well-formed JWT'],
      ['a JWT with malformed JSON', 'header.bm90LWpzb24.signature', 'malformed JWT payload'],
      ['a JWT with a non-object payload', jwt(['not-an-object']), 'malformed JWT payload'],
    ])('fails closed for %s', async (_description, token, expectedError) => {
      const fetchFn = vi.fn(async () =>
        okResponse(validBinding({ token }))
      ) as unknown as typeof fetch

      await expect(
        mintRecipeHostGfsToken('sandbox-recipes', 'my-recipe', {
          controlApiBaseUrl: 'http://control-api:8090',
          signToken: () => 'wrc-jwt',
          fetchFn,
        })
      ).rejects.toThrow(expectedError)
    })

    it('fails closed when the JWT subject differs from the exact response subject', async () => {
      const fetchFn = vi.fn(async () =>
        okResponse(
          validBinding({
            token: jwt({
              sub: 'host:3rd:sandbox-recipes/other-recipe',
              scopes: ['gfs.read'],
            }),
          })
        )
      ) as unknown as typeof fetch

      await expect(
        mintRecipeHostGfsToken('sandbox-recipes', 'my-recipe', {
          controlApiBaseUrl: 'http://control-api:8090',
          signToken: () => 'wrc-jwt',
          fetchFn,
        })
      ).rejects.toThrow(
        'gfs recipe host token claim subject mismatch: expected host:3rd:sandbox-recipes/my-recipe, received host:3rd:sandbox-recipes/other-recipe'
      )
    })

    it.each([
      ['missing', undefined],
      ['not an array', 'gfs.read'],
      ['missing requested write scope', ['gfs.read']],
      ['extra scope', ['gfs.read', 'gfs.write', 'gfs.delete']],
      ['different order', ['gfs.write', 'gfs.read']],
      ['duplicate scope', ['gfs.read', 'gfs.read', 'gfs.write']],
    ])('fails closed when JWT scopes are %s', async (_description, scopes) => {
      const fetchFn = vi.fn(async () =>
        okResponse(
          validBinding({
            token: jwt({ sub: expectedSubject, scopes }),
          })
        )
      ) as unknown as typeof fetch

      await expect(
        mintRecipeHostGfsToken('sandbox-recipes', 'my-recipe', {
          controlApiBaseUrl: 'http://control-api:8090',
          signToken: () => 'wrc-jwt',
          fetchFn,
          scopes: ['gfs.read', 'gfs.write'],
        })
      ).rejects.toThrow('gfs recipe host token claim scopes do not exactly match requested scopes')
    })
  })
})
