import { describe, expect, it } from 'vitest'
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
})
