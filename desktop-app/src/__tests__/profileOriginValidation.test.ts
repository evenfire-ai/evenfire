import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const previousPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let directory: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-validation-'))
  process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(directory, 'profile.json')
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: { isReady: () => false, isPackaged: false, setName: vi.fn(), setPath: vi.fn() },
  }))
})

afterEach(async () => {
  if (previousPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = previousPath
  vi.doUnmock('electron')
  vi.resetModules()
  await fs.rm(directory, { recursive: true, force: true })
})

it.each([
  ['http://127.attacker.example', 'http://127.0.0.1:8091'],
  ['https://localhost.', 'https://api.example.test'],
  ['http://localhost.:3001/..', 'http://127.0.0.1:8091'],
  ['http://localhost.:3001/%2e%2e', 'http://127.0.0.1:8091'],
  ['http://localhost.:3001/?', 'http://127.0.0.1:8091'],
  ['http://localhost.:3001/#', 'http://127.0.0.1:8091'],
  ['http://localhost.:3001\\', 'http://127.0.0.1:8091'],
  ['https://user:pass@profile.example.test', 'https://api.example.test'],
])('rejects invalid or unpaired origin %s', async (origin, rest) => {
  const runtime = await import('../config.js')
  expect(() => runtime.validateProfileUiOrigin(origin, rest)).toThrow()
})

it.each([
  ['http://localhost.:3001', 'http://127.0.0.1:8091'],
  ['http://127.4.5.6:3001', 'http://127.0.0.1:8091'],
  ['https://10.0.0.5', 'https://api.example.test'],
])('accepts the scoped valid origin %s', async (origin, rest) => {
  const runtime = await import('../config.js')
  expect(runtime.validateProfileUiOrigin(origin, rest)).toBe(origin)
})
