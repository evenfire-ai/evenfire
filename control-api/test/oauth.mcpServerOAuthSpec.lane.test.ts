import { describe, expect, it } from 'vitest'
import {
  type McpServerOAuthDecl,
  readOAuthLane,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../src/oauth/mcpServerOAuthSpec.js'
import { normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'
import { bakedOAuth, genericOAuth } from './fixtures/legacyOAuthGrant.js'

/**
 * One classifier decides the OAuth lane of a McpServer for every reader. Only a
 * baked CR (no `source`) carries `legacyProvider`, the only thing that lets a key
 * see unsealed legacy grants. An unrecognised `source` keeps the baked decl shape
 * for the consent/refresh readers (unchanged behaviour) but never qualifies.
 */

const server = (oauth: Record<string, unknown>) => ({
  metadata: { uid: 'uid-1', name: 'srv' },
  spec: { contextRef: 'ctx-1', oauth },
})

describe('readOAuthLane', () => {
  it.each<[unknown, string]>([
    [undefined, 'baked'],
    [null, 'baked'],
    ['remote', 'remote'],
    ['generic', 'generic'],
    ['', 'unknown'],
    ['foo', 'unknown'],
    ['Remote', 'unknown'],
    [42, 'unknown'],
  ])('source=%j → %s', (source, lane) => {
    expect(readOAuthLane({ source } as McpServerOAuthDecl)).toBe(lane)
  })
})

describe('legacyProvider on the resolved coordinate', () => {
  it('a baked CR carries its provider', () => {
    expect(resolveServerOAuth(server(bakedOAuth('google', 'user')))?.legacyProvider).toBe('google')
  })

  it('a generic CR carries none', () => {
    expect(resolveServerOAuth(server(genericOAuth('user')))).not.toHaveProperty('legacyProvider')
  })

  it.each(['', 'foo'])('source=%j carries none, even with a provider on the CR', source => {
    const resolved = resolveServerOAuth(server({ ...bakedOAuth('google', 'user'), source }))
    expect(resolved).not.toBeNull()
    expect(resolved).not.toHaveProperty('legacyProvider')
  })

  it.each(['', 'foo'])(
    'source=%j keeps the baked decl in the consent and refresh readers',
    source => {
      const oauth = { ...bakedOAuth('google', 'user'), source }
      const baked = bakedOAuth('google', 'user')
      expect(resolveServerOAuthSubject(server(oauth), 'consent')?.decl).toEqual(
        resolveServerOAuthSubject(server(baked), 'consent')?.decl
      )
      expect(normalizeMcpServerOwnerDecl(server(oauth))?.spec?.oauthClients).toEqual(
        normalizeMcpServerOwnerDecl(server(baked))?.spec?.oauthClients
      )
    }
  )
})
