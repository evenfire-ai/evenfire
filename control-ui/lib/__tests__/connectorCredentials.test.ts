import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@lib/api'
import type { McpServerResource } from '@lib/api'
import {
  attachConnectorCredentials,
  buildAttachPayload,
  changeConnectorSecretReference,
  credentialAttachUnavailable,
  validateCredentialAttach,
} from '@lib/connectorCredentials'
import type { AttachCredentialRow, AttachCredentialsRequest } from '@lib/connectorCredentials.types'

vi.mock('@lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/api')>()),
  getMcpServer: vi.fn(),
  listMcpSecrets: vi.fn(),
  createMcpSecret: vi.fn(),
  updateMcpSecret: vi.fn(),
  deleteMcpSecret: vi.fn(),
  updateMcpServer: vi.fn(),
}))

const reference = { name: 'new-secret', keys: [{ secretKey: 'api-key', envVar: 'API_KEY' }] }
const row: AttachCredentialRow = {
  id: 'row',
  secretKey: 'api-key',
  envVar: 'API_KEY',
  value: '  private bytes  ',
}
function server(): McpServerResource {
  return {
    metadata: { name: 'connector', uid: 'server-uid', resourceVersion: '10', generation: 2 },
    spec: {
      image: 'example/image:v1',
      managed: true,
      egressBindings: [{ dns: 'api.example.com', port: 443 }],
    },
  }
}
function error(status: number, body?: object) {
  return Object.assign(new Error('request failed'), { status, body })
}
function request(overrides: Partial<AttachCredentialsRequest> = {}): AttachCredentialsRequest {
  return {
    serverName: 'connector',
    secretName: 'new-secret',
    mode: 'create-new',
    rows: [{ ...row }],
    onSecretWritten: vi.fn(),
    ...overrides,
  }
}
const existing = { name: 'new-secret', uid: 'secret-uid', keys: ['api-key'] }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getMcpServer).mockResolvedValue(server())
  vi.mocked(api.listMcpSecrets).mockResolvedValue({ items: [existing] })
  vi.mocked(api.createMcpSecret).mockResolvedValue({
    name: 'new-secret',
    namespace: 'mcp-server',
    uid: 'created-uid',
    resourceVersion: 'secret-rv',
  })
  vi.mocked(api.updateMcpSecret).mockResolvedValue({
    name: 'new-secret',
    namespace: 'mcp-server',
    keys: ['api-key'],
    affectedConnectors: ['other'],
  })
  vi.mocked(api.updateMcpServer).mockImplementation(async (_name, payload) => ({
    ...server(),
    metadata: { ...server().metadata, generation: 3 },
    spec: payload.spec,
  }))
  vi.mocked(api.deleteMcpSecret).mockResolvedValue({ name: 'new-secret', namespace: 'mcp-server' })
})

