import { afterEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareVerifiedDesktopPayload } from '../desktopUpdateArtifacts.js'
import { launchDesktopInstallHelper } from '../desktopUpdateInstaller.js'
import type { DesktopInstallPlan } from '../desktopUpdateInstaller.js'

const launch = vi.hoisted(() => ({
  command: '',
  args: [] as string[],
  markerPath: '',
  standardInput: '',
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const fs = await import('node:fs/promises')

  return {
    ...actual,
    spawn: (command: string, args: string[] = []) => {
      launch.command = command
      launch.args = [...args]
      const child = new EventEmitter() as EventEmitter & {
        stdin: InstanceType<typeof PassThrough>
        unref: () => void
      }
      child.stdin = new PassThrough()
      child.stdin.on('data', chunk => {
        launch.standardInput += String(chunk)
      })
      child.unref = () => undefined
      setTimeout(() => {
        void fs.writeFile(launch.markerPath, '12345').then(() => child.emit('spawn'))
      }, 0)
      return child
    },
  }
})

describe('Windows updater helper process inputs', () => {
  let temporaryRoot = ''

  afterEach(async () => {
    launch.command = ''
    launch.args = []
    launch.markerPath = ''
    launch.standardInput = ''
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  })

  it('keeps install paths out of the PowerShell program and passes them as JSON data', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-command-'))
    const stageRoot = path.join(temporaryRoot, 'desktop-update-staging')
    const operationId = '123e4567-e89b-42d3-a456-426614174000'
    const operationPath = path.join(stageRoot, operationId)
    const payloadRoot = path.join(operationPath, 'payload')
    const appPath = path.join(payloadRoot, 'application')
    const resourcesPath = path.join(appPath, 'resources')
    await mkdir(resourcesPath, { recursive: true, mode: 0o700 })
    await writeFile(path.join(operationPath, 'operation.json'), '{}')
    await writeFile(path.join(payloadRoot, 'EvenfireSetup.exe'), 'verified setup package')
    await writeFile(path.join(resourcesPath, 'app.asar'), 'verified app archive')

    const installRoot = String.raw`C:\Users\O'Connor\AppData\Local\Programs\Evenfire`
    launch.markerPath = path.join(operationPath, 'helper.pid')

    const previousSystemRoot = process.env.SystemRoot
    const previousWindir = process.env.WINDIR
    process.env.SystemRoot = String.raw`C:\Windows`
    try {
      await launchDesktopInstallHelper({
        operationId,
        operationPath,
        stageRoot,
        pendingPath: path.join(stageRoot, 'pending.json'),
        currentVersion: '0.11.0',
        currentAsarSha256: 'c'.repeat(64),
        targetPackageSha256: 'd'.repeat(64),
        location: {
          platform: 'win32',
          architecture: 'x64',
          packageType: 'squirrel',
          installRoot,
          appPath: path.join(installRoot, 'app-0.11.0'),
          executablePath: path.join(installRoot, 'app-0.11.0', 'Evenfire.exe'),
          updateExecutablePath: path.join(installRoot, 'Update.exe'),
        },
        payload: {
          packageType: 'squirrel',
          packagePath: path.join(payloadRoot, 'EvenfireSetup.exe'),
          appPath,
          appVersion: '0.12.0',
          appId: 'ai.evenfire.desktop',
          architecture: 'x64',
          updaterCapable: true,
          assetName: 'evenfire-desktop-v0.12.0-windows-x64.zip',
          assetSha256: 'a'.repeat(64),
          assetSize: 12,
        },
      })
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = previousSystemRoot
      if (previousWindir === undefined) delete process.env.WINDIR
      else process.env.WINDIR = previousWindir
    }

    expect(launch.command).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
    )
    const encodedIndex = launch.args.indexOf('-EncodedCommand')
    expect(encodedIndex).toBeGreaterThanOrEqual(0)
    const program = Buffer.from(launch.args[encodedIndex + 1]!, 'base64').toString('utf16le')
    expect(program).not.toContain("O''Connor")
    expect(JSON.parse(launch.standardInput)).toMatchObject({
      installRoot,
      operationId,
    })
  })
})

