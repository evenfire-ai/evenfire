import { describe, expect, it, vi } from 'vitest'
import { type GfscReadClient, buildGfsReadTools } from './gfs'
import type { GfsMetadataSnapshot } from './gfsContentRead'

const resourceId = '0123456789abcdef0123456789abcdef'
const snapshot: GfsMetadataSnapshot = {
  source: {
    kind: 'gfs',
    drive: 'main',
    resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    name: 'strong-fit.csv',
    version: 7,
  },
  size: 3_836_961,
}

describe('GFS workspace delivery capability', () => {
  it('does not read an over-inline body when workspace delivery is unavailable', async () => {
    const read = vi.fn()
    const client: GfscReadClient = {
      accessible: vi.fn(),
      list: vi.fn(),
      read,
      readMetadata: vi.fn(async () => snapshot),
      stat: vi.fn(),
      resolve: vi.fn(),
    }
    const tools = buildGfsReadTools(client, { referencedFiles: new Map() })
    expect(tools.map(tool => tool.name)).not.toContain('clerum__gfs_download')

    const readTool = tools.find(tool => tool.name === 'clerum__gfs_read')
    expect(readTool).toBeDefined()
    const result = await readTool!.execute({ drive: 'main', resourceId }, '/tmp/outputs')

    expect(result.success).toBe(true)
    expect(JSON.parse(result.content as string)).toMatchObject({
      availability: 'workspace_delivery_unavailable',
      sizeBytes: 3_836_961,
    })
    expect(read).not.toHaveBeenCalled()
  })
})