describe('attach validation', () => {
  it.each(['-abc', 'UPPER', 'a'.repeat(254), ''])('rejects invalid Secret name %s', name => {
    expect(validateCredentialAttach('create-new', name, [row], server())?.field).toBe('secret')
  })
  it.each(['.', '..data', '', 'a/b', 'a'.repeat(254)])('rejects invalid key %s', secretKey => {
    expect(
      validateCredentialAttach('create-new', 'secret', [{ ...row, secretKey }], server())?.field
    ).toBe('row-key')
  })
  it.each(['', '1INVALID', 'KEY-VAR', 'NODE_OPTIONS', 'path'])(
    'rejects invalid or dangerous env %s',
    envVar => {
      expect(
        validateCredentialAttach('create-new', 'secret', [{ ...row, envVar }], server())?.field
      ).toBe('row-env')
    }
  )
  it('requires rows, every new value, and a selected existing Secret', () => {
    expect(validateCredentialAttach('create-new', 'secret', [], server())?.message).toContain(
      'at least one'
    )
    expect(
      validateCredentialAttach('create-new', 'secret', [{ ...row, value: '' }], server())?.field
    ).toBe('row-value')
    expect(validateCredentialAttach('use-existing', 'secret', [row], server())?.field).toBe(
      'secret'
    )
  })
  it('rejects duplicate destinations, env collisions, and conflicting duplicate-key values', () => {
    const target = server()
    target.spec.env = [{ name: 'API_KEY', value: 'plain' }]
    expect(validateCredentialAttach('create-new', 'secret', [row], target)?.message).toContain(
      'already mapped'
    )
    target.spec.env = []
    target.spec.envMapping = { token: 'API_KEY' }
    expect(validateCredentialAttach('create-new', 'secret', [row], target)?.message).toContain(
      'already mapped'
    )
    expect(
      validateCredentialAttach('create-new', 'secret', [row, { ...row, id: 'two' }], server())
        ?.message
    ).toContain('already mapped')
    expect(
      validateCredentialAttach(
        'create-new',
        'secret',
        [row, { ...row, id: 'two', envVar: 'OTHER_KEY', value: 'different' }],
        server()
      )?.message
    ).toContain('same value')
  })
  it('preserves credential bytes and safely serializes prototype-overlapping keys', () => {
    const rows = ['__proto__', 'constructor', 'toString'].map((secretKey, index) => ({
      ...row,
      id: String(index),
      secretKey,
      envVar: `KEY_${index}`,
    }))
    const payload = buildAttachPayload(' secret ', rows)
    expect(Object.getPrototypeOf(payload.data)).toBeNull()
    expect(JSON.parse(JSON.stringify(payload.data))['__proto__']).toBe(row.value)
    expect(payload.reference.name).toBe('secret')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it.each([
    { envSecret: null },
    { envSecret: { name: 'broken' } },
    { oauth: null },
    { oauth: {} },
    { managed: false },
    { enabled: false },
  ])('blocks structural ineligibility %j', spec => {
    expect(
      credentialAttachUnavailable({ ...server(), spec: { ...server().spec, ...spec } })
    ).toBeTruthy()
  })
})

// Reference-only reuse (creation + reassignment) must answer a missing or
// stale key with a KEY selection error and must never request a credential
// value — unlike the keyless-attach flow, which may still write new keys.
describe('reference-only validation with storedKeysOnly', () => {
  const selected = { name: 'new-secret', uid: 'secret-uid', keys: ['api-key', 'other-key'] }
  const options = { storedKeysOnly: true } as const

  it('reports an empty key as a key choice, not a format or value error', () => {
    const invalid = validateCredentialAttach(
      'use-existing',
      'new-secret',
      [{ ...row, secretKey: '' }],
      server(),
      selected,
      options
    )
    expect(invalid?.field).toBe('row-key')
    expect(invalid?.message).toContain('Choose a stored key')
  })

  it('reports a stale key as a key selection error and never asks for a value', () => {
    const invalid = validateCredentialAttach(
      'use-existing',
      'new-secret',
      [{ ...row, secretKey: 'removed-key' }],
      server(),
      selected,
      options
    )
    expect(invalid?.field).toBe('row-key')
    expect(invalid?.message).toContain('not stored')
    expect(invalid?.message.toLowerCase()).not.toContain('enter a credential value')
  })

  it('rejects a supplied value even for a stored key', () => {
    const invalid = validateCredentialAttach(
      'use-existing',
      'new-secret',
      [row],
      server(),
      selected,
      options
    )
    expect(invalid?.field).toBe('row-value')
    expect(invalid?.message).toContain('never take a value')
  })

  it('accepts a stored key mapped without a value and keeps destination checks', () => {
    const stored: AttachCredentialRow = { ...row, value: '' }
    expect(
      validateCredentialAttach('use-existing', 'new-secret', [stored], server(), selected, options)
    ).toBeUndefined()
    const colliding = server()
    colliding.spec.env = [{ name: 'API_KEY', value: 'plain' }]
    expect(
      validateCredentialAttach('use-existing', 'new-secret', [stored], colliding, selected, options)
        ?.field
    ).toBe('row-env')
  })

  it('keeps the keyless-attach behavior when the option is absent: a missing stored key requires a value', () => {
    const invalid = validateCredentialAttach(
      'use-existing',
      'new-secret',
      [{ ...row, secretKey: 'new-key', value: '' }],
      server(),
      selected
    )
    expect(invalid?.field).toBe('row-value')
  })
})

describe('ordered attach writes and recovery', () => {
  it('refuses a same-name replacement since the page loaded before touching any Secret', async () => {
    await expect(
      attachConnectorCredentials(request({ expectedUid: 'old-page-uid' }))
    ).rejects.toThrow('replaced')
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
  })

  it('preserves fresh spec, fences by UID/RV, and keeps values out of spec', async () => {
    const fresh = server()
    fresh.metadata.resourceVersion = '12'
    vi.mocked(api.getMcpServer).mockResolvedValueOnce(server()).mockResolvedValueOnce(fresh)
    const input = request()
    const result = await attachConnectorCredentials(input)
    expect(api.createMcpSecret).toHaveBeenCalledWith('new-secret', { 'api-key': row.value })
    expect(api.updateMcpServer).toHaveBeenCalledWith('connector', {
      metadata: { uid: 'server-uid', resourceVersion: '12' },
      spec: { ...fresh.spec, envSecret: reference },
    })
    expect(api.getMcpServer.mock.invocationCallOrder[0]).toBeLessThan(
      api.createMcpSecret.mock.invocationCallOrder[0]
    )
    expect(api.createMcpSecret.mock.invocationCallOrder[0]).toBeLessThan(
      api.getMcpServer.mock.invocationCallOrder[1]
    )
    expect(api.getMcpServer.mock.invocationCallOrder[1]).toBeLessThan(
      api.updateMcpServer.mock.invocationCallOrder[0]
    )
    expect(JSON.stringify(api.updateMcpServer.mock.calls)).not.toContain(row.value)
    expect(result.server.metadata.generation).toBe(3)
    expect(input.onSecretWritten).toHaveBeenCalledOnce()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it.each([409, 500, 503])('never overwrites after rejected create %s', async status => {
    vi.mocked(api.createMcpSecret).mockRejectedValue(error(status))
    await expect(attachConnectorCredentials(request())).rejects.toMatchObject({
      collision: status === 409,
      refreshRequired: status !== 409,
    })
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpServer).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('does not blindly overwrite or delete after lost create response', async () => {
    vi.mocked(api.createMcpSecret).mockRejectedValue(new TypeError('network'))
    await expect(attachConnectorCredentials(request())).rejects.toMatchObject({
      refreshRequired: true,
    })
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    'handles a partial create with complete repair identity=%s',
    async complete => {
      vi.mocked(api.createMcpSecret).mockRejectedValue(
        error(503, {
          error: 'mcp_secret_rollback_permit_unavailable',
          outcome: 'repair_required',
          created: {
            name: 'new-secret',
            namespace: 'mcp-server',
            uid: 'repair-uid',
            ...(complete ? { resourceVersion: 'repair-rv' } : {}),
          },
        })
      )
      await expect(attachConnectorCredentials(request())).rejects.toThrow()
      if (complete)
        expect(api.deleteMcpSecret).toHaveBeenCalledWith('new-secret', {
          uid: 'repair-uid',
          resourceVersion: 'repair-rv',
        })
      else expect(api.deleteMcpSecret).not.toHaveBeenCalled()
      expect(api.updateMcpServer).not.toHaveBeenCalled()
    }
  )
  it('refuses a successful create without identity', async () => {
    vi.mocked(api.createMcpSecret).mockResolvedValue({
      name: 'new-secret',
      namespace: 'mcp-server',
    })
    await expect(attachConnectorCredentials(request())).rejects.toMatchObject({
      refreshRequired: true,
    })
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })
  it.each([409, 422])(
    'cleans only the exact created Secret after definite spec rejection %s',
    async status => {
      vi.mocked(api.updateMcpServer).mockRejectedValue(error(status))
      await expect(attachConnectorCredentials(request())).rejects.toThrow('could not be attached')
      expect(api.deleteMcpSecret).toHaveBeenCalledWith('new-secret', {
        uid: 'created-uid',
        resourceVersion: 'secret-rv',
      })
    }
  )
  it.each([409, 503])('reports both failures when cleanup is refused %s', async status => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(error(422))
    vi.mocked(api.deleteMcpSecret).mockRejectedValue(error(status))
    await expect(attachConnectorCredentials(request())).rejects.toThrow(
      /could not be attached.*Cleanup.*new-secret/
    )
    expect(api.deleteMcpSecret).toHaveBeenCalledOnce()
  })
  it('treats an already absent cleanup target as cleaned', async () => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(error(422))
    vi.mocked(api.deleteMcpSecret).mockRejectedValue(error(404))
    await expect(attachConnectorCredentials(request())).rejects.not.toThrow('Cleanup')
  })
  it('continues verification after a lost PUT response and matching readback', async () => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(new TypeError('network'))
    const saved = {
      ...server(),
      metadata: { ...server().metadata, generation: 3 },
      spec: { ...server().spec, envSecret: reference },
    }
    vi.mocked(api.getMcpServer)
      .mockResolvedValueOnce(server())
      .mockResolvedValueOnce(server())
      .mockResolvedValueOnce(saved)
    expect((await attachConnectorCredentials(request())).server).toEqual(saved)
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it.each(['old', 'replaced', 'unreadable'])(
    'retains Secret when PUT outcome is uncertain (%s)',
    async outcome => {
      vi.mocked(api.updateMcpServer).mockRejectedValue(error(500))
      const read = vi
        .mocked(api.getMcpServer)
        .mockResolvedValueOnce(server())
        .mockResolvedValueOnce(server())
      if (outcome === 'unreadable') read.mockRejectedValueOnce(error(503))
      else
        read.mockResolvedValueOnce({
          ...server(),
          metadata: {
            ...server().metadata,
            uid: outcome === 'replaced' ? 'replacement' : 'server-uid',
          },
        })
      await expect(attachConnectorCredentials(request())).rejects.toThrow('Secret was retained')
      expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    }
  )
  it.each(['uid', 'spec', 'ownership', 'rv'])(
    'rechecks identity and eligibility after Secret creation (%s)',
    async change => {
      const latest = server()
      if (change === 'uid') latest.metadata.uid = 'replacement'
      if (change === 'spec') latest.spec.egressBindings = []
      if (change === 'ownership') latest.spec.managed = false
      if (change === 'rv') delete latest.metadata.resourceVersion
      vi.mocked(api.getMcpServer).mockResolvedValueOnce(server()).mockResolvedValueOnce(latest)
      await expect(attachConnectorCredentials(request())).rejects.toThrow(
        'current settings could not be verified'
      )
      expect(api.updateMcpServer).not.toHaveBeenCalled()
      expect(api.deleteMcpSecret).toHaveBeenCalledOnce()
    }
  )
  it('rejects ineligible or unidentified initial reads before any writes', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({ ...server(), metadata: {} })
    await expect(attachConnectorCredentials(request())).rejects.toThrow('identity')
    expect(api.createMcpSecret).not.toHaveBeenCalled()
  })
  it('skips all Secret writes when existing values are blank', async () => {
    await attachConnectorCredentials(
      request({ mode: 'use-existing', selectedSecret: existing, rows: [{ ...row, value: '' }] })
    )
    expect(api.listMcpSecrets).toHaveBeenCalledOnce()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpServer).toHaveBeenCalledOnce()
  })
  it('merges only filled keys before saving spec and returns other affected consumers', async () => {
    const result = await attachConnectorCredentials(
      request({ mode: 'use-existing', selectedSecret: existing })
    )
    expect(api.updateMcpSecret).toHaveBeenCalledWith('new-secret', { 'api-key': row.value })
    expect(api.updateMcpSecret.mock.invocationCallOrder[0]).toBeLessThan(
      api.updateMcpServer.mock.invocationCallOrder[0]
    )
    expect(result.affectedConnectors).toEqual(['other'])
  })
  it.each(['gone', 'key-gone', 'replaced'])(
    'stops before writes if selected Secret changed: %s',
    async change => {
      vi.mocked(api.listMcpSecrets).mockResolvedValue({
        items:
          change === 'gone'
            ? []
            : [
                {
                  ...existing,
                  keys: change === 'key-gone' ? [] : existing.keys,
                  uid: change === 'replaced' ? 'replacement' : existing.uid,
                },
              ],
      })
      await expect(
        attachConnectorCredentials(
          request({ mode: 'use-existing', selectedSecret: existing, rows: [{ ...row, value: '' }] })
        )
      ).rejects.toThrow()
      expect(api.updateMcpSecret).not.toHaveBeenCalled()
      expect(api.updateMcpServer).not.toHaveBeenCalled()
    }
  )
  it('never creates on an existing Secret update 404', async () => {
    vi.mocked(api.updateMcpSecret).mockRejectedValue(error(404))
    await expect(
      attachConnectorCredentials(request({ mode: 'use-existing', selectedSecret: existing }))
    ).rejects.toThrow('no longer exists')
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })
  it('does not undo existing values when spec save fails', async () => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(error(409))
    await expect(
      attachConnectorCredentials(request({ mode: 'use-existing', selectedSecret: existing }))
    ).rejects.toThrow('Secret values were updated')
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).toHaveBeenCalledOnce()
  })
})

describe('reference-only Secret reassignment', () => {
  const oldReference = { name: 'old-secret', keys: [{ secretKey: 'old-token', envVar: 'API_KEY' }] }
  function assignedServer() {
    const current = server()
    current.spec.envSecret = oldReference
    current.spec.contextRef = 'private-context'
    current.spec.remote = {
      authType: 'bearer',
      authHeaders: [{ name: 'Authorization', valueTemplate: 'Bearer ${API_KEY}' }],
    }
    return current
  }
  function changeRequest() {
    return {
      serverName: 'connector',
      server: assignedServer(),
      selection: { ready: true, secret: existing, rows: [{ ...row, value: '' }] },
    }
  }
  beforeEach(() => {
    vi.mocked(api.getMcpServer).mockResolvedValue(assignedServer())
  })
  it('changes only envSecret and preserves the remote auth, access, egress, and identity preconditions', async () => {
    const result = await changeConnectorSecretReference(changeRequest())
    expect(api.updateMcpServer).toHaveBeenCalledWith('connector', {
      metadata: { uid: 'server-uid', resourceVersion: '10' },
      spec: { ...assignedServer().spec, envSecret: reference },
    })
    expect(result.server.spec.envSecret).toEqual(reference)
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it.each([
    { managed: false },
    { enabled: false },
    { oauth: null },
    { envSecret: null },
    { envSecret: { name: 'invalid' } },
  ])('rejects ineligible reference changes without writes: %j', async changed => {
    const request = changeRequest()
    request.server.spec = { ...request.server.spec, ...changed }
    vi.mocked(api.getMcpServer).mockResolvedValue(request.server)
    await expect(changeConnectorSecretReference(request)).rejects.toThrow(/connector changed/)
    expect(api.updateMcpServer).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('rejects an edit since the displayed snapshot before checking or writing Secrets', async () => {
    const changed = assignedServer()
    changed.spec.image = 'example/new-image:v2'
    vi.mocked(api.getMcpServer).mockResolvedValue(changed)
    await expect(changeConnectorSecretReference(changeRequest())).rejects.toThrow(
      /connector changed/
    )
    expect(api.listMcpSecrets).not.toHaveBeenCalled()
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })
  it('rejects changes between verification and the final write', async () => {
    const changed = assignedServer()
    changed.spec.enabled = false
    vi.mocked(api.getMcpServer)
      .mockResolvedValueOnce(assignedServer())
      .mockResolvedValueOnce(changed)
    await expect(changeConnectorSecretReference(changeRequest())).rejects.toThrow(
      /connector changed/
    )
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })
  // Each case is the full `items` array, wrapped one extra level so `it.each`
  // passes it as a single argument instead of spreading it.
  it.each([
    [[]],
    [[{ ...existing, uid: 'replacement' }]],
    [[{ ...existing, keys: ['different-key'] }]],
  ])('rejects missing/replaced Secrets and missing stored keys: %j', async items => {
    vi.mocked(api.listMcpSecrets).mockResolvedValue({ items })
    await expect(changeConnectorSecretReference(changeRequest())).rejects.toThrow(/Secret|key/)
    expect(api.updateMcpServer).not.toHaveBeenCalled()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('rejects an unchanged assignment', async () => {
    const current = assignedServer()
    current.spec.envSecret = reference
    vi.mocked(api.getMcpServer).mockResolvedValue(current)
    await expect(
      changeConnectorSecretReference({ ...changeRequest(), server: current })
    ).rejects.toThrow(/different Secret/)
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })
  it('never cleans up shared Secrets when the API rejects the reference save', async () => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(error(409))
    await expect(changeConnectorSecretReference(changeRequest())).rejects.toThrow(/rejected/)
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('recovers an uncertain successful save through a matching read', async () => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(error(503))
    const saved = assignedServer()
    saved.spec.envSecret = reference
    vi.mocked(api.getMcpServer)
      .mockResolvedValueOnce(assignedServer())
      .mockResolvedValueOnce(assignedServer())
      .mockResolvedValueOnce(saved)
    expect((await changeConnectorSecretReference(changeRequest())).server).toEqual(saved)
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('reports an uncertain outcome when the read cannot prove the reference was saved', async () => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(error(503))
    await expect(changeConnectorSecretReference(changeRequest())).rejects.toThrow(
      /could not be confirmed/
    )
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('rejects any attempt to supply credential bytes in a reference-only operation', async () => {
    const request = changeRequest()
    request.selection.rows[0].value = 'unexpected'
    await expect(changeConnectorSecretReference(request)).rejects.toThrow(/key/)
    expect(api.updateMcpServer).not.toHaveBeenCalled()
    expect(api.updateMcpSecret).not.toHaveBeenCalled()
  })
})