describe('Linux updater helper executable identity', () => {
  let temporaryRoot = ''

  afterEach(async () => {
    launch.command = ''
    launch.args = []
    launch.markerPath = ''
    launch.standardInput = ''
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  })

  async function makePlan(
    packageType: 'app-zip' | 'deb',
    executablePath: string
  ): Promise<DesktopInstallPlan> {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-linux-update-command-'))
    const stageRoot = path.join(temporaryRoot, 'desktop-update-staging')
    const operationId = '123e4567-e89b-42d3-a456-426614174000'
    const operationPath = path.join(stageRoot, operationId)
    const payloadRoot = path.join(operationPath, 'payload')
    const appPath = path.join(payloadRoot, 'Evenfire-linux-x64')
    const resourcesPath = path.join(appPath, 'resources')
    const installRoot = path.join(temporaryRoot, 'Evenfire-linux-x64')
    await mkdir(resourcesPath, { recursive: true, mode: 0o700 })
    await mkdir(operationPath, { recursive: true, mode: 0o700 })
    await mkdir(path.join(installRoot, 'resources'), { recursive: true, mode: 0o700 })
    await writeFile(path.join(operationPath, 'operation.json'), '{}')
    await writeFile(path.join(resourcesPath, 'app.asar'), 'verified app archive')
    await writeFile(path.join(installRoot, 'resources', 'app.asar'), 'installed app archive')
    await writeFile(path.join(installRoot, 'Evenfire'), 'verified executable', { mode: 0o700 })

    return {
      operationId,
      operationPath,
      stageRoot,
      pendingPath: path.join(stageRoot, 'pending.json'),
      currentVersion: '0.11.0',
      currentAsarSha256: 'c'.repeat(64),
      targetPackageSha256: 'd'.repeat(64),
      rollbackPackagePath: path.join(payloadRoot, 'rollback.deb'),
      rollbackPackageSha256: 'e'.repeat(64),
      location: {
        platform: 'linux',
        architecture: 'x64',
        packageType,
        installRoot,
        appPath: installRoot,
        executablePath,
      },
      payload: {
        packageType,
        packagePath: path.join(payloadRoot, 'target.deb'),
        appPath,
        appVersion: '0.12.0',
        appId: 'ai.evenfire.desktop',
        architecture: 'x64',
        updaterCapable: true,
        assetName: 'evenfire-desktop-v0.12.0-linux-x64.zip',
        assetSha256: 'a'.repeat(64),
        assetSize: 12,
      },
    }
  }

  it('relaunches the fixed Forge ZIP executable instead of an uncontrolled path', async () => {
    const plan = await makePlan('app-zip', '/environment-selected/OtherExecutable')
    launch.markerPath = path.join(plan.operationPath, 'helper.pid')

    await launchDesktopInstallHelper(plan)

    expect(launch.command).toBe('/bin/sh')
    expect(launch.args[0]).toBe('-s')
    expect(launch.standardInput).toContain('./Evenfire')
    expect(launch.args).not.toContain('OtherExecutable')
  })

  it.skipIf(!process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR)(
    'uses the published Forge ZIP layout for the Linux helper command',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-linux-release-command-'))
      const operationId = '123e4567-e89b-42d3-a456-426614174000'
      const stageRoot = path.join(temporaryRoot, 'desktop-update-staging')
      const operationPath = path.join(stageRoot, operationId)
      const payloadRoot = path.join(operationPath, 'payload')
      await mkdir(operationPath, { recursive: true, mode: 0o700 })
      await mkdir(payloadRoot)
      await writeFile(path.join(operationPath, 'operation.json'), '{}')
      const payload = await prepareVerifiedDesktopPayload({
        archivePath: path.join(
          process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR!,
          'linux-v0.12.0.zip'
        ),
        destination: payloadRoot,
        version: '0.12.0',
        platform: 'linux',
        architecture: 'x64',
        packageType: 'app-zip',
      })
      const installRoot = path.join(temporaryRoot, 'Evenfire-linux-x64')
      await cp(payload.appPath, installRoot, { recursive: true })
      const unexpectedExecutable = path.join(installRoot, 'OtherExecutable')
      await cp(path.join(installRoot, 'Evenfire'), unexpectedExecutable)
      launch.markerPath = path.join(operationPath, 'helper.pid')

      await launchDesktopInstallHelper({
        operationId,
        operationPath,
        stageRoot,
        pendingPath: path.join(stageRoot, 'pending.json'),
        currentVersion: '0.11.0',
        currentAsarSha256: 'c'.repeat(64),
        targetPackageSha256: 'd'.repeat(64),
        location: {
          platform: 'linux',
          architecture: 'x64',
          packageType: 'app-zip',
          installRoot,
          appPath: installRoot,
          executablePath: unexpectedExecutable,
        },
        payload,
      })

      expect(launch.command).toBe('/bin/sh')
      expect(launch.args[0]).toBe('-s')
      expect(launch.args[1]).toBe(stageRoot)
      expect(launch.args).not.toContain('evenfire-update-helper')
      expect(launch.standardInput).toContain('PATH=/usr/bin:/bin; export PATH')
      expect(launch.standardInput).toContain('./Evenfire')
      expect(launch.args).not.toContain(unexpectedExecutable)
    }
  )

  it('uses the fixed package-owned executable when launching a native package update', async () => {
    const plan = await makePlan('deb', '/environment-selected/OtherExecutable')
    launch.markerPath = path.join(plan.stageRoot, 'privileged-ready')

    await launchDesktopInstallHelper(plan)

    expect(launch.command).toBe('/bin/sh')
    expect(launch.args[0]).toBe('-s')
    expect(launch.standardInput).toContain('pkexec /bin/sh -s "$stage"')
    expect(launch.standardInput).toContain('/usr/bin/base64 --decode')
    const rootScript = Buffer.from(launch.args.at(-1)!, 'base64').toString('utf8')
    expect(rootScript).toContain('PATH=/usr/bin:/bin; export PATH')
    expect(launch.args).not.toContain('/environment-selected/OtherExecutable')
    expect(launch.args).toContain('/usr/lib/evenfire/Evenfire')
    expect(rootScript).toContain('/usr/bin/dpkg-query')
  })
})

