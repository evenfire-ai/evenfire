import { describe, expect, it } from 'vitest'
import { CLERUM_OAUTH_PROTOCOL, SANDBOX_UI_DEEP_LINK_PROTOCOL } from '@clerum/desktop-app-links'

const forgeConfig = require('../../forge.config.js') as {
  packagerConfig?: {
    asar?: boolean
    derefSymlinks?: boolean
    protocols?: Array<{ schemes?: string[] }>
  }
}

describe('Electron Forge packaging', () => {
  it('copies local file dependencies into the app before creating the ASAR archive', () => {
    expect(forgeConfig.packagerConfig).toMatchObject({
      asar: true,
      derefSymlinks: true,
    })
  })

  it('registers the protocol schemes from the shared desktop-link contract', () => {
    expect(forgeConfig.packagerConfig?.protocols).toEqual([
      {
        name: 'Evenfire',
        schemes: [SANDBOX_UI_DEEP_LINK_PROTOCOL.replace(/:$/, '')],
      },
      {
        name: 'Clerum OAuth callback',
        schemes: [CLERUM_OAUTH_PROTOCOL.replace(/:$/, '')],
      },
    ])
  })
})
