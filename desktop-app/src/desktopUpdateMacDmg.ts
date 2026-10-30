import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { verifyAppTree, verifyMacReleaseSignature } from './desktopUpdateArtifacts.js'
import {
  openRegularFileNoFollow,
  readFileSha256,
  updaterFileSystem,
} from './desktopUpdateFileSystem.js'

const { createReadStream, createWriteStream } = updaterFileSystem
const { lstat, mkdir, open, realpath, rm, rmdir, unlink } = updaterFileSystem.promises

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Desktop update download canceled.')
}

async function unlinkIfSameFile(firstPath: string, secondPath: string): Promise<void> {
  try {
    const [first, second] = await Promise.all([lstat(firstPath), lstat(secondPath)])
    if (
      first.isFile() &&
      !first.isSymbolicLink() &&
      second.isFile() &&
      !second.isSymbolicLink() &&
      first.dev === second.dev &&
      first.ino === second.ino
    ) {
      await unlink(secondPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export type VerifiedMacInstaller = {
  filePath: string
  sha256: string
}

export async function verifyMacInstallerDmg(args: {
  dmgPath: string
  mountPath: string
  version: string
  architecture: 'x64' | 'arm64'
}): Promise<void> {
  const markerPath = path.join(path.dirname(args.mountPath), 'mac-dmg-mount-active.json')
  await mkdir(args.mountPath, { recursive: false, mode: 0o700 })
  const marker = await open(markerPath, 'wx', 0o600)
  await marker.writeFile(JSON.stringify({ version: args.version }))
  await marker.sync()
  await marker.close()

  let safeToRemoveMarker = false
  try {
    const attach = spawnSync(
      '/usr/bin/hdiutil',
      [
        'attach',
        '-plist',
        '-readonly',
        '-nobrowse',
        '-noautoopen',
        '-mountpoint',
        args.mountPath,
        args.dmgPath,
      ],
      { encoding: 'utf8', timeout: 120_000 }
    )
    if (attach.error || attach.status !== 0) {
      throw new Error('The downloaded macOS installer disk image could not be mounted safely.')
    }
    const entries = await updaterFileSystem.promises.readdir(args.mountPath, {
      withFileTypes: true,
    })
    const apps = entries.filter(entry => entry.name.toLowerCase().endsWith('.app'))
    if (apps.length !== 1 || apps[0]?.name !== 'Evenfire.app' || !apps[0].isDirectory()) {
      throw new Error('The macOS installer does not contain one expected Evenfire application.')
    }
    const appPath = path.join(args.mountPath, apps[0].name)
    const verified = await verifyAppTree(appPath, args.version, 'darwin', args.architecture)
    if (verified.appId !== 'ai.evenfire.desktop') {
      throw new Error('The macOS installer application identity could not be verified.')
    }
    verifyMacReleaseSignature(appPath)
  } finally {
    const detached = spawnSync('/usr/bin/hdiutil', ['detach', args.mountPath], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (!detached.error && detached.status === 0) safeToRemoveMarker = true
    if (safeToRemoveMarker) {
      await rm(markerPath, { force: true })
      await rmdir(args.mountPath)
    } else {
      throw new Error(
        'The installer disk image could not be detached safely; its recovery staging was preserved.'
      )
    }
  }
}

async function existingIdenticalFile(filePath: string, expectedSha256: string): Promise<boolean> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink()) return false
    return (await readFileSha256(filePath)) === expectedSha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function saveVerifiedMacInstaller(args: {
  sourcePath: string
  downloadsDirectory: string
  version: string
  expectedSha256: string
  signal?: AbortSignal
  linkFile?: typeof updaterFileSystem.promises.link
}): Promise<VerifiedMacInstaller> {
  const downloadsInfo = await lstat(args.downloadsDirectory)
  if (!downloadsInfo.isDirectory() || downloadsInfo.isSymbolicLink()) {
    throw new Error('The Downloads folder is not a safe directory.')
  }
  const downloadsDirectory = await realpath(args.downloadsDirectory)
  const expectedSourceHash = await readFileSha256(args.sourcePath)
  if (expectedSourceHash !== args.expectedSha256) {
    throw new Error('The extracted macOS installer changed before it could be saved.')
  }

  const baseName = `Evenfire-v${args.version}.dmg`
  const parsed = path.parse(baseName)
  const temporaryPath = path.join(downloadsDirectory, `.evenfire-${randomUUID()}.dmg.tmp`)
  let temporaryExists = false
  try {
    throwIfAborted(args.signal)
    const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
    temporaryExists = true
    await pipeline(createReadStream(args.sourcePath), output, { signal: args.signal })
    throwIfAborted(args.signal)
    const savedTemporary = await openRegularFileNoFollow(temporaryPath)
    try {
      await savedTemporary.handle.chmod(0o644)
      await savedTemporary.handle.sync()
    } finally {
      await savedTemporary.handle.close()
    }
    if ((await readFileSha256(temporaryPath)) !== expectedSourceHash) {
      throw new Error('The saved macOS installer did not pass its integrity check.')
    }
    throwIfAborted(args.signal)

    for (let suffix = 0; suffix < 1000; suffix += 1) {
      throwIfAborted(args.signal)
      const name = suffix === 0 ? baseName : `${parsed.name} (${suffix})${parsed.ext}`
      const destination = path.join(downloadsDirectory, name)
      if (await existingIdenticalFile(destination, expectedSourceHash)) {
        throwIfAborted(args.signal)
        return { filePath: destination, sha256: expectedSourceHash }
      }
      try {
        throwIfAborted(args.signal)
        await (args.linkFile ?? updaterFileSystem.promises.link)(temporaryPath, destination)
        if (args.signal?.aborted) {
          await unlinkIfSameFile(temporaryPath, destination)
          throw new Error('Desktop update download canceled.')
        }
        await unlink(temporaryPath)
        temporaryExists = false
        return { filePath: destination, sha256: expectedSourceHash }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('A safe filename for the macOS installer could not be created in Downloads.')
  } finally {
    if (temporaryExists) await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