describe('macOS updater target trust checks', () => {
  let temporaryRoot = ''

  afterEach(async () => {
    launch.command = ''
    launch.args = []
    launch.markerPath = ''
    launch.standardInput = ''
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  })

  it('rechecks the exact Developer ID team before and after replacement', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-mac-update-command-'))
    const stageRoot = path.join(temporaryRoot, 'desktop-update-staging')
    const operationId = '123e4567-e89b-42d3-a456-426614174000'
    const operationPath = path.join(stageRoot, operationId)
    const installRoot = path.join(temporaryRoot, 'Evenfire.app')
    const stagedApp = path.join(operationPath, 'payload', 'Evenfire.app')
    await mkdir(operationPath, { recursive: true, mode: 0o700 })
    await mkdir(path.join(installRoot, 'Contents', 'Resources'), { recursive: true })
    await mkdir(path.join(stagedApp, 'Contents', 'Resources'), { recursive: true })
    await writeFile(path.join(operationPath, 'operation.json'), '{}')
    await writeFile(path.join(installRoot, 'Contents', 'Resources', 'app.asar'), 'source')
    await writeFile(path.join(stagedApp, 'Contents', 'Resources', 'app.asar'), 'target')
    launch.markerPath = path.join(operationPath, 'helper.pid')

    await launchDesktopInstallHelper({
      operationId,
      operationPath,
      stageRoot,
      pendingPath: path.join(stageRoot, 'pending.json'),
      currentVersion: '0.11.9',
      currentAsarSha256: 'c'.repeat(64),
      targetPackageSha256: 'd'.repeat(64),
      location: {
        platform: 'darwin',
        architecture: 'arm64',
        packageType: 'app-zip',
        installRoot,
        appPath: installRoot,
        executablePath: path.join(installRoot, 'Contents', 'MacOS', 'Evenfire'),
      },
      payload: {
        packageType: 'app-zip',
        packagePath: path.join(operationPath, 'payload', 'release.zip'),
        appPath: stagedApp,
        appVersion: '0.12.0',
        appId: 'ai.evenfire.desktop',
        architecture: 'arm64',
        updaterCapable: false,
        assetName: 'evenfire-desktop-v0.12.0-mac-arm64.zip',
        assetSha256: 'a'.repeat(64),
        assetSize: 12,
      },
    })

    expect(launch.command).toBe('/bin/launchctl')
    expect(launch.args.slice(0, 3)).toEqual([
      'submit',
      '-l',
      `ai.evenfire.desktop.update.${operationId}`,
    ])
    const program = launch.args[launch.args.indexOf('-c') + 1]!
    expect(launch.standardInput).toBe('')
    expect(program).toContain('/usr/bin/codesign --verify --deep --strict')
    expect(program).toContain("grep '^TeamIdentifier='")
    expect(program).toContain('[ "$signer" = \'TeamIdentifier=XV6G8QZD5D\' ]')
    expect(program).toContain('verify_target "$fresh"')
    expect(program).toContain('verify_target "$app"')
    expect(program).toContain('/usr/sbin/spctl --assess --type execute')
  })
})
