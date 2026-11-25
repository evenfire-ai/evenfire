import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupNativeCommitTestHarness()
})

it('keeps an indexed profile origin on an ordinary same-binding save', async () => {
  const h = await createNativeCommitTestHarness()
  const binding = h.runtimeConfig.captureProfileOriginBinding()
  await h.runtimeConfig.persistProfileOriginForBinding(binding, 'https://profile.example.test')
  await h.runtimeConfig.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: h.restA,
    rpcProxyBaseUrl: 'https://rpc-a.example.test',
    appName: 'Renamed',
  })
  const saved = JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))
  expect(saved.appName).toBe('Renamed')
  expect(saved.profileUiBaseUrl).toBe('https://profile.example.test')
})
