import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  discardPreparedMacInstaller,
  promoteVerifiedMacInstaller,
  reconcileMacDmgMount,
  reconcileMacInstallerCache,
  saveVerifiedMacInstaller,
  verifyMacInstallerCacheEntry,
} from '../desktopUpdateMacDmg.js'

let temporaryRoot = ''

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = ''
})

async function createFixture(
  contents = Buffer.from('original-published-dmg'),
  profile = 'isolated-profile'
) {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-manual-dmg-'))
  const userDataPath =
    profile === 'normal'
      ? path.join(temporaryRoot, 'Library', 'Application Support', 'Evenfire')
      : path.join(temporaryRoot, profile)
  const cacheDirectory = path.join(userDataPath, 'update-installers')
  const sourcePath = path.join(temporaryRoot, 'original.dmg')
  const expectedSha256 = createHash('sha256').update(contents).digest('hex')
  await mkdir(userDataPath, { recursive: true, mode: 0o700 })
  await writeFile(sourcePath, contents)
  return { userDataPath, cacheDirectory, sourcePath, contents, expectedSha256 }
}

function save(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Partial<Parameters<typeof saveVerifiedMacInstaller>[0]> = {}
) {
  const request = {
    ...fixture,
    operationId: '11111111-1111-4111-8111-111111111111',
    version: '0.12.0',
    architecture: 'arm64',
    environmentBindingId: 'test-backend-binding',
    ...overrides,
  }
  return saveVerifiedMacInstaller(request).then(async saved => {
    await promoteVerifiedMacInstaller({
      cacheDirectory: fixture.cacheDirectory,
      expected: {
        operationId: request.operationId,
        version: request.version,
        architecture: request.architecture,
        environmentBindingId: request.environmentBindingId,
        fileName: path.basename(saved.filePath),
        sha256: saved.sha256,
      },
    })
    return saved
  })
}

