import assert from 'node:assert/strict'
import test from 'node:test'
import { EXTERNAL_REST_API_BASE_URL } from '../app/constants/api'
import {
  type ConnectedAccount,
  describeGrantSource,
  listConnectedAccounts,
  revokeConnectedAccount,
} from '../lib/connectedAccounts'

const recipeGrant: ConnectedAccount = {
  ownerKind: 'recipe',
  recipeNamespace: 'team-ns',
  recipeName: 'calendar-plugin',
  oauthClientId: 'google',
  provider: 'google',
  background: true,
  updatedAt: '2026-09-20T00:00:00.000Z',
}

// mcp-server grant on the remote lane: oauthClientId is a self-URL that must be
// URL-encoded segment-by-segment, and provider is the raw 'remote' token.
const mcpServerGrant: ConnectedAccount = {
  ownerKind: 'mcpserver',
  recipeNamespace: 'servers-ns',
  recipeName: 'acme-remote',
  mcpServerName: 'acme-remote',
  oauthClientId: 'https://acme.example.com/oauth/callback',
  provider: 'remote',
  background: false,
  updatedAt: '2026-09-20T00:00:00.000Z',
}

test('revokeConnectedAccount routes an mcpserver grant with ?ownerKind=mcpserver and encoded segments', async () => {
  const previousFetch = globalThis.fetch
  let request: { url: string; init?: RequestInit } | undefined
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init }
    return new Response(null, { status: 204 })
  }) as typeof fetch
  try {
    await revokeConnectedAccount(mcpServerGrant)
    assert.ok(request)
    assert.equal(request.init?.method, 'DELETE')
    const expected =
      `${EXTERNAL_REST_API_BASE_URL}/api/v1/oauth/grants/` +
      `${encodeURIComponent('servers-ns')}/${encodeURIComponent('acme-remote')}/` +
      `${encodeURIComponent('https://acme.example.com/oauth/callback')}` +
      `?ownerKind=mcpserver`
    assert.equal(request.url, expected)
    // The raw self-URL must be percent-encoded, never sent as path separators.
    assert.ok(request.url.includes('https%3A%2F%2Facme.example.com%2Foauth%2Fcallback'))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('revokeConnectedAccount keeps the recipe lane byte-compatible with ?ownerKind=recipe', async () => {
  const previousFetch = globalThis.fetch
  let request: { url: string; init?: RequestInit } | undefined
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init }
    return new Response(null, { status: 204 })
  }) as typeof fetch
  try {
    await revokeConnectedAccount(recipeGrant)
    assert.ok(request)
    assert.equal(request.init?.method, 'DELETE')
    assert.equal(
      request.url,
      `${EXTERNAL_REST_API_BASE_URL}/api/v1/oauth/grants/team-ns/calendar-plugin/google?ownerKind=recipe`
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('describeGrantSource hides the raw remote/generic provider token for mcp-server grants', () => {
  assert.deepEqual(describeGrantSource(mcpServerGrant), {
    typeLabel: 'MCP server',
    detail: null,
  })
  assert.deepEqual(describeGrantSource({ ...mcpServerGrant, provider: 'generic' }), {
    typeLabel: 'MCP server',
    detail: null,
  })
})

test('describeGrantSource shows a baked mcp-server provider and the recipe provider', () => {
  assert.deepEqual(describeGrantSource({ ...mcpServerGrant, provider: 'clickup' }), {
    typeLabel: 'MCP server',
    detail: 'clickup',
  })
  assert.deepEqual(describeGrantSource(recipeGrant), {
    typeLabel: 'Plugin',
    detail: 'google',
  })
})

test('listConnectedAccounts defaults a missing ownerKind to recipe', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        grants: [
          { recipeNamespace: 'ns', recipeName: 'legacy', oauthClientId: 'c', provider: 'p' },
          { ...mcpServerGrant },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch
  try {
    const accounts = await listConnectedAccounts()
    assert.equal(accounts[0]?.ownerKind, 'recipe')
    assert.equal(accounts[1]?.ownerKind, 'mcpserver')
  } finally {
    globalThis.fetch = previousFetch
  }
})
