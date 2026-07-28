import { describe, expect, it, vi } from 'vitest'
import {
  GfsClient,
  type GfsTransport,
  GfsUriError,
  type ResolvedGfsResource,
  parseGfsUri,
  parseSubjectKey,
} from '../src/gfs/uriHandler.js'
import { ApiError } from '../src/httpClient.js'

/**
 * P2-S06 — Desktop gfs:// resolve + read. Acceptance: a gfs://<drive>/<rid> link
 * opens/downloads via the API (no local mirror). The URI grammar must match the
 * backend resolver.
 */

const RID = '0123456789abcdef0123456789abcdef'

describe('parseGfsUri', () => {
  it('parses the identity form (single 32-hex segment is always the rid)', () => {
    expect(parseGfsUri(`gfs://main/${RID}`)).toEqual({ drive: 'main', rid: RID, byPath: null })
  })

  it('parses the human form with a trailing -<rid>', () => {
    expect(parseGfsUri(`gfs://main/org/report-${RID}`)).toEqual({
      drive: 'main',
      rid: RID,
      byPath: '/org/report-' + RID,
    })
  })

  it('parses a pure by-path form (no trailing rid)', () => {
    expect(parseGfsUri('gfs://main/org/report.md')).toEqual({
      drive: 'main',
      rid: null,
      byPath: '/org/report.md',
    })
  })

  it('rejects a non-gfs URI and a too-short URI', () => {
    expect(() => parseGfsUri('https://x/y')).toThrow(GfsUriError)
    expect(() => parseGfsUri('gfs://main')).toThrow(GfsUriError)
  })
})

const RESOURCE: ResolvedGfsResource = {
  drive: 'main',
  resourceId: RID,
  parentResourceId: null,
  rid: RID,
  gfsUri: `gfs://main/${RID}`,
  name: 'report.md',
  kind: 'file',
  pathCache: '/org/report.md',
  version: 1,
  bytes: 5,
}

function transport(overrides?: Partial<GfsTransport>): GfsTransport {
  return {
    baseUrl: 'https://api.example/',
    requestJson: vi.fn(async () => ({ ok: true, data: RESOURCE })) as GfsTransport['requestJson'],
    fetchBytes: vi.fn(
      async () => new TextEncoder().encode('hello').buffer
    ) as GfsTransport['fetchBytes'],
    ...overrides,
  }
}

describe('GfsClient.resolveUri', () => {
  it('resolves via the user gfs API with the bearer token and unwraps the envelope', async () => {
    const t = transport()
    const out = await new GfsClient(t).resolveUri(`gfs://main/${RID}`, 'tok')
    expect(out).toEqual(RESOURCE)
    expect(t.requestJson).toHaveBeenCalledWith(
      'GET',
      `https://api.example/api/v1/me/gfs/resolve?uri=${encodeURIComponent(`gfs://main/${RID}`)}`,
      { token: 'tok' }
    )
  })

  it('fails fast on a malformed URI before any round-trip', async () => {
    const t = transport()
    await expect(new GfsClient(t).resolveUri('not-a-uri', 'tok')).rejects.toBeInstanceOf(
      GfsUriError
    )
    expect(t.requestJson).not.toHaveBeenCalled()
  })

  it('surfaces an API error envelope as a GfsUriError (e.g. a revoked grant)', async () => {
    const t = transport({
      requestJson: vi.fn(async () => ({
        ok: false,
        error: { code: 'forbidden', message: 'denied' },
      })) as GfsTransport['requestJson'],
    })
    await expect(new GfsClient(t).resolveUri(`gfs://main/${RID}`, 'tok')).rejects.toThrow(
      /forbidden/
    )
  })
})

