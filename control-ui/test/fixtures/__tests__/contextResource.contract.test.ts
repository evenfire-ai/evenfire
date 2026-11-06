import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { buildContextList, buildContextResource } from '../contextResource'

describe('Context producer fixture contract', () => {
  it('locks the exact control-api Context list wire shape', () => {
    const context = buildContextResource({
      metadata: {
        name: 'research',
        namespace: 'mcp-server',
        resourceVersion: 'rv-context-read',
      },
      spec: {
        contextId: 'research',
        description: 'Research tools',
        mcpServers: ['search'],
        sharedFileSystems: [{ name: 'docs', mountPath: '/docs' }],
      },
      status: { sharedFileSystems: [] },
    })

    expect(buildContextList([context])).toEqual({
      items: [
        {
          metadata: {
            name: 'research',
            namespace: 'mcp-server',
            resourceVersion: 'rv-context-read',
          },
          spec: {
            contextId: 'research',
            description: 'Research tools',
            mcpServers: ['search'],
            sharedFileSystems: [{ name: 'docs', mountPath: '/docs' }],
          },
          status: { sharedFileSystems: [] },
        },
      ],
    })
    expect(Object.keys(context).sort()).toEqual(['metadata', 'spec', 'status'])
    expect(Object.keys(context.metadata).sort()).toEqual(['name', 'namespace', 'resourceVersion'])
  })

  // spec.gfs has no in-repo writer the fixture could call, so its shape is pinned to the
  // apiserver schema that every writer (kubectl, GitOps) must satisfy.
  it('builds spec.gfs mounts with exactly the keys the Context CRD declares', () => {
    const crd = parse(
      readFileSync(resolve(__dirname, '../../../../charts/clerum-crds/crds/context.yaml'), 'utf8')
    )
    const mountSchema =
      crd.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.gfs.properties.mounts
        .items
    const context = buildContextResource({
      spec: {
        gfs: { mounts: [{ drive: 'main', target: '/team/docs', scopes: ['gfs.read'] }] },
      },
    })

    for (const mount of context.spec.gfs?.mounts ?? []) {
      expect(Object.keys(mount).sort()).toEqual([...mountSchema.required].sort())
      expect(Object.keys(mount).sort()).toEqual(Object.keys(mountSchema.properties).sort())
      for (const scope of mount.scopes) {
        expect(mountSchema.properties.scopes.items.enum).toContain(scope)
      }
    }
  })
})
