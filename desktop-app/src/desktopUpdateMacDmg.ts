import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { verifyAppTree, verifyMacReleaseSignature } from './desktopUpdateArtifacts.js'
import {
  openRegularFileNoFollow,
  readFileSha256,
  readRegularFileNoFollow,
  updaterFileSystem,
} from './desktopUpdateFileSystem.js'

const { createReadStream } = updaterFileSystem
const { link, lstat, mkdir, open, realpath, rename, rm, rmdir, unlink } = updaterFileSystem.promises

const INSTALLER_CACHE_RECORD = 'current.json'
const OPERATION_ID_PATTERN = /^[0-9a-f-]{36}$/i

export type MacInstallerCacheEntry = {
  operationId: string
  version: string
  architecture: 'x64' | 'arm64'
  environmentBindingId: string
  fileName: string
  sha256: string
}

type MacInstallerRetiredEntry = Pick<MacInstallerCacheEntry, 'version' | 'fileName' | 'sha256'>
type MacInstallerCacheRecord = MacInstallerCacheEntry & {
  retiredInstallers: MacInstallerRetiredEntry[]
}
type MacInstallerPartialReceipt = MacInstallerCacheEntry & {
  partialName: string
  ownerPid: number
}

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

async function unlinkIfIdentity(
  filePath: string,
  expected: { dev: number; ino: number } | null
): Promise<void> {
  if (!expected) return
  try {
    const current = await lstat(filePath)
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    ) {
      await unlink(filePath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export type VerifiedMacInstaller = {
  filePath: string
  sha256: string
}

function isSafeInstallerName(value: unknown, version: string): value is string {
  return (
    typeof value === 'string' &&
    value === `Evenfire-v${version}.dmg` &&
    path.basename(value) === value
  )
}

function isCacheEntry(value: unknown): value is MacInstallerCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.operationId === 'string' &&
    OPERATION_ID_PATTERN.test(entry.operationId) &&
    typeof entry.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(entry.version) &&
    (entry.architecture === 'x64' || entry.architecture === 'arm64') &&
    typeof entry.environmentBindingId === 'string' &&
    entry.environmentBindingId.length > 0 &&
    entry.environmentBindingId.length <= 256 &&
    isSafeInstallerName(entry.fileName, entry.version) &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256)
  )
}

