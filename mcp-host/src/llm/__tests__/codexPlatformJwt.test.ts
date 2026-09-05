import { afterEach, describe, expect, it } from 'vitest'
import {
  readCodexPlatformJwt,
  refreshCodexPlatformJwt,
  setCodexPlatformJwtReader,
  setCodexPlatformJwtRefresh,
} from '../codexPlatformJwt'

describe('codexPlatformJwt', () => {
  afterEach(() => {
    setCodexPlatformJwtReader(() => (process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN || '').trim())
    setCodexPlatformJwtRefresh(async () => undefined)
  })

  it('reads the live runtime holder instead of a frozen boot env token', () => {
    const previous = process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN
    process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN = 'boot-env-token'
    try {
      setCodexPlatformJwtReader(() => 'rotated-runtime-token')
      expect(readCodexPlatformJwt()).toBe('rotated-runtime-token')
    } finally {
      if (previous === undefined) delete process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN
      else process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN = previous
    }
  })

  it('invokes the registered refresh hook', async () => {
    let refreshed = false
    setCodexPlatformJwtRefresh(async () => {
      refreshed = true
    })
    await refreshCodexPlatformJwt()
    expect(refreshed).toBe(true)
  })
})
