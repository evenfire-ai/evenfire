import { extractFile } from '@electron/asar'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, symlink, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { openRegularFileNoFollow } from './desktopUpdateFileSystem.js'

const GITHUB_REPOSITORY = 'evenfire-ai/evenfire'
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPOSITORY}`
const RELEASES_BASE = `https://github.com/${GITHUB_REPOSITORY}/releases`
const MAX_RELEASE_BYTES = 512 * 1024 * 1024
const MAX_ZIP_ENTRIES = 50_000
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024
const MAX_ARCHIVE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 250
const MAX_SYMLINK_BYTES = 4096
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])

export type DesktopReleasePlatform = 'darwin' | 'win32' | 'linux'
export type DesktopReleaseArchitecture = 'x64' | 'arm64'
export type DesktopReleasePackageType = 'app-zip' | 'squirrel' | 'deb' | 'rpm'

export type GitHubReleaseAsset = {
  name: string
  size: number
  digest: string
  browserDownloadUrl: string
}

export type VerifiedDesktopPayload = {
  packageType: DesktopReleasePackageType
  packagePath: string
  appPath: string
  appVersion: string
  appId: string
  architecture: DesktopReleaseArchitecture
  updaterCapable: boolean
  assetName: string
  assetSha256: string
  assetSize: number
}

export type ArchiveProgress = (progress: {
  percent: number
  transferred: number
  total: number
}) => void

type GitHubAssetRecord = {
  name?: unknown
  size?: unknown
  digest?: unknown
  browser_download_url?: unknown
  state?: unknown
}

type GitHubReleaseRecord = {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

type SafeEntry = {
  entry: Entry
  name: string
  isDirectory: boolean
  isSymlink: boolean
  mode: number
}

export function compareDesktopVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a[index] ?? 0
    const rightPart = b[index] ?? 0
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  return 0
}

function parseVersion(version: string): [number, number, number] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('The Desktop release version is not a stable x.y.z version.')
  }
  const parts = version.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error('The Desktop release version contains an invalid number.')
  }
  return parts as [number, number, number]
}

export function getDesktopReleaseAssetName(
  version: string,
  platform: DesktopReleasePlatform,
  architecture: DesktopReleaseArchitecture
): string {
  if (compareDesktopVersions(version, '0.8.0') < 0) {
    throw new Error('Desktop update releases before v0.8.0 are not supported.')
  }
  const platformName = { darwin: 'mac', win32: 'windows', linux: 'linux' }[platform]
  if (!platformName || !['x64', 'arm64'].includes(architecture)) {
    throw new Error('This Desktop platform or architecture is not supported for updates.')
  }
  return `evenfire-desktop-v${version}-${platformName}-${architecture}.zip`
}

export function getNestedApplicationZipPath(
  version: string,
  platform: DesktopReleasePlatform,
  architecture: DesktopReleaseArchitecture
): string {
  const appPlatform = { darwin: 'darwin', win32: 'win32', linux: 'linux' }[platform]
  return `zip/${appPlatform}/${architecture}/Evenfire-${appPlatform}-${architecture}-${version}.zip`
}

function expectedReleaseDownloadUrl(version: string, assetName: string): string {
  return `${RELEASES_BASE}/download/v${version}/${assetName}`
}

function parseSha256Digest(value: unknown): string {
  if (typeof value !== 'string') throw new Error('GitHub release metadata has no SHA-256 digest.')
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value)
  if (!match) throw new Error('GitHub release metadata has an invalid SHA-256 digest.')
  return match[1]!.toLowerCase()
}