describe('GfsClient.download', () => {
  it('resolves then fetches the bytes through the brokered proxy', async () => {
    const t = transport()
    const { resource, bytes } = await new GfsClient(t).download(`gfs://main/${RID}`, 'tok')
    expect(resource).toEqual(RESOURCE)
    expect(new TextDecoder().decode(bytes)).toBe('hello')
    expect(t.fetchBytes).toHaveBeenCalledWith(
      `https://api.example/api/v1/me/gfs/proxy/${RID}?drive=main`,
      'tok'
    )
  })
})

const CHILD = {
  resourceId: RID,
  rid: RID,
  gfsUri: `gfs://main/${RID}`,
  drive: 'main',
  parentResourceId: null,
  name: 'report.md',
  kind: 'file' as const,
  path: '/org/report.md',
  version: 1,
  bytes: 5,
}

describe('GfsClient.listChildren', () => {
  it('lists children via the user gfs API and unwraps the gfsc envelope', async () => {
    const requestJson = vi.fn(async () => ({
      ok: true,
      data: { items: [CHILD], nextCursor: 'cur2' },
    })) as GfsTransport['requestJson']
    const out = await new GfsClient(transport({ requestJson })).listChildren(RID, 'tok', {
      drive: 'main',
      cursor: 'cur1',
    })
    expect(out).toEqual({ items: [CHILD], nextCursor: 'cur2' })
    const [method, url, opts] = (requestJson as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(method).toBe('GET')
    expect(url).toBe(
      `https://api.example/api/v1/me/gfs/resources/${RID}/children?drive=main&cursor=cur1`
    )
    expect(opts).toEqual({ token: 'tok' })
  })
})

describe('GfsClient.listAccessible', () => {
  it('lists readable GFS resources for the current user session', async () => {
    const requestJson = vi.fn(async () => ({
      ok: true,
      data: {
        items: [{ ...CHILD, sources: ['grant'], permissions: ['read'], coversDescendants: true }],
        nextCursor: null,
      },
    })) as GfsTransport['requestJson']
    const out = await new GfsClient(transport({ requestJson })).listAccessible('tok', {
      drive: 'main',
      cursor: 'cur1',
    })
    expect(out.items[0]).toMatchObject({
      resourceId: RID,
      sources: ['grant'],
      coversDescendants: true,
    })
    expect(requestJson).toHaveBeenCalledWith(
      'GET',
      'https://api.example/api/v1/me/gfs/resources?drive=main&cursor=cur1',
      { token: 'tok' }
    )
  })
})

describe('GfsClient.affordances', () => {
  it('returns the held bits directly (NOT enveloped)', async () => {
    const requestJson = vi.fn(async () => ({
      held: ['read', 'manage_acl'],
      isOperator: false,
    })) as GfsTransport['requestJson']
    const out = await new GfsClient(transport({ requestJson })).affordances(RID, 'tok')
    expect(out).toEqual({ held: ['read', 'manage_acl'], isOperator: false })
    expect(requestJson).toHaveBeenCalledWith(
      'GET',
      `https://api.example/api/v1/me/gfs/resources/${RID}/affordances?drive=main`,
      { token: 'tok' }
    )
  })
})

describe('GfsClient.grant', () => {
  it('PUTs ONE bulk request with the subjects[] array + permissions', async () => {
    const requestJson = vi.fn(async () => ({ ok: true })) as GfsTransport['requestJson']
    await new GfsClient(transport({ requestJson })).grant(
      {
        resourceId: RID,
        subjects: [
          { type: 'user', id: 'u2' },
          { type: 'team', id: 't1' },
        ],
        permissions: ['read', 'write'],
      },
      'tok'
    )
    expect(requestJson).toHaveBeenCalledTimes(1)
    expect(requestJson).toHaveBeenCalledWith('PUT', 'https://api.example/api/v1/me/gfs/grants', {
      token: 'tok',
      body: {
        drive: 'main',
        resourceId: RID,
        subjects: [
          { type: 'user', id: 'u2' },
          { type: 'team', id: 't1' },
        ],
        permissions: ['read', 'write'],
        inherit: false,
      },
    })
  })

  it('passes inherit through to the API body (agent folder grants set it true)', async () => {
    const requestJson = vi.fn(async () => ({ ok: true })) as GfsTransport['requestJson']
    await new GfsClient(transport({ requestJson })).grant(
      {
        resourceId: RID,
        subjects: [{ type: 'host', id: '1st:mcp-host/chatllm' }],
        permissions: ['read'],
        inherit: true,
      },
      'tok'
    )
    expect(requestJson).toHaveBeenCalledWith('PUT', 'https://api.example/api/v1/me/gfs/grants', {
      token: 'tok',
      body: {
        drive: 'main',
        resourceId: RID,
        subjects: [{ type: 'host', id: '1st:mcp-host/chatllm' }],
        permissions: ['read'],
        inherit: true,
      },
    })
  })

  // FIX B — the server reports `invalidIndexes` (subjects_invalid / foreign_agent)
  // and `retryAfterSeconds` (429) as SEPARATE response-body fields. httpClient
  // stashes the raw body on ApiError.bodyText, but only `.message` survives the
  // Electron IPC boundary. GfsClient re-throws with those fields appended in the
  // exact shape gfsGrantErrors.ts (renderer) parses, so they reach the user.
  it('embeds invalidIndexes from the error body into the thrown message', async () => {
    const requestJson = vi.fn(async () => {
      throw new ApiError(
        '400 Bad Request: subjects_invalid',
        400,
        JSON.stringify({ error: 'subjects_invalid', invalidIndexes: [0, 2] })
      )
    }) as GfsTransport['requestJson']
    await expect(
      new GfsClient(transport({ requestJson })).grant(
        {
          resourceId: RID,
          subjects: [
            { type: 'user', id: 'u2' },
            { type: 'user', id: 'u3' },
            { type: 'team', id: 't1' },
          ],
          permissions: ['read'],
        },
        'tok'
      )
    ).rejects.toThrow(/subjects_invalid invalidIndexes=\[0,2\]/)
  })

  it('leaves the original error untouched when the body carries no structured fields', async () => {
    const original = new ApiError(
      '403 Forbidden: escalation_rejected',
      403,
      JSON.stringify({ error: 'escalation_rejected' })
    )
    const requestJson = vi.fn(async () => {
      throw original
    }) as GfsTransport['requestJson']
    await expect(
      new GfsClient(transport({ requestJson })).grant(
        { resourceId: RID, subjects: [{ type: 'user', id: 'u2' }], permissions: ['read'] },
        'tok'
      )
    ).rejects.toBe(original)
  })
})

const GRANT_ID = '11111111-2222-3333-4444-555555555555'

const GRANT_ITEM = {
  id: GRANT_ID,
  drive: 'main',
  resourceId: RID,
  subject: { type: 'host', id: '1st:mcp-host/chatllm' },
  permissions: ['read', 'write'],
  inherit: true,
}

describe('GfsClient.listGrants', () => {
  it('GETs the resource ACL and unwraps the items array (NOT enveloped)', async () => {
    const requestJson = vi.fn(async () => ({
      items: [GRANT_ITEM],
    })) as GfsTransport['requestJson']
    const out = await new GfsClient(transport({ requestJson })).listGrants(
      { resourceId: RID, drive: 'main' },
      'tok'
    )
    expect(out).toEqual([GRANT_ITEM])
    expect(requestJson).toHaveBeenCalledWith(
      'GET',
      `https://api.example/api/v1/me/gfs/grants?drive=main&resourceId=${RID}`,
      { token: 'tok' }
    )
  })

  it('defaults the drive when omitted', async () => {
    const requestJson = vi.fn(async () => ({ items: [] })) as GfsTransport['requestJson']
    await new GfsClient(transport({ requestJson })).listGrants({ resourceId: RID }, 'tok')
    expect(requestJson).toHaveBeenCalledWith(
      'GET',
      `https://api.example/api/v1/me/gfs/grants?drive=main&resourceId=${RID}`,
      { token: 'tok' }
    )
  })

  it('fails loud when the response carries no items array', async () => {
    const requestJson = vi.fn(async () => ({
      ok: false,
      error: { code: 'manage_acl_required', message: 'denied' },
    })) as GfsTransport['requestJson']
    await expect(
      new GfsClient(transport({ requestJson })).listGrants({ resourceId: RID }, 'tok')
    ).rejects.toBeInstanceOf(GfsUriError)
  })

  it('embeds retryAfterSeconds from a 429 body so the retry hint reaches the renderer', async () => {
    const requestJson = vi.fn(async () => {
      throw new ApiError(
        '429 Too Many Requests: Too Many Requests',
        429,
        JSON.stringify({ error: 'Too Many Requests', retryAfterSeconds: 45 })
      )
    }) as GfsTransport['requestJson']
    await expect(
      new GfsClient(transport({ requestJson })).listGrants({ resourceId: RID }, 'tok')
    ).rejects.toThrow(/429 .*retryAfterSeconds=45/)
  })
})

describe('GfsClient.revokeGrant', () => {
  it('DELETEs the grant by id with the bearer token', async () => {
    const requestJson = vi.fn(async () => ({ ok: true })) as GfsTransport['requestJson']
    await new GfsClient(transport({ requestJson })).revokeGrant(GRANT_ID, 'tok')
    expect(requestJson).toHaveBeenCalledWith(
      'DELETE',
      `https://api.example/api/v1/me/gfs/grants/${GRANT_ID}`,
      { token: 'tok' }
    )
  })

  it('rejects a non-UUID grant id before any round-trip (no path injection)', async () => {
    const t = transport()
    for (const bad of ['', 'not-a-uuid', '../grants', `${GRANT_ID}/extra`, 'main?x=1']) {
      await expect(new GfsClient(t).revokeGrant(bad, 'tok')).rejects.toThrow(
        /grant id must be a UUID/
      )
    }
    expect(t.requestJson).not.toHaveBeenCalled()
  })
})

describe('GfsClient.createShare', () => {
  it('POSTs ONE bulk read share for the subjects[] array', async () => {
    const requestJson = vi.fn(async () => ({ ok: true })) as GfsTransport['requestJson']
    await new GfsClient(transport({ requestJson })).createShare(
      {
        resourceId: RID,
        subjects: [
          { type: 'team', id: 't1' },
          { type: 'user', id: 'u2' },
        ],
        permissions: ['read'],
      },
      'tok'
    )
    expect(requestJson).toHaveBeenCalledTimes(1)
    expect(requestJson).toHaveBeenCalledWith('POST', 'https://api.example/api/v1/me/gfs/shares', {
      token: 'tok',
      body: {
        drive: 'main',
        resourceId: RID,
        subjects: [
          { type: 'team', id: 't1' },
          { type: 'user', id: 'u2' },
        ],
        permissions: ['read'],
        includeDescendants: false,
      },
    })
  })
})

describe('GfsClient resource mutations', () => {
  it('creates folders and files through the user plane', async () => {
    const requestJson = vi.fn(async () => ({
      ok: true,
      data: CHILD,
    })) as GfsTransport['requestJson']
    const client = new GfsClient(transport({ requestJson }))
    await client.createResource({ parentResourceId: RID, name: 'docs', kind: 'directory' }, 'tok')
    await client.createResource(
      { parentResourceId: RID, name: 'report.md', kind: 'file', encodedData: 'aGVsbG8=' },
      'tok'
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      'POST',
      `https://api.example/api/v1/me/gfs/resources/${RID}/children?drive=main`,
      { token: 'tok', body: { name: 'docs', kind: 'directory' } }
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      'POST',
      `https://api.example/api/v1/me/gfs/resources/${RID}/children?drive=main`,
      { token: 'tok', body: { name: 'report.md', kind: 'file', contentBase64: 'aGVsbG8=' } }
    )
  })

  it('replaces, renames, and deletes with If-Match through the user plane', async () => {
    const requestJson = vi.fn(async () => ({
      ok: true,
      data: CHILD,
    })) as GfsTransport['requestJson']
    const client = new GfsClient(transport({ requestJson }))
    await client.replaceFile({ resourceId: RID, encodedData: 'aGVsbG8=', ifMatch: 1 }, 'tok')
    await client.renameResource({ resourceId: RID, newName: 'renamed.md', ifMatch: 2 }, 'tok')
    await client.deleteResource({ resourceId: RID, ifMatch: 3 }, 'tok')
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      'PUT',
      `https://api.example/api/v1/me/gfs/resources/${RID}/content?drive=main`,
      { token: 'tok', body: { contentBase64: 'aGVsbG8=', ifMatch: 1 } }
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      'PATCH',
      `https://api.example/api/v1/me/gfs/resources/${RID}?drive=main`,
      { token: 'tok', body: { newName: 'renamed.md', ifMatch: 2 } }
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      'DELETE',
      `https://api.example/api/v1/me/gfs/resources/${RID}?drive=main`,
      { token: 'tok', body: { ifMatch: 3 } }
    )
  })
})

