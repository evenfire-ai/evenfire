import { describe, expect, it } from 'vitest'
import { MockGateway } from './mockGateway.js'

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
