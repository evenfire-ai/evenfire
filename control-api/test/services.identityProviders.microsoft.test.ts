import { describe, expect, it, vi } from 'vitest'
import {
  MICROSOFT_PROVIDER_SCOPES,
  buildMicrosoftAuthorizeUrl,
  createPkceChallenge,
  listMicrosoftUsers,
} from '../src/services/identityProviders/microsoft.js'

const TENANT_ID = '11111111-1111-1111-1111-111111111111'
const CLIENT_ID = '22222222-2222-2222-2222-222222222222'

describe('Microsoft identity provider client', () => {
  it('builds an authorization-code request with PKCE and required Graph scopes', () => {
    const authorizeUrl = new URL(
      buildMicrosoftAuthorizeUrl({
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        redirectUri: 'https://api.example.test/api/v1/identity-provider-callback/microsoft',
        state: 'state-value',
        codeChallenge: 'challenge-value',
      })
    )

    expect(authorizeUrl.origin).toBe('https://login.microsoftonline.com')
    expect(authorizeUrl.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`)
    expect(authorizeUrl.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code')
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizeUrl.searchParams.get('state')).toBe('state-value')
    expect(authorizeUrl.searchParams.get('scope')?.split(' ')).toEqual(
      Array.from(MICROSOFT_PROVIDER_SCOPES)
    )
    expect(MICROSOFT_PROVIDER_SCOPES).toContain('User.Read.All')
    expect(MICROSOFT_PROVIDER_SCOPES).toContain('GroupMember.Read.All')
  })

  it('derives an RFC 7636 S256 challenge', () => {
    expect(createPkceChallenge('test-verifier')).toBe('JBbiqONGWPaAmwXk_8bT6UnlPfrn65D32eZlJS-zGG0')
  })

  it('normalizes users and follows Graph pagination on the Graph origin only', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'user-1',
                displayName: 'User One',
                mail: 'USER.ONE@EXAMPLE.COM',
                userPrincipalName: 'USER.ONE@EXAMPLE.COM',
                accountEnabled: true,
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=next-page',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'user-2',
                displayName: 'User Two',
                mail: null,
                userPrincipalName: 'USER.TWO@EXAMPLE.COM',
                accountEnabled: false,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )

    const users = await listMicrosoftUsers('access-token', fetchFn)

    expect(users).toEqual([
      {
        id: 'user-1',
        displayName: 'User One',
        mail: 'user.one@example.com',
        userPrincipalName: 'user.one@example.com',
        accountEnabled: true,
      },
      {
        id: 'user-2',
        displayName: 'User Two',
        mail: '',
        userPrincipalName: 'user.two@example.com',
        accountEnabled: false,
      },
    ])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('rejects a Graph continuation URL that crosses the trust boundary', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [],
          '@odata.nextLink': 'https://attacker.example.test/collect',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    await expect(listMicrosoftUsers('access-token', fetchFn)).rejects.toThrow(
      'invalid continuation URL'
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries throttled Graph requests using Retry-After', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'throttled' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

    await expect(listMicrosoftUsers('access-token', fetchFn)).resolves.toEqual([])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
