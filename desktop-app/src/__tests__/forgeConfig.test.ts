import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const forgeConfig = require('../../forge.config.js') as {
  packagerConfig?: { asar?: boolean; derefSymlinks?: boolean }
}

describe('Electron Forge packaging', () => {
  it('copies local file dependencies into the app before creating the ASAR archive', () => {
    expect(forgeConfig.packagerConfig).toMatchObject({
      asar: true,
      derefSymlinks: true,
    })
  })
})