function abortAfter(parent: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`)
  }
  return response.json()
}

export async function resolveGitHubReleaseAsset(
  version: string,
  platform: DesktopReleasePlatform,
  architecture: DesktopReleaseArchitecture,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<GitHubReleaseAsset> {
  const assetName = getDesktopReleaseAssetName(version, platform, architecture)
  const fetchImpl = options.fetchImpl ?? fetch
  const tag = `v${version}`
  const response = await fetchImpl(`${GITHUB_API_BASE}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Evenfire-Desktop-Updater' },
    signal: abortAfter(options.signal, 20_000),
  })
  const release = (await readJsonResponse(response)) as GitHubReleaseRecord
  if (
    release.tag_name !== tag ||
    release.draft === true ||
    release.prerelease === true ||
    !Array.isArray(release.assets)
  ) {
    throw new Error(`GitHub does not have a published release for ${tag}.`)
  }

  const matchingAssets = (release.assets as GitHubAssetRecord[]).filter(
    asset => asset.name === assetName
  )
  if (matchingAssets.length !== 1) {
    throw new Error(
      `Expected exactly one ${assetName} asset in ${tag}; found ${matchingAssets.length}.`
    )
  }
  const record = matchingAssets[0]!
  const expectedUrl = expectedReleaseDownloadUrl(version, assetName)
  if (
    record.state !== 'uploaded' ||
    !Number.isSafeInteger(record.size) ||
    Number(record.size) < 1 ||
    Number(record.size) > MAX_RELEASE_BYTES ||
    record.browser_download_url !== expectedUrl
  ) {
    throw new Error(`The ${assetName} release metadata is incomplete or untrusted.`)
  }
  return {
    name: assetName,
    size: Number(record.size),
    digest: parseSha256Digest(record.digest),
    browserDownloadUrl: expectedUrl,
  }
}

async function fetchReleaseBytes(
  asset: GitHubReleaseAsset,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  let currentUrl = asset.browserDownloadUrl
  const assetVersion =
    /^evenfire-desktop-v(\d+\.\d+\.\d+)-(?:mac|windows|linux)-(?:x64|arm64)\.zip$/.exec(
      asset.name
    )?.[1]
  if (
    !assetVersion ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > MAX_RELEASE_BYTES ||
    !/^[a-f0-9]{64}$/.test(asset.digest) ||
    asset.browserDownloadUrl !== expectedReleaseDownloadUrl(assetVersion, asset.name)
  ) {
    throw new Error('The selected Desktop release asset metadata is invalid.')
  }
  const requestSignal = abortAfter(signal, 30 * 60_000)
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Evenfire-Desktop-Updater' },
      signal: requestSignal,
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location || redirectCount === 5) {
        throw new Error('The GitHub release download returned an invalid redirect.')
      }
      const redirectedUrl = new URL(location, currentUrl)
      if (
        redirectedUrl.protocol !== 'https:' ||
        !ALLOWED_DOWNLOAD_HOSTS.has(redirectedUrl.hostname) ||
        redirectedUrl.username !== '' ||
        redirectedUrl.password !== '' ||
        !['', '443'].includes(redirectedUrl.port)
      ) {
        throw new Error('The GitHub release download redirected to an untrusted host.')
      }
      currentUrl = redirectedUrl.toString()
      continue
    }
    if (!response.ok || !response.body) {
      throw new Error(`The GitHub release download failed with HTTP ${response.status}.`)
    }
    const contentLengthHeader = response.headers.get('content-length')
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader)
      if (!Number.isSafeInteger(contentLength) || contentLength !== asset.size) {
        await response.body.cancel()
        throw new Error('The GitHub release download size does not match its release metadata.')
      }
    }
    return response
  }
  throw new Error('The GitHub release download exceeded the redirect limit.')
}

export async function downloadVerifiedReleaseAsset(
  asset: GitHubReleaseAsset,
  destination: string,
  options: {
    signal?: AbortSignal
    onProgress?: ArchiveProgress
    fetchImpl?: typeof fetch
  } = {}
): Promise<void> {
  const response = await fetchReleaseBytes(asset, options.signal, options.fetchImpl)
  const totalHeader = response.headers.get('content-length')
  if (totalHeader && Number(totalHeader) !== asset.size) {
    await response.body?.cancel()
    throw new Error('The GitHub release download size does not match its release metadata.')
  }

  const hash = createHash('sha256')
  let transferred = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.byteLength
      if (transferred > asset.size || transferred > MAX_RELEASE_BYTES) {
        callback(new Error('The GitHub release download exceeded its declared size.'))
        return
      }
      hash.update(chunk)
      options.onProgress?.({
        percent: Math.min(100, (transferred / asset.size) * 100),
        transferred,
        total: asset.size,
      })
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal: options.signal }
    )
  } catch (error) {
    await removeOwnedFile(destination)
    if (options.signal?.aborted) throw new Error('Desktop update download was canceled.')
    throw error
  }

  if (transferred !== asset.size) {
    await removeOwnedFile(destination)
    throw new Error('The GitHub release download ended before its declared size.')
  }
  const actualDigest = hash.digest('hex')
  if (actualDigest !== asset.digest) {
    await removeOwnedFile(destination)
    throw new Error('The downloaded Desktop release failed its SHA-256 verification.')
  }
}

