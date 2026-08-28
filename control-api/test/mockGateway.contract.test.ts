import { describe, expect, it } from 'vitest'
import { MockGateway } from './mockGateway.js'

const b64 = (value: string): string => Buffer.from(value).toString('base64')

describe('MockGateway Kubernetes identity contract', () => {
  it('returns the server-assigned identity from a mutation', async () => {
    const gateway = new MockGateway('mcp-server')
    const key = ['TEST', 'VALUE'].join('_')

    const created = await gateway.createSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      type: 'Opaque',
      data: { [key]: 'initial' },
    })

    expect(created).toMatchObject({
      name: 'credentials',
      namespace: 'mcp-server',
      uid: expect.any(String),
      resourceVersion: '1',
    })
  })

  it('rejects a duplicate Secret create with the apiserver conflict shape', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server')

    await expect(
      gateway.createSecret({ name: 'credentials', namespace: 'mcp-server', type: 'Opaque' })
    ).rejects.toMatchObject({ statusCode: 409, code: 409 })
  })

  it('rejects an update for a missing Secret with the apiserver not-found shape', async () => {
    const gateway = new MockGateway('mcp-server')

    await expect(
      gateway.updateSecret({ name: 'missing', namespace: 'mcp-server', type: 'Opaque' })
    ).rejects.toMatchObject({ statusCode: 404, code: 404 })
  })

  it('does not let rollback overwrite a third-party write after the mutation', async () => {
    const gateway = new MockGateway('mcp-server')
    const key = ['TEST', 'VALUE'].join('_')
    gateway.seedSecret('credentials', 'mcp-server', {
      uid: 'object-uid',
      resourceVersion: '1',
      type: 'Opaque',
      data: { [key]: 'before' },
    })

    const updated = await gateway.updateSecret(
      { name: 'credentials', namespace: 'mcp-server', type: 'Opaque', data: { [key]: 'upgrade' } },
      { uid: 'object-uid', resourceVersion: '1' }
    )
    expect(updated.resourceVersion).toBe('2')

    await gateway.updateSecret(
      {
        name: 'credentials',
        namespace: 'mcp-server',
        type: 'Opaque',
        data: { [key]: 'third-party' },
      },
      { uid: 'object-uid', resourceVersion: '2' }
    )

    await expect(
      gateway.updateSecret(
        {
          name: 'credentials',
          namespace: 'mcp-server',
          type: 'Opaque',
          data: { [key]: 'rollback' },
        },
        { uid: 'object-uid', resourceVersion: updated.resourceVersion }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 409 })

    await expect(gateway.getSecret('credentials', 'mcp-server')).resolves.toMatchObject({
      data: { [key]: 'third-party' },
      metadata: { resourceVersion: '3' },
    })
  })

  it('rejects a stale resourceVersion after a concurrent resource write', async () => {
    const gateway = new MockGateway('mcp-server')
    await gateway.createResource('mcpservers', {
      metadata: { name: 'server' },
      spec: { image: 'example:1' },
    })

    const initial = (await gateway.getResource('mcpservers', 'server', 'mcp-server')) as {
      metadata: { resourceVersion: string }
    }

    await gateway.updateResource(
      'mcpservers',
      'server',
      {
        metadata: { resourceVersion: initial.metadata.resourceVersion },
        spec: { image: 'example:2' },
      },
      'mcp-server'
    )

    await expect(
      gateway.updateResource(
        'mcpservers',
        'server',
        {
          metadata: { resourceVersion: initial.metadata.resourceVersion },
          spec: { image: 'example:stale' },
        },
        'mcp-server'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 409 })
  })

  it('keeps a same-name replacement when a delete carries the original identity', async () => {
    const gateway = new MockGateway('mcp-server')
    const dataKey = ['TOK', 'EN'].join('')
    const created = await gateway.createSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      type: 'Opaque',
      data: { [dataKey]: ['ori', 'ginal'].join('') },
    })

    await gateway.deleteSecret('credentials', 'mcp-server', {
      uid: created.uid,
      resourceVersion: created.resourceVersion,
    })
    const replacement = await gateway.createSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      type: 'Opaque',
      data: { [dataKey]: ['repla', 'cement'].join('') },
    })

    await expect(
      gateway.deleteSecret('credentials', 'mcp-server', {
        uid: created.uid,
        resourceVersion: created.resourceVersion,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 409 })

    await expect(gateway.getSecret('credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: replacement.uid },
      data: { [dataKey]: ['repla', 'cement'].join('') },
    })
  })

  it('enforces mutation constraints in the in-memory gateway', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server', { type: 'Opaque', data: { FIELD: 'before' } })

    await expect(
      gateway.updateSecret({
        name: 'credentials',
        namespace: 'mcp-server',
        type: 'not-a-kubernetes-secret-type',
      })
    ).rejects.toThrow(/Secret type/)

    await expect(
      gateway.mergeSecret({
        name: 'credentials',
        namespace: 'mcp-server',
        annotations: { 'kubernetes.io/unsafe': 'caller-controlled' },
      })
    ).rejects.toThrow(/annotation key/)
  })

  it('models RFC 7396 map merging instead of replacing omitted Secret members', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server', {
      type: 'Opaque',
      labels: { owner: 'control-api', keep: 'yes' },
      annotations: { catalog: 'v1', keep: 'yes' },
      data: { FIRST: 'before', KEEP: 'untouched' },
    })

    await gateway.mergeSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      labels: { owner: 'operator' },
      annotations: { catalog: 'v2' },
      data: { FIRST: 'after' },
    })

    await expect(gateway.getSecret('credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: {
        labels: { owner: 'operator', keep: 'yes' },
        annotations: { catalog: 'v2', keep: 'yes' },
      },
      data: { FIRST: 'after', KEEP: 'untouched' },
    })
  })

  it('materializes stringData over data as base64 on Secret create', async () => {
    const gateway = new MockGateway('mcp-server')

    const created = await gateway.createSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      type: 'Opaque',
      data: { KEEP: b64('encoded'), OVERRIDE: b64('stale') },
      stringData: { OVERRIDE: 'plain' },
    })

    expect(created).toMatchObject({
      data: { KEEP: b64('encoded'), OVERRIDE: b64('plain') },
    })
    expect(created).not.toHaveProperty('stringData')

    const stored = await gateway.getSecret('credentials', 'mcp-server')
    expect(stored).toMatchObject({ data: { KEEP: b64('encoded'), OVERRIDE: b64('plain') } })
    expect(stored).not.toHaveProperty('stringData')
  })

  it('materializes stringData over data as base64 on Secret replace', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server', {
      type: 'Opaque',
      data: { PRIOR: b64('prior') },
    })

    const updated = await gateway.updateSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      type: 'Opaque',
      data: { DATA_ONLY: b64('encoded'), OVERRIDE: b64('stale') },
      stringData: { OVERRIDE: 'plain' },
    })

    expect(updated).toMatchObject({
      data: { DATA_ONLY: b64('encoded'), OVERRIDE: b64('plain') },
    })
    expect(updated).not.toHaveProperty('stringData')
  })

  it('applies merge-patch deletions before materializing stringData over data', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server', {
      type: 'Opaque',
      labels: { keep: 'yes', remove: 'yes' },
      annotations: { 'safe.example/keep': 'yes', 'safe.example/remove': 'yes' },
      data: { KEEP: b64('keep'), REMOVE: b64('remove'), OVERRIDE: b64('stale') },
    })

    const merged = await gateway.mergeSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      labels: { remove: null },
      annotations: { 'safe.example/remove': null },
      data: { REMOVE: null, DATA_ONLY: b64('encoded'), OVERRIDE: b64('stale-data') },
      stringData: { DATA_ONLY: 'plain', OVERRIDE: 'plain-override', UNUSED: null },
    } as unknown)

    expect(merged).toMatchObject({
      labels: { keep: 'yes' },
      annotations: { 'safe.example/keep': 'yes' },
      data: {
        KEEP: b64('keep'),
        DATA_ONLY: b64('plain'),
        OVERRIDE: b64('plain-override'),
      },
    })
    expect(merged.data).not.toHaveProperty('REMOVE')
    expect(merged.data).not.toHaveProperty('UNUSED')
    expect(merged).not.toHaveProperty('stringData')

    const stored = await gateway.getSecret('credentials', 'mcp-server')
    expect(stored).toMatchObject({
      metadata: {
        labels: { keep: 'yes' },
        annotations: { 'safe.example/keep': 'yes' },
      },
      data: {
        KEEP: b64('keep'),
        DATA_ONLY: b64('plain'),
        OVERRIDE: b64('plain-override'),
      },
    })
    expect(stored.data).not.toHaveProperty('REMOVE')
    expect(stored.data).not.toHaveProperty('UNUSED')
    expect(stored).not.toHaveProperty('stringData')
  })

  it('preserves an identical future clerum.io annotation through a Secret merge', async () => {
    const gateway = new MockGateway('mcp-server')
    const futureKey = 'clerum.io/future-controller-state'
    const futureValue = 'opaque-v1'
    const constraints = { allowExistingPlatformAnnotationKeys: [futureKey] }
    gateway.seedSecret('credentials', 'mcp-server', {
      type: 'Opaque',
      annotations: { [futureKey]: futureValue },
    })

    await expect(
      gateway.mergeSecret(
        {
          name: 'credentials',
          namespace: 'mcp-server',
          annotations: { [futureKey]: futureValue },
          stringData: { VALUE: 'rotated' },
        },
        constraints
      )
    ).resolves.toMatchObject({ annotations: { [futureKey]: futureValue } })

    await expect(gateway.getSecret('credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { annotations: { [futureKey]: futureValue } },
    })
  })

  it('rejects changed or injected future clerum.io annotations after reading a Secret', async () => {
    const gateway = new MockGateway('mcp-server')
    const futureKey = 'clerum.io/future-controller-state'
    const constraints = { allowExistingPlatformAnnotationKeys: [futureKey] }
    gateway.seedSecret('credentials', 'mcp-server', {
      type: 'Opaque',
      annotations: { [futureKey]: 'opaque-v1' },
    })

    await expect(
      gateway.mergeSecret(
        {
          name: 'credentials',
          namespace: 'mcp-server',
          annotations: { [futureKey]: 'caller-controlled' },
        },
        constraints
      )
    ).rejects.toThrow()

    await expect(
      gateway.mergeSecret(
        {
          name: 'credentials',
          namespace: 'mcp-server',
          annotations: { [futureKey]: null },
        } as unknown,
        constraints
      )
    ).rejects.toThrow()

    await expect(
      gateway.mergeSecret(
        {
          name: 'credentials',
          namespace: 'mcp-server',
          annotations: { 'clerum.io/another-future-key': 'caller-controlled' },
        },
        constraints
      )
    ).rejects.toThrow()

    await expect(gateway.getSecret('credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { annotations: { [futureKey]: 'opaque-v1' } },
    })
  })

  it('applies the current type policy when a Secret merge preserves its type', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server', {
      type: 'kubernetes.io/service-account-token',
    })

    await expect(
      gateway.mergeSecret({
        name: 'credentials',
        namespace: 'mcp-server',
        stringData: { VALUE: 'rotated' },
      })
    ).rejects.toThrow(/Secret type/)
  })

  it('does not let an explicit safe type mask a controller-managed live type', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server', {
      type: 'kubernetes.io/service-account-token',
    })

    await expect(
      gateway.updateSecret({
        name: 'credentials',
        namespace: 'mcp-server',
        type: 'Opaque',
        stringData: { VALUE: 'rotated' },
      })
    ).rejects.toThrow(/managed by Kubernetes/)

    await expect(
      gateway.mergeSecret({
        name: 'credentials',
        namespace: 'mcp-server',
        type: 'Opaque',
        stringData: { VALUE: 'rotated' },
      })
    ).rejects.toThrow(/managed by Kubernetes/)
  })

  it('stores a dynamic map key as data without changing the object prototype', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('credentials', 'mcp-server', { type: 'Opaque' })
    const annotations = JSON.parse('{"__proto__":"safe-value"}') as Record<string, string>

    await gateway.mergeSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      annotations,
    })

    const stored = await gateway.getSecret('credentials', 'mcp-server')
    expect(Object.prototype.hasOwnProperty.call(stored.metadata?.annotations, '__proto__')).toBe(
      true
    )
    expect(stored.metadata?.annotations?.['__proto__']).toBe('safe-value')
    expect(Object.prototype).not.toHaveProperty('safe-value')
  })

  it('rejects stale identity on key removal instead of deleting a concurrent value', async () => {
    const gateway = new MockGateway('mcp-server')
    const key = ['FIE', 'LD'].join('')
    const created = await gateway.createSecret({
      name: 'credentials',
      namespace: 'mcp-server',
      type: 'Opaque',
      data: { [key]: 'before' },
    })
    await gateway.updateSecret(
      {
        name: 'credentials',
        namespace: 'mcp-server',
        type: 'Opaque',
        data: { [key]: 'concurrent' },
      },
      { uid: created.uid, resourceVersion: created.resourceVersion }
    )

    await expect(
      gateway.removeSecretKey(
        { name: 'credentials', namespace: 'mcp-server', key },
        { uid: created.uid, resourceVersion: created.resourceVersion }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 409 })
    await expect(gateway.getSecret('credentials', 'mcp-server')).resolves.toMatchObject({
      data: { [key]: 'concurrent' },
    })
  })

  it('keeps a same-name resource replacement when a delete carries the original identity', async () => {
    const gateway = new MockGateway('mcp-server')
    const created = (await gateway.createResource('mcpservers', {
      metadata: { name: 'server' },
      spec: { image: 'example:original' },
    })) as { metadata: { uid: string; resourceVersion: string } }

    await gateway.deleteResource('mcpservers', 'server', 'mcp-server', {
      uid: created.metadata.uid,
      resourceVersion: created.metadata.resourceVersion,
    })
    const replacement = (await gateway.createResource('mcpservers', {
      metadata: { name: 'server' },
      spec: { image: 'example:replacement' },
    })) as { metadata: { uid: string } }

    await expect(
      gateway.deleteResource('mcpservers', 'server', 'mcp-server', {
        uid: created.metadata.uid,
        resourceVersion: created.metadata.resourceVersion,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 409 })

    await expect(gateway.getResource('mcpservers', 'server', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: replacement.metadata.uid },
      spec: { image: 'example:replacement' },
    })
  })
})
