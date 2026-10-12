import { describe, expect, it } from 'vitest'
import { type McpServerResource, normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'

/**
 * T5 (E-19.2): normalizeMcpServerOwnerDecl treats an ABSENT clientSecretRef as a
 * valid public client (decl carries `clientSecretRef: undefined`), keeps a
 * PRESENT-but-malformed ref fail-closed (null), and still requires a well-formed
 * clientIdRef.
 */
function server(oauth: Record<string, unknown> | undefined): McpServerResource {
  return {
    metadata: { name: 'srv', namespace: 'mcp-servers' },
    spec: oauth === undefined ? {} : { oauth: oauth as never },
  }
}

const CLIENT_ID_REF = { name: 'creds', key: 'client-id' }
const CLIENT_SECRET_REF = { name: 'creds', key: 'client-secret' }

describe('normalizeMcpServerOwnerDecl', () => {
  it('public client (no clientSecretRef) → decl with clientSecretRef undefined', () => {
    const result = normalizeMcpServerOwnerDecl(
      server({ id: 'oc', provider: 'google', clientIdRef: CLIENT_ID_REF })
    )
    expect(result).not.toBeNull()
    const decl = result!.spec!.oauthClients![0]
    expect(decl.id).toBe('oc')
    expect(decl.provider).toBe('google')
    expect(decl.clientIdRef).toEqual(CLIENT_ID_REF)
    expect(decl.clientSecretRef).toBeUndefined()
    expect('clientSecretRef' in decl).toBe(true)
  })

  it('confidential client (both refs) → full decl', () => {
    const result = normalizeMcpServerOwnerDecl(
      server({
        id: 'oc',
        provider: 'notion',
        clientIdRef: CLIENT_ID_REF,
        clientSecretRef: CLIENT_SECRET_REF,
      })
    )
    expect(result).not.toBeNull()
    const decl = result!.spec!.oauthClients![0]
    expect(decl.clientIdRef).toEqual(CLIENT_ID_REF)
    expect(decl.clientSecretRef).toEqual(CLIENT_SECRET_REF)
  })

  it('malformed clientSecretRef (name not a string) → null (fail closed)', () => {
    const result = normalizeMcpServerOwnerDecl(
      server({
        id: 'oc',
        provider: 'google',
        clientIdRef: CLIENT_ID_REF,
        clientSecretRef: { name: 123, key: 'client-secret' },
      })
    )
    expect(result).toBeNull()
  })

  it('clientSecretRef: null (JSON-null from untrusted CR) → public client, never throws', () => {
    // Guard against a `!== undefined` check, which would enter the branch and
    // dereference null (TypeError → opaque 500 on the refresh path). `!= null`
    // treats a JSON-null ref from the untrusted CR as absent (public client),
    // so a malformed-as-null ref never crashes the reader.
    const result = normalizeMcpServerOwnerDecl(
      server({
        id: 'oc',
        provider: 'google',
        clientIdRef: CLIENT_ID_REF,
        clientSecretRef: null,
      })
    )
    expect(result).not.toBeNull()
    expect(result!.spec!.oauthClients![0].clientSecretRef).toBeUndefined()
  })

  it('missing clientIdRef → null', () => {
    const result = normalizeMcpServerOwnerDecl(server({ id: 'oc', provider: 'google' }))
    expect(result).toBeNull()
  })

  it('no spec.oauth → null', () => {
    expect(normalizeMcpServerOwnerDecl(server(undefined))).toBeNull()
  })
})