async function removeOwnedFile(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath)
    if (info.isFile() && !info.isSymbolicLink()) {
      await unlink(filePath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { autoClose: false, decodeStrings: true, lazyEntries: true, validateEntrySizes: true },
      (error, zipFile) => (error || !zipFile ? reject(error) : resolve(zipFile))
    )
  })
}

function readZipEntries(zipFile: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = []
    zipFile.once('error', reject)
    zipFile.once('end', () => resolve(entries))
    zipFile.on('entry', (entry: Entry) => {
      if (entries.length >= MAX_ZIP_ENTRIES) {
        zipFile.close()
        reject(new Error('The Desktop release archive contains too many entries.'))
        return
      }
      entries.push(entry)
      zipFile.readEntry()
    })
    zipFile.readEntry()
  })
}

function normalizeArchiveName(name: string): string {
  if (
    !name ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[a-z]:/i.test(name) ||
    name.length > 2048
  ) {
    throw new Error('The Desktop release archive contains an unsafe path.')
  }
  const normalizedSeparators = name.replace(/\\/g, '/')
  const directorySuffix = normalizedSeparators.endsWith('/')
  const segments = normalizedSeparators.split('/')
  if (directorySuffix) segments.pop()
  if (
    segments.length === 0 ||
    segments.some(
      segment =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.length > 255 ||
        /[<>:"|?*]/.test(segment) ||
        /[. ]$/.test(segment) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment)
    )
  ) {
    throw new Error('The Desktop release archive contains an unsafe path.')
  }
  return segments.join('/') + (directorySuffix ? '/' : '')
}

function entryKind(entry: Entry, name: string, allowSymlinks: boolean): SafeEntry {
  const unixCreator = entry.versionMadeBy >>> 8 === 3
  const mode = unixCreator ? (entry.externalFileAttributes >>> 16) & 0xffff : 0
  const type = mode & 0o170000
  const isDirectory = type === 0o040000 || (!type && name.endsWith('/'))
  const isSymlink = type === 0o120000
  const isRegular = type === 0o100000 || (!type && !name.endsWith('/'))
  if ((!isDirectory && !isSymlink && !isRegular) || (isSymlink && !allowSymlinks)) {
    throw new Error('The Desktop release archive contains an unsupported entry type.')
  }
  if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) {
    throw new Error('The Desktop release archive uses an unsupported compression method.')
  }
  if (
    entry.uncompressedSize > MAX_ENTRY_BYTES ||
    (entry.compressedSize === 0 && entry.uncompressedSize > 0) ||
    (entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)
  ) {
    throw new Error('The Desktop release archive exceeds its safe expansion limits.')
  }
  return { entry, name, isDirectory, isSymlink, mode: mode & 0o777 }
}

function validateArchiveEntries(entries: Entry[], allowSymlinks: boolean): SafeEntry[] {
  let totalBytes = 0
  const safeEntries = entries.map(entry => {
    const name = normalizeArchiveName(entry.fileName)
    totalBytes += entry.uncompressedSize
    if (totalBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error('The Desktop release archive exceeds its safe expansion limits.')
    }
    return entryKind(entry, name, allowSymlinks)
  })

  const collisionKey = (name: string) =>
    name.replace(/\/$/, '').normalize('NFC').toLocaleLowerCase('en-US')
  const byName = new Map<string, SafeEntry>()
  for (const safeEntry of safeEntries) {
    const key = collisionKey(safeEntry.name)
    if (byName.has(key)) {
      throw new Error('The Desktop release archive contains duplicate or colliding paths.')
    }
    byName.set(key, safeEntry)
  }
  for (const safeEntry of safeEntries) {
    const segments = safeEntry.name.replace(/\/$/, '').split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const parent = byName.get(collisionKey(segments.slice(0, index).join('/')))
      if (parent && !parent.isDirectory) {
        throw new Error('The Desktop release archive has a file or link used as a directory.')
      }
    }
  }
  return safeEntries
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) =>
      error || !stream ? reject(error) : resolve(stream)
    )
  })
}

