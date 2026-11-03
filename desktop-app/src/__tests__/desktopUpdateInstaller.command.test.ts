import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    expect(program).not.toContain('IsPathFullyQualified')
    expect(program).toContain('Test-FullyQualifiedWindowsPath')
    expect(program).toContain("$root -match '^[A-Za-z]:\\\\$'")
    expect(program).toContain("$root -match '^\\\\\\\\[^\\\\]+\\\\[^\\\\]+\\\\$'")
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

  it('keeps package-manager diagnostics out of the completion result channel', async () => {
    const plan = await makePlan('deb', '/environment-selected/OtherExecutable')
    launch.markerPath = path.join(plan.stageRoot, 'privileged-ready')

    await launchDesktopInstallHelper(plan)

    const rootScript = Buffer.from(launch.args.at(-1)!, 'base64').toString('utf8')
    expect(rootScript).toContain('>>"$log" 2>&1')
  })

  it('runs package completion checks in the shell that decides install success', async () => {
    const plan = await makePlan('deb', '/environment-selected/OtherExecutable')
    launch.markerPath = path.join(plan.stageRoot, 'privileged-ready')

    await launchDesktopInstallHelper(plan)

    expect(launch.standardInput).toContain('version_now() {')
    expect(launch.standardInput).toContain('asar_now() {')
    expect(launch.standardInput).toContain('"$(version_now)" != "$version"')
    expect(launch.standardInput).toContain('"$(asar_now)" != "$targetAsar"')
  })

  it('returns clean installed and rollback tokens despite native package-manager output', async () => {
    const plan = await makePlan('deb', '/environment-selected/OtherExecutable')
    launch.markerPath = path.join(plan.stageRoot, 'privileged-ready')
    await writeFile(
      path.join(plan.operationPath, 'operation.json'),
      JSON.stringify({ id: plan.operationId })
    )

    await launchDesktopInstallHelper(plan)

    const binDirectory = path.join(temporaryRoot, 'stub-bin')
    await mkdir(binDirectory)
    const statePath = path.join(temporaryRoot, 'installed-version')
    const targetAsarPath = path.join(plan.payload.appPath, 'resources', 'app.asar')
    const installedAsarPath = path.join(plan.location.installRoot, 'resources', 'app.asar')
    const oldAsarPath = path.join(temporaryRoot, 'old-app.asar')
    const targetBytes = Buffer.from('verified app archive')
    const oldBytes = Buffer.from('installed app archive')
    await writeFile(oldAsarPath, oldBytes)
    await writeFile(plan.payload.packagePath, 'target package bytes')
    await writeFile(plan.rollbackPackagePath!, 'rollback package bytes')
    const targetHash = createHash('sha256')
      .update(await readFile(plan.payload.packagePath))
      .digest('hex')
    const rollbackHash = createHash('sha256')
      .update(await readFile(plan.rollbackPackagePath!))
      .digest('hex')
    const targetAsar = createHash('sha256').update(targetBytes).digest('hex')
    const oldAsar = createHash('sha256').update(oldBytes).digest('hex')
    const dpkgPath = path.join(binDirectory, 'dpkg')
    const queryPath = path.join(binDirectory, 'dpkg-query')
    const checksumPath = path.join(binDirectory, 'sha256sum')
    const writeExecutable = async (filePath: string, source: string) => {
      await writeFile(filePath, source)
      await chmod(filePath, 0o700)
    }
    await writeExecutable(
      dpkgPath,
      `#!/bin/sh\nprintf 'native package manager stdout\\n'\nprintf 'native package manager stderr\\n' >&2\ncase "$2" in\n  */target.pkg) printf '0.12.0' > ${JSON.stringify(statePath)}; if [ "${'${FORCE_TARGET_MISMATCH:-}'}" = 1 ]; then cp ${JSON.stringify(oldAsarPath)} ${JSON.stringify(installedAsarPath)}; else cp ${JSON.stringify(targetAsarPath)} ${JSON.stringify(installedAsarPath)}; fi ;;\n  */rollback.pkg) printf '0.11.0' > ${JSON.stringify(statePath)}; cp ${JSON.stringify(oldAsarPath)} ${JSON.stringify(installedAsarPath)} ;;\n  *) exit 12 ;;\nesac\n`
    )
    await writeExecutable(queryPath, `#!/bin/sh\ncat ${JSON.stringify(statePath)}\n`)
    await writeExecutable(checksumPath, '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n')

    const rootScript = Buffer.from(launch.args.at(-1)!, 'base64')
      .toString('utf8')
      .replaceAll('/usr/bin/dpkg-query', queryPath)
      .replaceAll('/usr/bin/dpkg', dpkgPath)
      .replaceAll('/usr/bin/sha256sum', checksumPath)
      .replaceAll('/usr/bin/chmod', '/bin/chmod')
      .replaceAll('/usr/bin/cp', '/bin/cp')
      .replaceAll('/usr/bin/rm', '/bin/rm')
    const scriptPath = path.join(temporaryRoot, 'root-helper.sh')
    await writeFile(scriptPath, rootScript)
    const run = (expectedVersion: string, expectedAsar: string, forceMismatch = false) =>
      execFileSync(
        '/bin/sh',
        [
          scriptPath,
          plan.operationPath,
          plan.operationId,
          'deb',
          'install',
          plan.payload.packagePath,
          targetHash,
          plan.rollbackPackagePath!,
          rollbackHash,
          '0.12.0',
          expectedVersion,
          targetAsar,
          expectedAsar,
          path.join(plan.location.installRoot, 'Evenfire'),
          '2147483647',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, FORCE_TARGET_MISMATCH: forceMismatch ? '1' : '0' },
        }
      )

    await writeFile(installedAsarPath, oldBytes)
    const installedResult = run('0.11.0', oldAsar)
    expect(installedResult).toBe('installed')
    expect(await readFile(path.join(plan.operationPath, 'package-manager.log'), 'utf8')).toContain(
      'native package manager stdout'
    )

    await writeFile(installedAsarPath, oldBytes)
    const rollbackResult = run('0.11.0', oldAsar, true)
    expect(rollbackResult).toBe('rollback')
  })

  it('checks the outer Linux completion in its own shell and rolls back version or hash mismatch', async () => {
    const plan = await makePlan('deb', '/environment-selected/OtherExecutable')
    launch.markerPath = path.join(plan.stageRoot, 'privileged-ready')
    await launchDesktopInstallHelper(plan)

    const binDirectory = path.join(temporaryRoot, 'outer-stubs')
    await mkdir(binDirectory)
    const versionPath = path.join(temporaryRoot, 'outer-version')
    const digestPath = path.join(temporaryRoot, 'outer-digest')
    const callCountPath = path.join(temporaryRoot, 'pkexec-calls')
    const casePath = path.join(temporaryRoot, 'outer-case')
    const appPidPath = path.join(temporaryRoot, 'launched-app.pid')
    const executablePath = path.join(plan.location.installRoot, 'Evenfire')
    const targetAsar = launch.args[11]!
    const writeExecutable = async (filePath: string, source: string) => {
      await writeFile(filePath, source)
      await chmod(filePath, 0o700)
    }
    const queryPath = path.join(binDirectory, 'dpkg-query')
    const checksumPath = path.join(binDirectory, 'sha256sum')
    const pkexecPath = path.join(binDirectory, 'pkexec')
    await writeExecutable(queryPath, `#!/bin/sh\n/bin/cat ${JSON.stringify(versionPath)}\n`)
    await writeExecutable(checksumPath, `#!/bin/sh\n/bin/cat ${JSON.stringify(digestPath)}\n`)
    await writeExecutable(
      pkexecPath,
      `#!/bin/sh\n/bin/cat >/dev/null\ncalls=0\n[ ! -f ${JSON.stringify(callCountPath)} ] || calls=$(/bin/cat ${JSON.stringify(callCountPath)})\ncalls=$((calls + 1))\nprintf '%s' "$calls" > ${JSON.stringify(callCountPath)}\nif [ "$calls" -eq 1 ]; then\n  case "$(/bin/cat ${JSON.stringify(casePath)})" in\n    version) printf '0.99.0' > ${JSON.stringify(versionPath)}; printf '%s' ${JSON.stringify(targetAsar)} > ${JSON.stringify(digestPath)} ;;\n    hash) printf '0.12.0' > ${JSON.stringify(versionPath)}; printf 'wrong-hash' > ${JSON.stringify(digestPath)} ;;\n    *) printf '0.12.0' > ${JSON.stringify(versionPath)}; printf '%s' ${JSON.stringify(targetAsar)} > ${JSON.stringify(digestPath)} ;;\n  esac\n  printf installed\nelse\n  printf '0.11.0' > ${JSON.stringify(versionPath)}; printf '%s' ${JSON.stringify(plan.currentAsarSha256)} > ${JSON.stringify(digestPath)}; printf rollback\nfi\n`
    )
    await writeExecutable(
      executablePath,
      `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(appPidPath)}\nprintf started > "$STARTUP_MARKER"\nexec /bin/sleep 5\n`
    )
    const outerScript = launch.standardInput
      .replace('PATH=/usr/bin:/bin; export PATH', `PATH=${binDirectory}:/usr/bin:/bin; export PATH`)
      .replaceAll('/usr/bin/dpkg-query', queryPath)
      .replaceAll('/usr/bin/sha256sum', checksumPath)
      .replaceAll('/usr/bin/pkexec', pkexecPath)
      .replaceAll('/usr/bin/sleep', '/bin/sleep')
      .replaceAll('/usr/bin/rm', '/bin/rm')
    const outerScriptPath = path.join(temporaryRoot, 'outer-helper.sh')
    await writeFile(outerScriptPath, outerScript)

    const runCase = async (kind: 'healthy' | 'version' | 'hash') => {
      await mkdir(plan.operationPath, { recursive: true, mode: 0o700 })
      await writeFile(
        path.join(plan.operationPath, 'operation.json'),
        JSON.stringify({ id: plan.operationId })
      )
      await writeFile(path.join(plan.stageRoot, 'pending.json'), '{}')
      await writeFile(casePath, kind)
      await rm(callCountPath, { force: true })
      const startupMarker = path.join(plan.operationPath, 'startup-ok.json')
      await rm(startupMarker, { force: true })
      const args = launch.args.slice(1)
      args[8] = executablePath
      const invoke = () =>
        execFileSync('/bin/sh', ['-c', outerScript, 'outer-helper', ...args], {
          encoding: 'utf8',
          env: { ...process.env, STARTUP_MARKER: startupMarker },
        })
      if (kind === 'healthy') {
        expect(invoke()).toBe('')
      } else {
        try {
          invoke()
          throw new Error('The failed post-startup check unexpectedly succeeded.')
        } catch (error) {
          expect(error).toMatchObject({ status: 1 })
        }
      }
      try {
        process.kill(Number(await readFile(appPidPath, 'utf8')), 'SIGTERM')
      } catch {
        // The helper may already have stopped the failed target process during rollback.
      }
      expect(await readFile(callCountPath, 'utf8')).toBe(kind === 'healthy' ? '1' : '2')
      await expect(readFile(plan.pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }

    await runCase('healthy')
    await runCase('version')
    await runCase('hash')
  })
})
