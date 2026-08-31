import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-test-userdata-'))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => testUserDataDir),
    isPackaged: false,
    isReady: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
    getName: vi.fn(() => 'Evenfire'),
  },
}))

const LOCALHOST_EXTERNAL = 'http://127.0.0.1:8091'
const LOCALHOST_RPC = 'http://127.0.0.1:8094'

async function loadState() {
  vi.resetModules()
  const config = await import('../config.js')
  // getDesktopRuntimeConfigState hydrates first, so this is the value the
  // renderer actually receives — not the pre-hydrate one.
  return config.getDesktopRuntimeConfigState()
}

describe('EVENFIRE_ONBOARDING_PREVIEW', () => {
  const saved = {
    external: process.env.EXTERNAL_REST_API_BASE_URL,
    rpc: process.env.RPC_PROXY_BASE_URL,
    preview: process.env.EVENFIRE_ONBOARDING_PREVIEW,
    explicit: process.env.CLERUM_DESKTOP_CONFIG_PATH,
  }

  beforeEach(() => {
    delete process.env.EVENFIRE_ONBOARDING_PREVIEW
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  })

  afterEach(() => {
    for (const [key, value] of [
      ['EXTERNAL_REST_API_BASE_URL', saved.external],
      ['RPC_PROXY_BASE_URL', saved.rpc],
      ['EVENFIRE_ONBOARDING_PREVIEW', saved.preview],
      ['CLERUM_DESKTOP_CONFIG_PATH', saved.explicit],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.resetModules()
  })

  it('defaults to off: an env-configured app stays configured', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = LOCALHOST_EXTERNAL
    process.env.RPC_PROXY_BASE_URL = LOCALHOST_RPC

    expect((await loadState()).configured).toBe(true)
  })

  it('ignores any value other than "true"', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = LOCALHOST_EXTERNAL
    process.env.RPC_PROXY_BASE_URL = LOCALHOST_RPC
    process.env.EVENFIRE_ONBOARDING_PREVIEW = 'false'

    expect((await loadState()).configured).toBe(true)

    process.env.EVENFIRE_ONBOARDING_PREVIEW = '1'
    expect((await loadState()).configured).toBe(true)
  })

  it('starts cold when enabled, even with the make local-app runtime vars set', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = LOCALHOST_EXTERNAL
    process.env.RPC_PROXY_BASE_URL = LOCALHOST_RPC
    process.env.EVENFIRE_ONBOARDING_PREVIEW = 'true'

    // configured === false is what routes the renderer to onboarding.
    expect((await loadState()).configured).toBe(false)
  })

  it('reads and writes a separate directory, never the real runtime config', async () => {
    process.env.EVENFIRE_ONBOARDING_PREVIEW = 'true'
    const previewPath = (await loadState()).storagePath

    delete process.env.EVENFIRE_ONBOARDING_PREVIEW
    const realPath = (await loadState()).storagePath

    expect(previewPath).not.toBe(realPath)
    expect(previewPath).toContain('runtime-configs-onboarding-preview')
    expect(realPath).toMatch(/runtime-configs$/)
  })

  it('survives hydration under a real `make local-app` launch', async () => {
    // Regression: hydrateDesktopRuntimeConfig re-pinned the Localhost option
    // whenever the app was launched with --evenfire-desktop-dev-package AND
    // localhost endpoints — exactly what `make local-app` does. That flipped
    // `configured` back to true after boot, so the app opened on sign-in while
    // the boot log still claimed onboarding.
    process.argv.push('--evenfire-desktop-dev-package')
    try {
      process.env.EXTERNAL_REST_API_BASE_URL = LOCALHOST_EXTERNAL
      process.env.RPC_PROXY_BASE_URL = LOCALHOST_RPC
      process.env.EVENFIRE_ONBOARDING_PREVIEW = 'true'

      const state = await loadState()

      expect(state.configured).toBe(false)
      expect(state.activeOptionId).not.toBe('__localhost__')
    } finally {
      process.argv = process.argv.filter(a => a !== '--evenfire-desktop-dev-package')
    }
  })

  it('still pins Localhost for a dev-package launch when preview is off', async () => {
    process.argv.push('--evenfire-desktop-dev-package')
    try {
      process.env.EXTERNAL_REST_API_BASE_URL = LOCALHOST_EXTERNAL
      process.env.RPC_PROXY_BASE_URL = LOCALHOST_RPC

      const state = await loadState()

      expect(state.configured).toBe(true)
    } finally {
      process.argv = process.argv.filter(a => a !== '--evenfire-desktop-dev-package')
    }
  })

  it('starts cold again after a previous preview selected an environment', async () => {
    // Regression: selecting Localhost (or saving) inside the preview wrote
    // activeProfileId into the preview's own directory, so the NEXT launch
    // came up configured and went to sign-in. The switch showed onboarding
    // once and then quietly stopped working.
    const previewDir = path.join(
      testUserDataDir,
      'runtime-configs-onboarding-preview'
    )
    fs.mkdirSync(previewDir, { recursive: true })
    fs.writeFileSync(
      path.join(previewDir, 'index.json'),
      JSON.stringify({ version: 1, activeProfileId: '__localhost__', profiles: [] })
    )

    process.env.EVENFIRE_ONBOARDING_PREVIEW = 'true'

    const state = await loadState()

    expect(state.configured).toBe(false)
    expect(state.activeOptionId).not.toBe('__localhost__')
  })

  it('does not let an explicit config path hand the preview an environment', async () => {
    process.env.EVENFIRE_ONBOARDING_PREVIEW = 'true'
    process.env.CLERUM_DESKTOP_CONFIG_PATH = '/tmp/evenfire-explicit/runtime-config.json'

    const state = await loadState()

    expect(state.configured).toBe(false)
    expect(state.storagePath).toContain('runtime-configs-onboarding-preview')
  })
})