async function writeEntryToFile(zipFile: ZipFile, safeEntry: SafeEntry, destination: string) {
  const stream = await openEntryStream(zipFile, safeEntry.entry)
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > safeEntry.entry.uncompressedSize || bytes > MAX_ENTRY_BYTES) {
        callback(new Error('An archive entry exceeded its declared size.'))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(
    stream,
    meter,
    createWriteStream(destination, {
      flags: 'wx',
      mode: safeEntry.mode || 0o600,
    })
  )
  if (bytes !== safeEntry.entry.uncompressedSize) {
    throw new Error('An archive entry ended before its declared size.')
  }
}

async function readEntryBytes(zipFile: ZipFile, entry: Entry, byteLimit: number): Promise<Buffer> {
  if (entry.uncompressedSize > byteLimit) {
    throw new Error('A Desktop archive link entry exceeds its safe size limit.')
  }
  const stream = await openEntryStream(zipFile, entry)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > byteLimit)
      throw new Error('A Desktop archive link entry exceeds its safe size limit.')
    chunks.push(bytes)
  }
  if (size !== entry.uncompressedSize) throw new Error('A Desktop archive link entry is truncated.')
  return Buffer.concat(chunks)
}

function resolveInside(root: string, relativePath: string): string {
  const result = path.resolve(root, ...relativePath.split('/'))
  const prefix = path.resolve(root) + path.sep
  if (result !== path.resolve(root) && !result.startsWith(prefix)) {
    throw new Error('The Desktop release archive path escaped its staging directory.')
  }
  return result
}

async function ensureDirectoryChain(root: string, relativeDirectory: string): Promise<void> {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('The Desktop update staging directory is not a safe directory.')
  }
  let current = root
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('The Desktop release archive contains a path through a link.')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
    }
  }
}

async function validateSymlinkTarget(linkName: string, target: string): Promise<void> {
  if (
    !target ||
    target.includes('\0') ||
    target.startsWith('/') ||
    target.startsWith('\\') ||
    /^[a-z]:/i.test(target) ||
    target.split(/[\\/]/).some(segment => segment === '..' || segment === '.')
  ) {
    throw new Error('The Desktop release archive contains an unsafe symbolic link.')
  }
  const parent = path.posix.dirname(linkName)
  const resolved = path.posix.normalize(path.posix.join(parent, target))
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new Error('The Desktop release archive contains an escaping symbolic link.')
  }
}

export async function extractValidatedZip(
  zipPath: string,
  destination: string,
  options: { allowSymlinks?: boolean } = {}
): Promise<SafeEntry[]> {
  await mkdir(destination, { recursive: false, mode: 0o700 })
  const realDestination = await realpath(destination)
  const zipFile = await openZip(zipPath)
  try {
    const safeEntries = validateArchiveEntries(
      await readZipEntries(zipFile),
      options.allowSymlinks === true
    )
    for (const safeEntry of safeEntries) {
      if (safeEntry.isDirectory) {
        await ensureDirectoryChain(realDestination, safeEntry.name.replace(/\/$/, ''))
      }
    }
    for (const safeEntry of safeEntries) {
      if (safeEntry.isDirectory || safeEntry.isSymlink) continue
      const target = resolveInside(realDestination, safeEntry.name)
      await ensureDirectoryChain(realDestination, path.posix.dirname(safeEntry.name))
      await writeEntryToFile(zipFile, safeEntry, target)
    }
    for (const safeEntry of safeEntries) {
      if (!safeEntry.isSymlink) continue
      const linkTarget = (
        await readEntryBytes(zipFile, safeEntry.entry, MAX_SYMLINK_BYTES)
      ).toString('utf8')
      await validateSymlinkTarget(safeEntry.name, linkTarget)
      const target = resolveInside(realDestination, safeEntry.name)
      await ensureDirectoryChain(realDestination, path.posix.dirname(safeEntry.name))
      await symlink(linkTarget, target)
    }
    return safeEntries
  } catch (error) {
    zipFile.close()
    throw error
  } finally {
    if (zipFile.isOpen) zipFile.close()
  }
}