describe('verified macOS installer cache', () => {
  it('stores the original DMG in the active userData profile without consulting Downloads', async () => {
    const fixture = await createFixture()
    const savedEnvironment = path.join(fixture.userDataPath, 'runtime-configs', 'saved.json')
    const authState = path.join(fixture.userDataPath, 'auth', 'state.json')
    const sessionState = path.join(fixture.userDataPath, 'sessions', 'session.json')
    await mkdir(path.dirname(savedEnvironment), { recursive: true, mode: 0o700 })
    await mkdir(path.dirname(authState), { recursive: true, mode: 0o700 })
    await mkdir(path.dirname(sessionState), { recursive: true, mode: 0o700 })
    await writeFile(savedEnvironment, 'saved environment')
    await writeFile(authState, 'auth state')
    await writeFile(sessionState, 'session state')
    const saved = await save(fixture)

    expect(saved.filePath).toBe(
      path.join(await realpath(fixture.cacheDirectory), 'Evenfire-v0.12.0.dmg')
    )
    expect(path.basename(saved.filePath)).toBe('Evenfire-v0.12.0.dmg')
    expect(saved.sha256).toBe(fixture.expectedSha256)
    expect((await lstat(saved.filePath)).mode & 0o777).toBe(0o600)
    expect(await readFile(saved.filePath)).toEqual(fixture.contents)
    expect((await readdir(fixture.userDataPath)).sort()).toEqual([
      'auth',
      'runtime-configs',
      'sessions',
      'update-installers',
    ])
    expect(await readFile(savedEnvironment, 'utf8')).toBe('saved environment')
    expect(await readFile(authState, 'utf8')).toBe('auth state')
    expect(await readFile(sessionState, 'utf8')).toBe('session state')
  })

  it('uses the Electron-resolved normal Application Support profile layout', async () => {
    const fixture = await createFixture(Buffer.from('normal-profile-dmg'), 'normal')
    const saved = await save(fixture)

    expect(saved.filePath).toBe(
      path.join(await realpath(fixture.userDataPath), 'update-installers', 'Evenfire-v0.12.0.dmg')
    )
    expect(await readFile(saved.filePath)).toEqual(fixture.contents)
  })

  it('records version, architecture, backend binding, filename, and digest for reuse', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const record = JSON.parse(
      await readFile(path.join(fixture.cacheDirectory, 'current.json'), 'utf8')
    ) as Record<string, unknown>
    const expected = {
      operationId: '11111111-1111-4111-8111-111111111111',
      version: '0.12.0',
      architecture: 'arm64',
      environmentBindingId: 'test-backend-binding',
      fileName: 'Evenfire-v0.12.0.dmg',
      sha256: fixture.expectedSha256,
    }

    expect(record).toMatchObject(expected)
    expect(
      await verifyMacInstallerCacheEntry({ cacheDirectory: fixture.cacheDirectory, expected })
    ).toBe(true)
    expect(
      await verifyMacInstallerCacheEntry({
        cacheDirectory: fixture.cacheDirectory,
        expected: { ...expected, architecture: 'x64' },
      })
    ).toBe(false)
    expect(
      await verifyMacInstallerCacheEntry({
        cacheDirectory: fixture.cacheDirectory,
        expected: { ...expected, environmentBindingId: 'other-backend' },
      })
    ).toBe(false)
  })

  it('reuses an identical existing verified installer without replacing its inode', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const existingPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    const existingInode = (await lstat(existingPath)).ino

    const saved = await save(fixture, {
      operationId: '22222222-2222-4222-8222-222222222222',
    })

    expect(saved.filePath).toBe(
      path.join(await realpath(fixture.cacheDirectory), path.basename(existingPath))
    )
    expect((await lstat(existingPath)).ino).toBe(existingInode)
  })

  it('preserves the old verified installer when preparing a replacement fails', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const oldPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    const oldBytes = await readFile(oldPath)

    await expect(
      save(fixture, {
        sourcePath: path.join(temporaryRoot, 'missing-source.dmg'),
        operationId: '22222222-2222-4222-8222-222222222222',
        version: '0.13.0',
      })
    ).rejects.toThrow()

    expect(await readFile(oldPath)).toEqual(oldBytes)
    expect(await readFile(path.join(fixture.cacheDirectory, 'current.json'), 'utf8')).toContain(
      '0.12.0'
    )
  })

  it.each([
    ['disk full', 'ENOSPC'],
    ['permission denied', 'EACCES'],
  ])('cleans its owned partial after a %s write failure', async (_label, code) => {
    const fixture = await createFixture()
    await save(fixture)
    const copyInstaller = async (
      _sourcePath: string,
      _destinationPath: string,
      _signal: AbortSignal | undefined,
      writeChunk: (chunk: Uint8Array) => Promise<void>
    ) => {
      await writeChunk(Buffer.from('partial bytes'))
      throw Object.assign(new Error(_label), { code })
    }

    await expect(
      save(fixture, {
        operationId: '22222222-2222-4222-8222-222222222222',
        version: '0.13.0',
        copyInstaller,
      })
    ).rejects.toMatchObject({ code })

    expect(await readdir(fixture.cacheDirectory)).toEqual(
      expect.arrayContaining(['Evenfire-v0.12.0.dmg', 'current.json'])
    )
    expect(await readdir(fixture.cacheDirectory)).toHaveLength(2)
    expect(await readFile(path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg'))).toEqual(
      fixture.contents
    )
  })

  it('preserves a replacement file if an operation partial path changes inode', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const operationId = '22222222-2222-4222-8222-222222222222'
    const partialPath = path.join(
      fixture.cacheDirectory,
      `Evenfire-v0.13.0.dmg.partial-${operationId}`
    )
    const unrelatedBytes = Buffer.from('not owned by the interrupted updater operation')
    const copyInstaller = async (
      _sourcePath: string,
      destinationPath: string,
      _signal: AbortSignal | undefined,
      writeChunk: (chunk: Uint8Array) => Promise<void>
    ) => {
      await writeChunk(fixture.contents)
      await unlink(destinationPath)
      await writeFile(destinationPath, unrelatedBytes)
    }

    await expect(save(fixture, { operationId, version: '0.13.0', copyInstaller })).rejects.toThrow(
      'integrity check'
    )

    expect(await readFile(partialPath)).toEqual(unrelatedBytes)
    expect(await readFile(path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg'))).toEqual(
      fixture.contents
    )
  })

  it('rejects different-content and symlink collisions without writing through them', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.cacheDirectory, { mode: 0o700 })
    const occupiedPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    await writeFile(occupiedPath, 'a different installer')

    await expect(save(fixture)).rejects.toThrow('occupied')
    expect(await readFile(occupiedPath, 'utf8')).toBe('a different installer')

    const outsidePath = path.join(temporaryRoot, 'outside.dmg')
    const symlinkPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.13.0.dmg')
    await writeFile(outsidePath, 'do not follow')
    await symlink(outsidePath, symlinkPath)
    await expect(save(fixture, { version: '0.13.0' })).rejects.toThrow()
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(outsidePath, 'utf8')).toBe('do not follow')
  })

  it('does not adopt or delete an identical DMG without an updater cache record', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.cacheDirectory, { mode: 0o700 })
    const pathWithoutRecord = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    await writeFile(pathWithoutRecord, fixture.contents)

    await expect(save(fixture)).rejects.toThrow('occupied by an unrelated file')

    expect(await readFile(pathWithoutRecord)).toEqual(fixture.contents)
    expect(await readdir(fixture.cacheDirectory)).toEqual(['Evenfire-v0.12.0.dmg'])
  })

  it('replaces the retained installer only after a different target has been verified', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const oldPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    const newContents = Buffer.from('verified-next-release-dmg')
    const newSource = path.join(temporaryRoot, 'next.dmg')
    await writeFile(newSource, newContents)

    await save(fixture, {
      sourcePath: newSource,
      expectedSha256: createHash('sha256').update(newContents).digest('hex'),
      operationId: '22222222-2222-4222-8222-222222222222',
      version: '0.13.0',
    })

    expect(await readFile(path.join(fixture.cacheDirectory, 'Evenfire-v0.13.0.dmg'))).toEqual(
      newContents
    )
    await expect(lstat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the prior installer authoritative until manager promotion succeeds', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const oldPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    const newContents = Buffer.from('verified-candidate-dmg')
    const newSource = path.join(temporaryRoot, 'candidate.dmg')
    const operationId = '33333333-3333-4333-8333-333333333333'
    await writeFile(newSource, newContents)
    const prepared = await saveVerifiedMacInstaller({
      ...fixture,
      sourcePath: newSource,
      expectedSha256: createHash('sha256').update(newContents).digest('hex'),
      operationId,
      version: '0.13.0',
      architecture: 'arm64',
      environmentBindingId: 'test-backend-binding',
    })

    const current = JSON.parse(
      await readFile(path.join(fixture.cacheDirectory, 'current.json'), 'utf8')
    ) as { version: string }
    expect(current.version).toBe('0.12.0')
    expect(await readFile(oldPath)).toEqual(fixture.contents)

    await promoteVerifiedMacInstaller({
      cacheDirectory: fixture.cacheDirectory,
      expected: {
        operationId,
        version: '0.13.0',
        architecture: 'arm64',
        environmentBindingId: 'test-backend-binding',
        fileName: path.basename(prepared.filePath),
        sha256: prepared.sha256,
      },
    })

    const promoted = JSON.parse(
      await readFile(path.join(fixture.cacheDirectory, 'current.json'), 'utf8')
    ) as { version: string }
    expect(promoted.version).toBe('0.13.0')
    await expect(lstat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards a rejected candidate while preserving the prior verified installer', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const oldPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    const newContents = Buffer.from('candidate-rejected-by-backend-recheck')
    const newSource = path.join(temporaryRoot, 'rejected-candidate.dmg')
    const operationId = '44444444-4444-4444-8444-444444444444'
    await writeFile(newSource, newContents)
    const prepared = await saveVerifiedMacInstaller({
      ...fixture,
      sourcePath: newSource,
      expectedSha256: createHash('sha256').update(newContents).digest('hex'),
      operationId,
      version: '0.13.0',
      architecture: 'arm64',
      environmentBindingId: 'test-backend-binding',
    })

    await discardPreparedMacInstaller({
      cacheDirectory: fixture.cacheDirectory,
      expected: {
        operationId,
        version: '0.13.0',
        architecture: 'arm64',
        environmentBindingId: 'test-backend-binding',
        fileName: path.basename(prepared.filePath),
        sha256: prepared.sha256,
      },
    })

    const current = JSON.parse(
      await readFile(path.join(fixture.cacheDirectory, 'current.json'), 'utf8')
    ) as { version: string }
    expect(current.version).toBe('0.12.0')
    expect(await readFile(oldPath)).toEqual(fixture.contents)
    await expect(lstat(prepared.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the prior cache record when atomic candidate promotion fails', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const oldPath = path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg')
    const operationId = '55555555-5555-4555-8555-555555555555'
    const nextContents = Buffer.from('promotion-failure-candidate')
    const nextSource = path.join(temporaryRoot, 'promotion-failure.dmg')
    await writeFile(nextSource, nextContents)
    const prepared = await saveVerifiedMacInstaller({
      ...fixture,
      sourcePath: nextSource,
      expectedSha256: createHash('sha256').update(nextContents).digest('hex'),
      operationId,
      version: '0.13.0',
      architecture: 'arm64',
      environmentBindingId: 'test-backend-binding',
    })
    const unownedMetadataPath = path.join(
      fixture.cacheDirectory,
      `current.json.partial-${operationId}`
    )
    await writeFile(unownedMetadataPath, 'preserve this collision')

    await expect(
      promoteVerifiedMacInstaller({
        cacheDirectory: fixture.cacheDirectory,
        expected: {
          operationId,
          version: '0.13.0',
          architecture: 'arm64',
          environmentBindingId: 'test-backend-binding',
          fileName: path.basename(prepared.filePath),
          sha256: prepared.sha256,
        },
      })
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await discardPreparedMacInstaller({
      cacheDirectory: fixture.cacheDirectory,
      expected: {
        operationId,
        version: '0.13.0',
        architecture: 'arm64',
        environmentBindingId: 'test-backend-binding',
        fileName: path.basename(prepared.filePath),
        sha256: prepared.sha256,
      },
    })

    const current = JSON.parse(
      await readFile(path.join(fixture.cacheDirectory, 'current.json'), 'utf8')
    ) as { version: string }
    expect(current.version).toBe('0.12.0')
    expect(await readFile(oldPath)).toEqual(fixture.contents)
    expect(await readFile(unownedMetadataPath, 'utf8')).toBe('preserve this collision')
    await expect(lstat(prepared.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers a published but unrecorded target without deleting a colliding metadata file', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const operationId = '77777777-7777-4777-8777-777777777777'
    const unownedMetadataPath = path.join(
      fixture.cacheDirectory,
      `current.json.partial-${operationId}`
    )
    await writeFile(unownedMetadataPath, 'unowned metadata')

    await expect(
      save(fixture, {
        operationId,
        version: '0.13.0',
      })
    ).rejects.toMatchObject({ code: 'EEXIST' })

    const receiptPath = path.join(fixture.cacheDirectory, `partial-${operationId}.json`)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    await writeFile(receiptPath, JSON.stringify({ ...receipt, ownerPid: 2_147_483_647 }))
    await reconcileMacInstallerCache(fixture.cacheDirectory)

    await expect(
      lstat(path.join(fixture.cacheDirectory, 'Evenfire-v0.13.0.dmg'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg'))).toEqual(
      fixture.contents
    )
    expect(await readFile(unownedMetadataPath, 'utf8')).toBe('unowned metadata')
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers only an abandoned partial file named in its durable operation receipt', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.cacheDirectory, { mode: 0o700 })
    const operationId = '33333333-3333-4333-8333-333333333333'
    const fileName = 'Evenfire-v0.12.0.dmg'
    const partialName = `${fileName}.partial-${operationId}`
    await writeFile(path.join(fixture.cacheDirectory, partialName), 'interrupted-copy')
    await writeFile(path.join(fixture.cacheDirectory, 'unrelated.partial'), 'preserve-me')
    await writeFile(
      path.join(fixture.cacheDirectory, `partial-${operationId}.json`),
      JSON.stringify({
        operationId,
        version: '0.12.0',
        architecture: 'arm64',
        environmentBindingId: 'test-backend-binding',
        fileName,
        sha256: fixture.expectedSha256,
        partialName,
        ownerPid: 2147483647,
      })
    )

    await reconcileMacInstallerCache(fixture.cacheDirectory)

    await expect(lstat(path.join(fixture.cacheDirectory, partialName))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(path.join(fixture.cacheDirectory, 'unrelated.partial'), 'utf8')).toBe(
      'preserve-me'
    )
  })

  it('recovers the exact partial copy left by a SIGKILL and retains the prior installer', async () => {
    const fixture = await createFixture()
    await save(fixture)
    const unrelatedPath = path.join(fixture.cacheDirectory, 'unrelated.partial')
    await writeFile(unrelatedPath, 'preserve-me')
    const workerBundle = path.join(temporaryRoot, 'desktopUpdateMacDmg.cjs')
    const readyPath = path.join(temporaryRoot, 'copy-started')
    const workerPath = path.join(temporaryRoot, 'worker.cjs')
    await build({
      entryPoints: [path.resolve('src/desktopUpdateMacDmg.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['original-fs'],
      outfile: workerBundle,
    })
    await writeFile(
      workerPath,
      `const fs = require('node:fs/promises')
const { saveVerifiedMacInstaller } = require(${JSON.stringify(workerBundle)})
void saveVerifiedMacInstaller({
  sourcePath: ${JSON.stringify(fixture.sourcePath)},
  cacheDirectory: ${JSON.stringify(fixture.cacheDirectory)},
  operationId: '66666666-6666-4666-8666-666666666666',
  version: '0.13.0',
  architecture: 'arm64',
  environmentBindingId: 'test-backend-binding',
  expectedSha256: ${JSON.stringify(fixture.expectedSha256)},
  copyInstaller: async (_source, _destination, _signal, writeChunk) => {
    await writeChunk(Buffer.from('interrupted-copy'))
    await fs.writeFile(${JSON.stringify(readyPath)}, 'ready')
    await new Promise(() => {})
  },
})
`
    )

    const child = spawn(process.execPath, [workerPath], { stdio: 'ignore' })
    const childExit = new Promise<void>(resolve => child.once('exit', () => resolve()))
    try {
      await viWaitForFile(readyPath)
      child.kill('SIGKILL')
      await childExit
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await childExit
      }
    }

    await reconcileMacInstallerCache(fixture.cacheDirectory)

    await expect(
      lstat(
        path.join(
          fixture.cacheDirectory,
          'Evenfire-v0.13.0.dmg.partial-66666666-6666-4666-8666-666666666666'
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(fixture.cacheDirectory, 'Evenfire-v0.12.0.dmg'))).toEqual(
      fixture.contents
    )
    expect(await readFile(unrelatedPath, 'utf8')).toBe('preserve-me')
  })

  it('reclaims an owned stale mount marker only after confirming the image is absent', async () => {
    const fixture = await createFixture()
    const operationId = '44444444-4444-4444-8444-444444444444'
    const operationPath = path.join(temporaryRoot, operationId)
    const mountPath = path.join(operationPath, 'mounted-installer')
    const dmgPath = path.join(operationPath, 'verified-installer.dmg')
    const markerPath = path.join(operationPath, 'mac-dmg-mount-active.json')
    await mkdir(mountPath, { recursive: true, mode: 0o700 })
    await writeFile(dmgPath, fixture.contents)
    await writeFile(markerPath, JSON.stringify({ version: '0.12.0' }))

    await expect(
      reconcileMacDmgMount({ operationPath, operationId, expectedVersion: '0.12.0' })
    ).resolves.toBe(true)
    await expect(lstat(mountPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(dmgPath)).toEqual(fixture.contents)
  })

  it('preserves a live or identity-unknown mount recovery marker', async () => {
    const fixture = await createFixture()
    const operationId = '55555555-5555-4555-8555-555555555555'
    const operationPath = path.join(temporaryRoot, operationId)
    const mountPath = path.join(operationPath, 'mounted-installer')
    const markerPath = path.join(operationPath, 'mac-dmg-mount-active.json')
    await mkdir(mountPath, { recursive: true, mode: 0o700 })
    await writeFile(
      markerPath,
      JSON.stringify({
        operationId,
        version: '0.12.0',
        mountPath,
        dmgPath: path.join(operationPath, 'some-other-image.dmg'),
        ownerPid: process.pid,
      })
    )

    await expect(
      reconcileMacDmgMount({ operationPath, operationId, expectedVersion: '0.12.0' })
    ).resolves.toBe(false)
    expect((await lstat(mountPath)).isDirectory()).toBe(true)
    expect((await lstat(markerPath)).isFile()).toBe(true)
  })
})

async function viWaitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await lstat(filePath)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error('The interrupted installer copy did not reach its durable partial state.')
}