async function ensureInstallerCache(cacheDirectory: string): Promise<string> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
  const info = await lstat(cacheDirectory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  ) {
    throw new Error('The macOS installer cache directory is not safe.')
  }
  return realpath(cacheDirectory)
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
  operationId: string
): Promise<void> {
  const temporaryPath = `${filePath}.partial-${operationId}`
  let createdIdentity: { dev: number; ino: number } | null = null
  try {
    const file = await open(temporaryPath, 'wx', 0o600)
    try {
      const identity = await file.stat()
      createdIdentity = { dev: identity.dev, ino: identity.ino }
      await file.writeFile(`${JSON.stringify(value)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, filePath)
    createdIdentity = null
  } catch (error) {
    if (createdIdentity) {
      try {
        const current = await lstat(temporaryPath)
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === createdIdentity.dev &&
          current.ino === createdIdentity.ino
        ) {
          await unlink(temporaryPath)
        }
      } catch {
        // Keep uncertain temporary files for later reconciliation.
      }
    }
    throw error
  }
}

async function readCacheRecord(cacheDirectory: string): Promise<MacInstallerCacheRecord | null> {
  try {
    const bytes = await readRegularFileNoFollow(
      path.join(cacheDirectory, INSTALLER_CACHE_RECORD),
      64 * 1024
    )
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      !isCacheEntry(value) ||
      !Array.isArray((value as MacInstallerCacheRecord).retiredInstallers)
    ) {
      return null
    }
    const retiredInstallers = (value as MacInstallerCacheRecord).retiredInstallers
    if (
      retiredInstallers.some(
        entry =>
          !entry ||
          typeof entry !== 'object' ||
          !isSafeInstallerName(entry.fileName, entry.version) ||
          typeof entry.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
    ) {
      return null
    }
    return value as MacInstallerCacheRecord
  } catch {
    return null
  }
}

async function ownedRegularFile(cacheDirectory: string, fileName: string) {
  const filePath = path.join(cacheDirectory, fileName)
  const info = await lstat(filePath)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  ) {
    throw new Error('The macOS installer cache contains an unsafe file.')
  }
  return { filePath, info }
}

async function mountedState(imagePath: string): Promise<boolean | null> {
  if (process.platform !== 'darwin') return false
  let expectedImagePath: string
  try {
    expectedImagePath = await realpath(imagePath)
  } catch {
    return null
  }
  const info = spawnSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8', timeout: 15_000 })
  if (info.error || info.status !== 0 || typeof info.stdout !== 'string') return null
  const blocks = info.stdout.split(/(?=\nimage-path\s*:)/)
  return blocks.some(block => {
    const image = block.match(/\nimage-path\s*:\s*(.+)\s*$/m)?.[1]?.trim()
    return image === expectedImagePath
  })
}

async function removeRetiredInstallers(
  cacheDirectory: string,
  record: MacInstallerCacheRecord
): Promise<MacInstallerRetiredEntry[]> {
  const retained: MacInstallerRetiredEntry[] = []
  for (const entry of record.retiredInstallers) {
    if (entry.fileName === record.fileName) continue
    try {
      const { filePath } = await ownedRegularFile(cacheDirectory, entry.fileName)
      if (
        (await readFileSha256(filePath)) !== entry.sha256 ||
        (await mountedState(filePath)) !== false
      ) {
        retained.push(entry)
        continue
      }
      await unlink(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained.push(entry)
    }
  }
  return retained
}

export async function reconcileMacDmgMount(args: {
  operationPath: string
  operationId: string
  expectedVersion: string
}): Promise<boolean> {
  const markerPath = path.join(args.operationPath, 'mac-dmg-mount-active.json')
  let marker: unknown
  try {
    marker = JSON.parse((await readRegularFileNoFollow(markerPath, 16 * 1024)).toString('utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false
  const entry = marker as Record<string, unknown>
  const expectedDmgPath = path.join(args.operationPath, 'verified-installer.dmg')
  const expectedMountPath = path.join(args.operationPath, 'mounted-installer')
  const legacyMarker = entry.operationId === undefined
  if (
    entry.version !== args.expectedVersion ||
    (legacyMarker
      ? Object.keys(entry).some(key => key !== 'version')
      : entry.operationId !== args.operationId ||
        entry.dmgPath !== expectedDmgPath ||
        entry.mountPath !== expectedMountPath ||
        typeof entry.ownerPid !== 'number' ||
        !Number.isSafeInteger(entry.ownerPid) ||
        entry.ownerPid < 1)
  ) {
    return false
  }
  if (!legacyMarker) {
    try {
      process.kill(entry.ownerPid as number, 0)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
    }
  }
  const mounted = await mountedState(expectedDmgPath)
  if (mounted !== false) return false
  try {
    const mountInfo = await lstat(expectedMountPath)
    if (
      !mountInfo.isDirectory() ||
      mountInfo.isSymbolicLink() ||
      (typeof process.getuid === 'function' && mountInfo.uid !== process.getuid())
    ) {
      return false
    }
    await rmdir(expectedMountPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  try {
    const markerInfo = await lstat(markerPath)
    if (
      !markerInfo.isFile() ||
      markerInfo.isSymbolicLink() ||
      (typeof process.getuid === 'function' && markerInfo.uid !== process.getuid())
    ) {
      return false
    }
    await unlink(markerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  return true
}

export async function verifyMacInstallerCacheEntry(args: {
  cacheDirectory: string
  expected: MacInstallerCacheEntry
  hashFile?: typeof readFileSha256
}): Promise<boolean> {
  try {
    const cacheDirectory = await ensureInstallerCache(args.cacheDirectory)
    const record = await readCacheRecord(cacheDirectory)
    if (
      !record ||
      record.operationId !== args.expected.operationId ||
      record.version !== args.expected.version ||
      record.architecture !== args.expected.architecture ||
      record.environmentBindingId !== args.expected.environmentBindingId ||
      record.fileName !== args.expected.fileName ||
      record.sha256 !== args.expected.sha256
    ) {
      return false
    }
    const { filePath } = await ownedRegularFile(cacheDirectory, record.fileName)
    return (await (args.hashFile ?? readFileSha256)(filePath)) === record.sha256
  } catch {
    return false
  }
}

export async function reconcileMacInstallerCache(cacheDirectory: string): Promise<void> {
  const resolvedCache = await ensureInstallerCache(cacheDirectory)
  const record = await readCacheRecord(resolvedCache)
  if (record) {
    const retiredInstallers = await removeRetiredInstallers(resolvedCache, record)
    if (retiredInstallers.length !== record.retiredInstallers.length) {
      await writeAtomicJson(
        path.join(resolvedCache, INSTALLER_CACHE_RECORD),
        { ...record, retiredInstallers },
        record.operationId
      )
    }
  }

  const entries = await updaterFileSystem.promises.readdir(resolvedCache, { withFileTypes: true })
  for (const item of entries) {
    const match = /^partial-([0-9a-f-]{36})\.json$/i.exec(item.name)
    if (!match || !item.isFile() || item.isSymbolicLink()) continue
    const receiptPath = path.join(resolvedCache, item.name)
    let receipt: unknown
    try {
      receipt = JSON.parse((await readRegularFileNoFollow(receiptPath, 16 * 1024)).toString('utf8'))
    } catch {
      continue
    }
    if (
      !isCacheEntry(receipt) ||
      receipt.operationId !== match[1] ||
      typeof (receipt as MacInstallerPartialReceipt).partialName !== 'string' ||
      (receipt as MacInstallerPartialReceipt).partialName !==
        `${receipt.fileName}.partial-${receipt.operationId}` ||
      !Number.isSafeInteger((receipt as MacInstallerPartialReceipt).ownerPid)
    ) {
      continue
    }
    const owned = receipt as MacInstallerPartialReceipt
    try {
      process.kill(owned.ownerPid, 0)
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
    }
    if (record?.fileName === owned.fileName && record.sha256 === owned.sha256) {
      await unlink(receiptPath).catch(() => undefined)
      continue
    }
    const partialPath = path.join(resolvedCache, owned.partialName)
    try {
      const { info } = await ownedRegularFile(resolvedCache, owned.partialName)
      if (typeof process.getuid !== 'function' || info.uid === process.getuid()) {
        await unlink(partialPath)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
    if (record?.fileName !== owned.fileName) {
      try {
        const { filePath } = await ownedRegularFile(resolvedCache, owned.fileName)
        if ((await readFileSha256(filePath)) === owned.sha256) await unlink(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
      }
    }
    await unlink(receiptPath).catch(() => undefined)
  }
}

export async function verifyMacInstallerDmg(args: {
  dmgPath: string
  mountPath: string
  operationId: string
  version: string
  architecture: 'x64' | 'arm64'
}): Promise<void> {
  const markerPath = path.join(path.dirname(args.mountPath), 'mac-dmg-mount-active.json')
  if (!OPERATION_ID_PATTERN.test(args.operationId)) {
    throw new Error('The macOS installer verification operation is invalid.')
  }
  await mkdir(args.mountPath, { recursive: false, mode: 0o700 })
  const marker = await open(markerPath, 'wx', 0o600)
  await marker.writeFile(
    JSON.stringify({
      operationId: args.operationId,
      version: args.version,
      architecture: args.architecture,
      dmgPath: args.dmgPath,
      mountPath: args.mountPath,
      ownerPid: process.pid,
    })
  )
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

export async function saveVerifiedMacInstaller(args: {
  sourcePath: string
  cacheDirectory: string
  operationId: string
  version: string
  architecture: 'x64' | 'arm64'
  environmentBindingId: string
  expectedSha256: string
  signal?: AbortSignal
  linkFile?: typeof updaterFileSystem.promises.link
  copyInstaller?: (
    sourcePath: string,
    destinationPath: string,
    signal: AbortSignal | undefined,
    writeChunk: (chunk: Uint8Array) => Promise<void>
  ) => Promise<void>
}): Promise<VerifiedMacInstaller> {
  if (!OPERATION_ID_PATTERN.test(args.operationId) || !/^\d+\.\d+\.\d+$/.test(args.version)) {
    throw new Error('The macOS installer cache request is invalid.')
  }
  const cacheDirectory = await ensureInstallerCache(args.cacheDirectory)
  const expectedSourceHash = await readFileSha256(args.sourcePath)
  if (expectedSourceHash !== args.expectedSha256) {
    throw new Error('The extracted macOS installer changed before it could be saved.')
  }

  const fileName = `Evenfire-v${args.version}.dmg`
  const destination = path.join(cacheDirectory, fileName)
  const partialName = `${fileName}.partial-${args.operationId}`
  const temporaryPath = path.join(cacheDirectory, partialName)
  const receiptPath = path.join(cacheDirectory, `partial-${args.operationId}.json`)
  const expected: MacInstallerCacheEntry = {
    operationId: args.operationId,
    version: args.version,
    architecture: args.architecture,
    environmentBindingId: args.environmentBindingId,
    fileName,
    sha256: expectedSourceHash,
  }
  const previous = await readCacheRecord(cacheDirectory)
  const receipt: MacInstallerPartialReceipt = {
    ...expected,
    partialName,
    ownerPid: process.pid,
  }
  let temporaryExists = false
  let temporaryIdentity: { dev: number; ino: number } | null = null
  let receiptExists = false
  let preserveReceiptForRecovery = false
  try {
    throwIfAborted(args.signal)
    const owner = await open(receiptPath, 'wx', 0o600)
    receiptExists = true
    try {
      await owner.writeFile(`${JSON.stringify(receipt)}\n`)
      await owner.sync()
    } finally {
      await owner.close()
    }

    try {
      const existing = await ownedRegularFile(cacheDirectory, fileName)
      if (
        previous?.fileName === fileName &&
        previous.sha256 === expectedSourceHash &&
        (await readFileSha256(existing.filePath)) === expectedSourceHash
      ) {
        preserveReceiptForRecovery = true
        return { filePath: existing.filePath, sha256: expectedSourceHash }
      }
      if (previous?.fileName !== fileName)
        throw new Error('The macOS installer cache filename is occupied by an unrelated file.')
      throw new Error('The cached macOS installer for this version has different content.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporaryFile = await open(temporaryPath, 'wx', 0o600)
    temporaryExists = true
    try {
      const temporaryStats = await temporaryFile.stat()
      temporaryIdentity = { dev: temporaryStats.dev, ino: temporaryStats.ino }
      const writeChunk = async (chunk: Uint8Array) => {
        throwIfAborted(args.signal)
        await temporaryFile.write(chunk)
      }
      if (args.copyInstaller) {
        await args.copyInstaller(args.sourcePath, temporaryPath, args.signal, writeChunk)
      } else {
        for await (const chunk of createReadStream(args.sourcePath)) {
          await writeChunk(chunk)
        }
      }
      await temporaryFile.chmod(0o600)
      await temporaryFile.sync()
    } finally {
      await temporaryFile.close()
    }
    throwIfAborted(args.signal)
    const savedTemporary = await openRegularFileNoFollow(temporaryPath)
    try {
      await savedTemporary.handle.chmod(0o600)
      await savedTemporary.handle.sync()
    } finally {
      await savedTemporary.handle.close()
    }
    if ((await readFileSha256(temporaryPath)) !== expectedSourceHash) {
      throw new Error('The saved macOS installer did not pass its integrity check.')
    }
    throwIfAborted(args.signal)

    throwIfAborted(args.signal)
    await (args.linkFile ?? link)(temporaryPath, destination)
    preserveReceiptForRecovery = true
    if (args.signal?.aborted) {
      await unlinkIfSameFile(temporaryPath, destination)
      preserveReceiptForRecovery = false
      throw new Error('Desktop update download canceled.')
    }
    await unlink(temporaryPath)
    temporaryExists = false
    return { filePath: destination, sha256: expectedSourceHash }
  } finally {
    if (temporaryExists) {
      try {
        await unlinkIfIdentity(temporaryPath, temporaryIdentity)
      } catch {
        preserveReceiptForRecovery = true
      }
    }
    if (receiptExists && !preserveReceiptForRecovery)
      await unlink(receiptPath).catch(() => undefined)
  }
}

export async function promoteVerifiedMacInstaller(args: {
  cacheDirectory: string
  expected: MacInstallerCacheEntry
  signal?: AbortSignal
}): Promise<void> {
  const cacheDirectory = await ensureInstallerCache(args.cacheDirectory)
  const receiptPath = path.join(cacheDirectory, `partial-${args.expected.operationId}.json`)
  const receipt = JSON.parse(
    (await readRegularFileNoFollow(receiptPath, 16 * 1024)).toString('utf8')
  ) as unknown
  if (
    !isCacheEntry(receipt) ||
    receipt.operationId !== args.expected.operationId ||
    receipt.version !== args.expected.version ||
    receipt.architecture !== args.expected.architecture ||
    receipt.environmentBindingId !== args.expected.environmentBindingId ||
    receipt.fileName !== args.expected.fileName ||
    receipt.sha256 !== args.expected.sha256 ||
    (receipt as MacInstallerPartialReceipt).ownerPid !== process.pid ||
    (receipt as MacInstallerPartialReceipt).partialName !==
      `${args.expected.fileName}.partial-${args.expected.operationId}`
  ) {
    throw new Error('The prepared macOS installer could not be promoted safely.')
  }
  const { filePath } = await ownedRegularFile(cacheDirectory, args.expected.fileName)
  if ((await readFileSha256(filePath)) !== args.expected.sha256) {
    throw new Error('The prepared macOS installer changed before it could be promoted.')
  }

  const previous = await readCacheRecord(cacheDirectory)
  const retiredInstallers = [...(previous?.retiredInstallers ?? [])]
  if (
    previous &&
    previous.fileName !== args.expected.fileName &&
    !retiredInstallers.some(
      entry => entry.fileName === previous.fileName && entry.sha256 === previous.sha256
    )
  ) {
    retiredInstallers.push({
      version: previous.version,
      fileName: previous.fileName,
      sha256: previous.sha256,
    })
  }
  let nextRecord: MacInstallerCacheRecord = { ...args.expected, retiredInstallers }
  const recordPath = path.join(cacheDirectory, INSTALLER_CACHE_RECORD)
  throwIfAborted(args.signal)
  await writeAtomicJson(recordPath, nextRecord, args.expected.operationId)

  try {
    const retained = await removeRetiredInstallers(cacheDirectory, nextRecord)
    if (retained.length !== nextRecord.retiredInstallers.length) {
      nextRecord = { ...nextRecord, retiredInstallers: retained }
      await writeAtomicJson(recordPath, nextRecord, args.expected.operationId)
    }
  } catch {
    // The new record is authoritative; cleanup retries on the next startup.
  }
  await unlink(receiptPath).catch(() => undefined)
}

export async function discardPreparedMacInstaller(args: {
  cacheDirectory: string
  expected: MacInstallerCacheEntry
}): Promise<void> {
  const cacheDirectory = await ensureInstallerCache(args.cacheDirectory)
  const receiptPath = path.join(cacheDirectory, `partial-${args.expected.operationId}.json`)
  let receipt: unknown
  try {
    receipt = JSON.parse((await readRegularFileNoFollow(receiptPath, 16 * 1024)).toString('utf8'))
  } catch {
    return
  }
  if (
    !isCacheEntry(receipt) ||
    receipt.operationId !== args.expected.operationId ||
    receipt.version !== args.expected.version ||
    receipt.architecture !== args.expected.architecture ||
    receipt.environmentBindingId !== args.expected.environmentBindingId ||
    receipt.fileName !== args.expected.fileName ||
    receipt.sha256 !== args.expected.sha256 ||
    (receipt as MacInstallerPartialReceipt).ownerPid !== process.pid ||
    (receipt as MacInstallerPartialReceipt).partialName !==
      `${args.expected.fileName}.partial-${args.expected.operationId}`
  ) {
    return
  }
  const current = await readCacheRecord(cacheDirectory)
  if (current?.operationId !== args.expected.operationId) {
    try {
      const { filePath } = await ownedRegularFile(cacheDirectory, args.expected.fileName)
      if (
        current?.fileName !== args.expected.fileName &&
        (await readFileSha256(filePath)) === args.expected.sha256 &&
        (await mountedState(filePath)) === false
      ) {
        await unlink(filePath)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
  }
  await unlink(receiptPath).catch(() => undefined)
}