export async function extractOuterZipEntry(
  archivePath: string,
  entryName: string,
  destination: string
): Promise<void> {
  const zipFile = await openZip(archivePath)
  try {
    // The outer Forge bundle never needs symlinks: only the nested macOS app ZIP does.
    const entries = validateArchiveEntries(await readZipEntries(zipFile), false)
    const matches = entries.filter(entry => entry.name === entryName)
    const match = matches[0]
    if (matches.length !== 1 || !match || match.isDirectory || match.isSymlink) {
      throw new Error(`The selected Desktop release does not contain exactly one ${entryName}.`)
    }
    if (match.entry.uncompressedSize > MAX_RELEASE_BYTES) {
      throw new Error('The selected Desktop release payload exceeds its safe size limit.')
    }
    await pipeline(
      await openEntryStream(zipFile, match.entry),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    )
  } finally {
    if (zipFile.isOpen) zipFile.close()
  }
}

export function readPackagedAppManifest(asarPath: string): {
  version: string
  name: string
  productName: string
} {
  let packageJson: Record<string, unknown>
  try {
    packageJson = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    throw new Error('The Desktop release has no readable packaged application manifest.')
  }
  const { version, name, productName } = packageJson
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    name !== 'evenfire' ||
    productName !== 'Evenfire'
  ) {
    throw new Error('The Desktop release has an unexpected application identity or version.')
  }
  return { version, name, productName }
}

export function getUpdaterCapability(asarPath: string): boolean {
  try {
    extractFile(asarPath, 'dist/desktopUpdateManager.js')
    return true
  } catch {
    return false
  }
}

export function getAppArchivePath(appPath: string, platform: DesktopReleasePlatform): string {
  const relativePath =
    platform === 'darwin' ? 'Contents/Resources/app.asar' : path.join('resources', 'app.asar')
  return path.join(appPath, relativePath)
}

export async function verifyAppTree(
  appPath: string,
  expectedVersion: string,
  platform: DesktopReleasePlatform,
  architecture: DesktopReleaseArchitecture
): Promise<{ appVersion: string; appId: string; updaterCapable: boolean }> {
  const asarPath = getAppArchivePath(appPath, platform)
  const manifest = readPackagedAppManifest(asarPath)
  if (manifest.version !== expectedVersion) {
    throw new Error(`The Desktop app is ${manifest.version}; expected ${expectedVersion}.`)
  }

  const executable =
    platform === 'darwin'
      ? path.join(appPath, 'Contents', 'MacOS', 'Evenfire')
      : path.join(appPath, platform === 'win32' ? 'Evenfire.exe' : 'Evenfire')
  const executableFile = await openRegularFileNoFollow(executable)
  let header: Buffer
  try {
    header = Buffer.alloc(4096)
    const { bytesRead } = await executableFile.handle.read(header, 0, header.length, 0)
    header = header.subarray(0, bytesRead)
  } finally {
    await executableFile.handle.close()
  }
  assertExecutableArchitecture(header, platform, architecture)
  if (platform !== 'win32' && (executableFile.mode & 0o111) === 0) {
    throw new Error('The Desktop application is missing executable permissions.')
  }

  let appId = 'ai.evenfire.desktop'
  if (platform === 'darwin') {
    appId = readMacBundleValue(appPath, 'CFBundleIdentifier')
    const bundleVersion = readMacBundleValue(appPath, 'CFBundleShortVersionString')
    if (appId !== 'ai.evenfire.desktop' || bundleVersion !== expectedVersion) {
      throw new Error('The macOS app bundle has an unexpected identity or version.')
    }
  } else if (platform === 'win32') {
    verifyWindowsAuthenticodeIfSigned(executable)
  }

  return {
    appVersion: manifest.version,
    appId,
    updaterCapable: getUpdaterCapability(asarPath),
  }
}