describe('parseSubjectKey', () => {
  it('parses user and team subject keys for Desktop delegation', () => {
    expect(parseSubjectKey('user:abc')).toEqual({ type: 'user', id: 'abc' })
    expect(parseSubjectKey('team:xyz')).toEqual({ type: 'team', id: 'xyz' })
  })

  it('parses managed host subject keys (first colon splits type from the canonical id)', () => {
    expect(parseSubjectKey('host:1st:mcp-host/chatllm')).toEqual({
      type: 'host',
      id: '1st:mcp-host/chatllm',
    })
    expect(parseSubjectKey('host:3rd:sandbox-recipes/scraper-0')).toEqual({
      type: 'host',
      id: '3rd:sandbox-recipes/scraper-0',
    })
  })

  it('rejects host subject keys that fail the server grammar shape', () => {
    // No party/namespace (pre-822 grammar stays rejected).
    expect(() => parseSubjectKey('host:chatllm')).toThrow(/host:<party>:<ns>\/<name>/)
    // Unknown party.
    expect(() => parseSubjectKey('host:2nd:mcp-host/chatllm')).toThrow(GfsUriError)
    // Empty namespace or name.
    expect(() => parseSubjectKey('host:1st:/chatllm')).toThrow(GfsUriError)
    expect(() => parseSubjectKey('host:1st:mcp-host/')).toThrow(GfsUriError)
    expect(() => parseSubjectKey('host:')).toThrow(GfsUriError)
    // Not k8s DNS-1123 names.
    expect(() => parseSubjectKey('host:1st:MCP-Host/chatllm')).toThrow(GfsUriError)
    expect(() => parseSubjectKey('host:1st:mcp-host/-chatllm')).toThrow(GfsUriError)
    // Extra path segment.
    expect(() => parseSubjectKey('host:1st:mcp-host/a/b')).toThrow(GfsUriError)
    // Over the 63-char k8s name budget.
    expect(() => parseSubjectKey(`host:1st:mcp-host/${'a'.repeat(64)}`)).toThrow(GfsUriError)
    // At the 63-char budget: accepted.
    expect(parseSubjectKey(`host:1st:mcp-host/${'a'.repeat(63)}`)).toEqual({
      type: 'host',
      id: `1st:mcp-host/${'a'.repeat(63)}`,
    })
  })

  it('rejects malformed and operator/provisioner-only subject keys', () => {
    expect(() => parseSubjectKey('')).toThrow(GfsUriError)
    expect(() => parseSubjectKey('user:')).toThrow(GfsUriError)
    expect(() => parseSubjectKey('bogus:1')).toThrow(GfsUriError)
    expect(() => parseSubjectKey('operator')).toThrow(GfsUriError)
    expect(() => parseSubjectKey('context:engineering')).toThrow(GfsUriError)
  })
})
