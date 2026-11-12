import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ElectronApplication, type TestInfo, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAIN_ENTRY,
  assertAllowedTarget,
  desktopCredentials,
  launchDesktopApp,
  validateMainEntry,
} from './e2e-playwright/qa-recorder-helpers'

describe('QA recorder target guard', () => {
  const previousRemoteOptIn = process.env.QA_RECORDER_ALLOW_REMOTE
  const previousEnvFilePresent = process.env.EVENFIRE_ENV_FILE_PRESENT
  const previousDesktopPassword = process.env.E2E_DESKTOP_PASSWORD
  const previousTestPassword = process.env.E2E_TEST_PASSWORD
  const previousAdminPassword = process.env.ADMIN_PASSWORD

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousRemoteOptIn === undefined) delete process.env.QA_RECORDER_ALLOW_REMOTE
    else process.env.QA_RECORDER_ALLOW_REMOTE = previousRemoteOptIn
    if (previousEnvFilePresent === undefined) delete process.env.EVENFIRE_ENV_FILE_PRESENT
    else process.env.EVENFIRE_ENV_FILE_PRESENT = previousEnvFilePresent
    if (previousDesktopPassword === undefined) delete process.env.E2E_DESKTOP_PASSWORD
    else process.env.E2E_DESKTOP_PASSWORD = previousDesktopPassword
    if (previousTestPassword === undefined) delete process.env.E2E_TEST_PASSWORD
    else process.env.E2E_TEST_PASSWORD = previousTestPassword
    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD
    else process.env.ADMIN_PASSWORD = previousAdminPassword
  })

  it('awaits loopback health and fails before the journey when it is unavailable', async () => {
    delete process.env.QA_RECORDER_ALLOW_REMOTE
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      assertAllowedTarget('CONTROL_API_BASE_URL', 'http://127.0.0.1:36238')
    ).rejects.toThrow(/CONTROL_API_BASE_URL not healthy/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('only returns after the loopback health check succeeds', async () => {
    delete process.env.QA_RECORDER_ALLOW_REMOTE
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      assertAllowedTarget('CONTROL_API_BASE_URL', 'http://127.0.0.1:36238')
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:36238/health')
  })

  it('allows the seeded default only when no env file exists', () => {
    process.env.EVENFIRE_ENV_FILE_PRESENT = '0'
    delete process.env.E2E_DESKTOP_PASSWORD
    delete process.env.E2E_TEST_PASSWORD
    delete process.env.ADMIN_PASSWORD
    expect(desktopCredentials().password).toBe('changeme123!')
  })

  it('fails closed when an env file exists without a password', () => {
    process.env.EVENFIRE_ENV_FILE_PRESENT = '1'
    delete process.env.E2E_DESKTOP_PASSWORD
    delete process.env.E2E_TEST_PASSWORD
    delete process.env.ADMIN_PASSWORD
    expect(() => desktopCredentials()).toThrow(
      /password is missing from the canonical repository \.env/i
    )
  })
})

describe('QA recorder Desktop main entry', () => {
  let root: string
  let mainEntry: string
  let testInfo: TestInfo
  let launchMock: MockInstance<typeof electron.launch>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-main-entry-'))
    mainEntry = path.join(root, 'build-a', 'dist', 'main.js')
    fs.mkdirSync(path.dirname(mainEntry), { recursive: true })
    // A filesystem validation fixture, never executed as an Electron entry.
    fs.writeFileSync(mainEntry, 'export {}\n')
    testInfo = { outputPath: (...parts: string[]) => path.join(root, 'run', ...parts) } as TestInfo
    launchMock = vi.spyOn(electron, 'launch').mockImplementation(async options => {
      const argument = options!.args![0]!
      const userData = argument.slice('--user-data-dir='.length)
      return {
        evaluate: vi.fn().mockResolvedValue(userData),
        firstWindow: vi.fn().mockResolvedValue({ waitForLoadState: vi.fn() }),
        close: vi.fn(),
      } as unknown as ElectronApplication
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('launches both absolute build entries on the same isolated profile', async () => {
    const afterEntry = path.join(root, 'build-b', 'dist', 'main.js')
    fs.mkdirSync(path.dirname(afterEntry), { recursive: true })
    fs.copyFileSync(mainEntry, afterEntry)
    await launchDesktopApp(testInfo, 'issue-1091-ab', mainEntry)
    await launchDesktopApp(testInfo, 'issue-1091-ab', afterEntry)
    expect(launchMock).toHaveBeenCalledTimes(2)
    const [beforeOptions] = launchMock.mock.calls[0]!
    const [afterOptions] = launchMock.mock.calls[1]!
    expect(beforeOptions!.args).toEqual([
      `--user-data-dir=${path.join(root, 'run/electron-isolation/user-data')}`,
      mainEntry,
    ])
    expect(afterOptions!.args).toEqual([beforeOptions!.args![0], afterEntry])
    for (const [options] of launchMock.mock.calls) {
      expect(options!.env).toMatchObject({
        EVENFIRE_DEV_ISOLATION: '1',
        EVENFIRE_DEV_ISOLATION_TARGET: 'issue-1091-ab',
        EVENFIRE_DEV_ISOLATION_RUN_DIR: path.join(root, 'run/electron-isolation'),
        EVENFIRE_DEV_ISOLATION_APP_PATH: path.dirname(options!.args![1]!),
        CLERUM_DESKTOP_CONFIG_PATH: path.join(root, 'run/electron-isolation/runtime-config.json'),
      })
    }
  })

  it('keeps the default entry and non-isolated user-data path', async () => {
    const originalExists = fs.existsSync.bind(fs),
      originalStat = fs.statSync.bind(fs)
    vi.spyOn(fs, 'existsSync').mockImplementation(
      value => value === MAIN_ENTRY || originalExists(value)
    )
    vi.spyOn(fs, 'statSync').mockImplementation(value =>
      originalStat(value === MAIN_ENTRY ? mainEntry : value)
    )
    await launchDesktopApp(testInfo)
    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [`--user-data-dir=${path.join(root, 'run/electron-user-data')}`, MAIN_ENTRY],
      })
    )
  })

  it.each(['relative', 'wrong directory', 'wrong basename', 'missing file', 'directory'])(
    'rejects %s before launch, with a valid-launch witness',
    async kind => {
      let invalidEntry: string
      if (kind === 'relative') invalidEntry = 'build-a/dist/main.js'
      else if (kind === 'wrong directory') {
        invalidEntry = path.join(root, 'main.js')
        fs.copyFileSync(mainEntry, invalidEntry)
      } else if (kind === 'wrong basename') {
        invalidEntry = path.join(root, 'build-a/dist/other.js')
        fs.copyFileSync(mainEntry, invalidEntry)
      } else if (kind === 'missing file') invalidEntry = path.join(root, 'missing/dist/main.js')
      else {
        invalidEntry = path.join(root, 'directory/dist/main.js')
        fs.mkdirSync(invalidEntry, { recursive: true })
      }
      const mkdir = vi.spyOn(fs, 'mkdirSync')
      await expect(launchDesktopApp(testInfo, 'issue-1091-ab', invalidEntry)).rejects.toThrow(
        /absolute path ending in dist\/main.js|Desktop app build missing/
      )
      expect(launchMock).not.toHaveBeenCalled()
      expect(mkdir).not.toHaveBeenCalled()
      validateMainEntry(mainEntry)
      await launchDesktopApp(testInfo, 'issue-1091-ab', mainEntry)
      expect(launchMock).toHaveBeenCalledTimes(1)
      expect(mkdir).toHaveBeenCalled()
    }
  )
})