function assertExecutableArchitecture(
  header: Buffer,
  platform: DesktopReleasePlatform,
  architecture: DesktopReleaseArchitecture
): void {
  if (platform === 'darwin') {
    const magic = header.readUInt32BE(0)
    const expectedCpuType = architecture === 'x64' ? 0x01000007 : 0x0100000c
    if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
      const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca
      const count = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4)
      const entryBytes = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20
      if (count > 32 || header.length < 8 + count * entryBytes) {
        throw new Error('The macOS executable has an invalid universal header.')
      }
      const hasArchitecture = Array.from({ length: count }).some(
        (_, index) =>
          (littleEndian
            ? header.readUInt32LE(8 + index * entryBytes)
            : header.readUInt32BE(8 + index * entryBytes)) === expectedCpuType
      )
      if (!hasArchitecture) throw new Error('The macOS app has the wrong architecture.')
      return
    }
    const littleEndian = [0xcefaedfe, 0xcffaedfe].includes(magic)
    if (!littleEndian && magic !== 0xfeedface && magic !== 0xfeedfacf) {
      throw new Error('The macOS application is not a Mach-O executable.')
    }
    const cpuType = littleEndian ? header.readInt32LE(4) : header.readInt32BE(4)
    if (cpuType !== expectedCpuType) throw new Error('The macOS app has the wrong architecture.')
    return
  }
  if (platform === 'win32') {
    if (header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('The Windows application is not a PE executable.')
    }
    const peOffset = header.readUInt32LE(0x3c)
    if (
      peOffset + 6 > header.length ||
      header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
    ) {
      throw new Error('The Windows application has an invalid PE header.')
    }
    const machine = header.readUInt16LE(peOffset + 4)
    const expectedMachine = architecture === 'x64' ? 0x8664 : 0xaa64
    if (machine !== expectedMachine) throw new Error('The Windows app has the wrong architecture.')
    return
  }
  if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error('The Linux application is not an ELF executable.')
  }
  if (header[4] !== 2 || ![1, 2].includes(header[5]!)) {
    throw new Error('The Linux application has an unsupported ELF class or byte order.')
  }
  const littleEndian = header[5] === 1
  const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18)
  const expectedMachine = architecture === 'x64' ? 62 : 183
  if (machine !== expectedMachine) throw new Error('The Linux app has the wrong architecture.')
}

function runNativeTool(
  command: string,
  args: string[],
  failureMessage = 'The operating system could not verify the Desktop artifact.'
): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.error || result.status !== 0) {
    throw new Error(failureMessage)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function readMacBundleValue(appPath: string, key: string): string {
  return runNativeTool(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
    'The macOS application metadata could not be read.'
  ).trim()
}

function verifyMacReleaseSignature(appPath: string): void {
  runNativeTool(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    'The downloaded macOS target failed signature verification.'
  )
  const details = runNativeTool(
    '/usr/bin/codesign',
    ['-dv', '--verbose=4', appPath],
    'The downloaded macOS target signature could not be inspected.'
  )
  if (!/TeamIdentifier=XV6G8QZD5D(?:\r?\n|$)/.test(details)) {
    throw new Error('The downloaded macOS target is signed by an unexpected developer team.')
  }
  runNativeTool(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'execute', '--verbose=2', appPath],
    'The downloaded macOS target failed macOS trust assessment.'
  )
}

function verifyWindowsAuthenticodeIfSigned(executable: string): void {
  const script =
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0]; if ($s.Status -eq 'Valid') { exit 0 }; " +
    "if ($s.Status -eq 'NotSigned') { exit 0 }; exit 1"
  runNativeTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, executable])
}

