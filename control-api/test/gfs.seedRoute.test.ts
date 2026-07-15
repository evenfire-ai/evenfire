import { describe, expect, it } from 'vitest'
import { SeedResourceStore } from '../src/gfs/seedResources.js'
import { seedRootDirectoriesToHttp } from '../src/routes/gfs/seed.js'

class FakeStore implements SeedResourceStore {
  calls: { drive: string; parentResourceId: string | null; name: string }[] = []
  private seq = 0
  async ensureDirectory(input: {
    drive: string
    parentResourceId: string | null
    name: string
    pathCache: string
  }): Promise<string> {
    this.calls.push({
      drive: input.drive,
      parentResourceId: input.parentResourceId,
      name: input.name,
    })
    return `res-${++this.seq}`
  }
}

describe('seedRootDirectoriesToHttp', () => {
  it('400 when drive is missing', async () => {
    const out = await seedRootDirectoriesToHttp(new FakeStore(), { rootDirectories: ['/org'] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'missing_drive' })
  })

  it('400 when rootDirectories is not a string[]', async () => {
    expect(
      (await seedRootDirectoriesToHttp(new FakeStore(), { drive: 'main', rootDirectories: 'x' }))
        .status
    ).toBe(400)
    expect(
      (await seedRootDirectoriesToHttp(new FakeStore(), { drive: 'main', rootDirectories: [1, 2] }))
        .status
    ).toBe(400)
  })

  it('200 + seeds the root and the requested directories', async () => {
    const store = new FakeStore()
    const out = await seedRootDirectoriesToHttp(store, {
      drive: 'main',
      rootDirectories: ['/org', '/system/published-workflow-artifacts'],
    })
    expect(out.status).toBe(200)
    // The synthetic root is always ensured first (parent=null, name='').
    expect(store.calls[0]).toMatchObject({ drive: 'main', parentResourceId: null, name: '' })
    expect(store.calls.some(c => c.name === 'org')).toBe(true)
    expect(store.calls.some(c => c.name === 'published-workflow-artifacts')).toBe(true)
    expect(out.body).toHaveProperty('rootResourceId')
  })

  it('accepts an empty rootDirectories list (just ensures the root)', async () => {
    const store = new FakeStore()
    const out = await seedRootDirectoriesToHttp(store, { drive: 'main', rootDirectories: [] })
    expect(out.status).toBe(200)
    expect(store.calls).toHaveLength(1) // only the root
  })
})
