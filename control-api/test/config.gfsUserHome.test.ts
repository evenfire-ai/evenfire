import { afterEach, describe, expect, it, vi } from 'vitest'

const original = process.env.GFS_HOME_DRIVE

afterEach(() => {
  if (original === undefined) delete process.env.GFS_HOME_DRIVE
  else process.env.GFS_HOME_DRIVE = original
  vi.resetModules()
})

describe('user-home drive configuration', () => {
  it('requires an explicit drive and preserves a configured non-main drive', async () => {
    delete process.env.GFS_HOME_DRIVE
    vi.resetModules()
    expect((await import('../src/config.js')).config.gfsHomeDrive).toBeNull()

    process.env.GFS_HOME_DRIVE = ' branch-drive '
    vi.resetModules()
    expect((await import('../src/config.js')).config.gfsHomeDrive).toBe('branch-drive')
  })
})