export async function prepareVerifiedDesktopPayload(args: {
  archivePath: string
  destination: string
  version: string
  platform: DesktopReleasePlatform
  architecture: DesktopReleaseArchitecture
  packageType: DesktopReleasePackageType
}): Promise<VerifiedDesktopPayload> {
  const { archivePath, destination, version, platform, architecture, packageType } = args
  const assetName = getDesktopReleaseAssetName(version, platform, architecture)
  let packagePath: string
  let appPath: string

  if (packageType === 'squirrel') {
    if (platform !== 'win32') throw new Error('Squirrel installation is supported only on Windows.')
    const setupPath = path.join(destination, 'EvenfireSetup.exe')
    const nupkgPath = path.join(destination, `Evenfire-${version}-full.nupkg`)
    const releasesPath = path.join(destination, 'RELEASES')
    await extractOuterZipEntry(
      archivePath,
      `squirrel.windows/${architecture}/EvenfireSetup.exe`,
      setupPath
    )
    await extractOuterZipEntry(
      archivePath,
      `squirrel.windows/${architecture}/Evenfire-${version}-full.nupkg`,
      nupkgPath
    )
    await extractOuterZipEntry(
      archivePath,
      `squirrel.windows/${architecture}/RELEASES`,
      releasesPath
    )
    await verifySquirrelPackage(nupkgPath, releasesPath, version)
    const packageRoot = path.join(destination, 'squirrel-package')
    await extractValidatedZip(nupkgPath, packageRoot)
    appPath = path.join(packageRoot, 'lib', 'net45')
    packagePath = setupPath
  } else if (packageType === 'deb' || packageType === 'rpm') {
    if (platform !== 'linux') throw new Error('Linux packages are supported only on Linux.')
    const packageRelative = getLinuxPackagePath(version, architecture, packageType)
    packagePath = path.join(destination, path.basename(packageRelative))
    await extractOuterZipEntry(archivePath, packageRelative, packagePath)
    verifyLinuxPackage(packagePath, version, architecture, packageType)
    const appZipPath = path.join(destination, 'application.zip')
    await extractOuterZipEntry(
      archivePath,
      getNestedApplicationZipPath(version, platform, architecture),
      appZipPath
    )
    const appRoot = path.join(destination, 'application')
    await extractValidatedZip(appZipPath, appRoot)
    appPath = path.join(appRoot, `Evenfire-linux-${architecture}`)
  } else {
    const appZipPath = path.join(destination, 'application.zip')
    await extractOuterZipEntry(
      archivePath,
      getNestedApplicationZipPath(version, platform, architecture),
      appZipPath
    )
    const appRoot = path.join(destination, 'application')
    await extractValidatedZip(appZipPath, appRoot, { allowSymlinks: platform === 'darwin' })
    appPath =
      platform === 'darwin'
        ? path.join(appRoot, 'Evenfire.app')
        : platform === 'linux'
          ? path.join(appRoot, `Evenfire-linux-${architecture}`)
          : appRoot
    packagePath = appZipPath
  }

  const verified = await verifyAppTree(appPath, version, platform, architecture)
  if (platform === 'darwin') verifyMacReleaseSignature(appPath)
  if (packageType === 'squirrel') verifyWindowsAuthenticodeIfSigned(packagePath)
  return {
    packageType,
    packagePath,
    appPath,
    appVersion: verified.appVersion,
    appId: verified.appId,
    architecture,
    updaterCapable: verified.updaterCapable,
    assetName,
    assetSha256: await readFileSha256(archivePath),
    assetSize: (await lstat(archivePath)).size,
  }
}

export async function verifySquirrelPackage(
  nupkgPath: string,
  releasesPath: string,
  expectedVersion: string
): Promise<void> {
  const zipFile = await openZip(nupkgPath)
  try {
    const entries = validateArchiveEntries(await readZipEntries(zipFile), false)
    const manifests = entries.filter(entry => entry.name.toLowerCase() === 'evenfire.nuspec')
    const manifest = manifests[0]
    if (manifests.length !== 1 || !manifest || manifest.entry.uncompressedSize > 32 * 1024) {
      throw new Error('The Windows Squirrel package has an invalid NuGet manifest.')
    }
    const manifestText = (await readEntryBytes(zipFile, manifest.entry, 32 * 1024)).toString('utf8')
    const id = /<id>\s*([^<]+)\s*<\/id>/i.exec(manifestText)?.[1]?.trim()
    const version = /<version>\s*([^<]+)\s*<\/version>/i.exec(manifestText)?.[1]?.trim()
    if (id !== 'Evenfire' || version !== expectedVersion) {
      throw new Error('The Windows Squirrel package has an unexpected app identity or version.')
    }
  } finally {
    if (zipFile.isOpen) zipFile.close()
  }

  const [releaseText, fileInfo] = await Promise.all([
    readFile(releasesPath, 'utf8'),
    lstat(nupkgPath),
  ])
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(nupkgPath)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
  const expectedLine = new RegExp(
    `^${digest}\\s+Evenfire-${expectedVersion}-full\\.nupkg\\s+${fileInfo.size}$`
  )
  const releaseLines = releaseText.replace(/^\uFEFF/, '').split(/\r?\n/)
  const packageLines = releaseLines.filter(line =>
    line.includes(`Evenfire-${expectedVersion}-full.nupkg`)
  )
  if (packageLines.length !== 1 || !expectedLine.test(packageLines[0] ?? '')) {
    throw new Error('The Windows Squirrel RELEASES record does not match its full package.')
  }
}

function getLinuxPackagePath(
  version: string,
  architecture: DesktopReleaseArchitecture,
  packageType: 'deb' | 'rpm'
): string {
  if (packageType === 'deb') {
    const debArchitecture = architecture === 'x64' ? 'amd64' : 'arm64'
    return `deb/${architecture}/evenfire_${version}_${debArchitecture}.deb`
  }
  const rpmArchitecture = architecture === 'x64' ? 'x86_64' : 'aarch64'
  return `rpm/${architecture}/evenfire-${version}-1.${rpmArchitecture}.rpm`
}

function verifyLinuxPackage(
  packagePath: string,
  version: string,
  architecture: DesktopReleaseArchitecture,
  packageType: 'deb' | 'rpm'
): void {
  if (packageType === 'deb') {
    const expectedArchitecture = architecture === 'x64' ? 'amd64' : 'arm64'
    const name = runNativeTool('dpkg-deb', ['--field', packagePath, 'Package']).trim()
    const actualVersion = runNativeTool('dpkg-deb', ['--field', packagePath, 'Version']).trim()
    const actualArchitecture = runNativeTool('dpkg-deb', [
      '--field',
      packagePath,
      'Architecture',
    ]).trim()
    if (
      name !== 'evenfire' ||
      actualVersion !== version ||
      actualArchitecture !== expectedArchitecture
    ) {
      throw new Error(
        'The downloaded DEB package has an unexpected identity, version, or architecture.'
      )
    }
    return
  }
  const expectedArchitecture = architecture === 'x64' ? 'x86_64' : 'aarch64'
  const metadata = runNativeTool('rpm', [
    '-qp',
    '--queryformat',
    '%{NAME}\n%{VERSION}\n%{ARCH}\n',
    packagePath,
  ])
    .trim()
    .split(/\r?\n/)
  if (
    metadata[0] !== 'evenfire' ||
    metadata[1] !== version ||
    metadata[2] !== expectedArchitecture
  ) {
    throw new Error(
      'The downloaded RPM package has an unexpected identity, version, or architecture.'
    )
  }
}

export async function readFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function verifyRecordedOperationDirectory(
  stageRoot: string,
  operationPath: string,
  operationId: string
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(operationId)) return false
  const expectedPath = path.join(stageRoot, operationId)
  if (path.resolve(operationPath) !== path.resolve(expectedPath)) return false
  try {
    const [rootInfo, operationInfo] = await Promise.all([lstat(stageRoot), lstat(operationPath)])
    return (
      rootInfo.isDirectory() &&
      !rootInfo.isSymbolicLink() &&
      operationInfo.isDirectory() &&
      !operationInfo.isSymbolicLink()
    )
  } catch {
    return false
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8')
}
