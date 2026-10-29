import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  type GitHubReleaseAsset,
  downloadVerifiedReleaseAsset,
  extractOuterZipEntry,
  extractValidatedZip,
  getDesktopReleaseAssetName,
  getNestedApplicationZipPath,
  prepareVerifiedDesktopPayload,
  readFileSha256,
  readPackagedAppManifest,
  resolveGitHubReleaseAsset,
  verifyAppTree,
  verifySquirrelPackage,
} from '../desktopUpdateArtifacts.js'
import release from './fixtures/github-release-v0.12.0.json' with { type: 'json' }

const releaseApiUrl = 'https://api.github.com/repos/evenfire-ai/evenfire/releases/tags/v0.12.0'

let temporaryRoot = ''

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = ''
})

function crc32(data: Buffer): number {
  let value = 0xffffffff
  for (const byte of data) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function makeZip(
  entries: Array<{ name: string; contents?: string; deflate?: boolean; mode?: number }>
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const uncompressedContents = Buffer.from(entry.contents ?? '')
    const contents = entry.deflate ? deflateRawSync(uncompressedContents) : uncompressedContents
    const compressionMethod = entry.deflate ? 8 : 0
    const crc = crc32(uncompressedContents)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(compressionMethod, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(contents.length, 18)
    local.writeUInt32LE(uncompressedContents.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, contents)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(compressionMethod, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(contents.length, 20)
    central.writeUInt32LE(uncompressedContents.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((((entry.mode ?? 0o100600) & 0xffff) << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + contents.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function fixtureResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('desktop release artifact selection', () => {
  it.each([
    ['darwin', 'x64', 'mac-x64'],
    ['darwin', 'arm64', 'mac-arm64'],
    ['win32', 'x64', 'windows-x64'],
    ['win32', 'arm64', 'windows-arm64'],
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
  ] as const)(
    'selects the exact v0.12.0 %s/%s release asset',
    async (platform, architecture, suffix) => {
      const selectedName = `evenfire-desktop-v0.12.0-${suffix}.zip`
      const fetchImpl = vi.fn().mockResolvedValue(fixtureResponse(release))

      await expect(
        resolveGitHubReleaseAsset('0.12.0', platform, architecture, { fetchImpl })
      ).resolves.toMatchObject({
        name: selectedName,
        browserDownloadUrl: `https://github.com/evenfire-ai/evenfire/releases/download/v0.12.0/${selectedName}`,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(fetchImpl).toHaveBeenCalledWith(
        releaseApiUrl,
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
        })
      )
    }
  )

  it('rejects missing, duplicate, unuploaded, or digest-less matching assets', async () => {
    const selectedName = getDesktopReleaseAssetName('0.12.0', 'darwin', 'arm64')
    const selected = release.assets.find(asset => asset.name === selectedName)!
    const cases = [
      { ...release, assets: release.assets.filter(asset => asset.name !== selectedName) },
      { ...release, assets: [...release.assets, selected] },
      {
        ...release,
        assets: release.assets.map(asset =>
          asset.name === selectedName ? { ...asset, state: 'new' } : asset
        ),
      },
      {
        ...release,
        assets: release.assets.map(asset =>
          asset.name === selectedName ? { ...asset, digest: null } : asset
        ),
      },
    ]
    for (const body of cases) {
      const fetchImpl = vi.fn().mockResolvedValue(fixtureResponse(body))
      await expect(
        resolveGitHubReleaseAsset('0.12.0', 'darwin', 'arm64', { fetchImpl })
      ).rejects.toThrow()
    }
  })

  it('rejects unsupported historical versions and architecture mappings', () => {
    expect(() => getDesktopReleaseAssetName('0.7.9', 'darwin', 'arm64')).toThrow('before v0.8.0')
    expect(() => getDesktopReleaseAssetName('0.12.0', 'linux', 'ia32' as never)).toThrow(
      'not supported'
    )
  })

  it.each([
    ['darwin', 'x64', 'zip/darwin/x64/Evenfire-darwin-x64-0.12.0.zip'],
    ['darwin', 'arm64', 'zip/darwin/arm64/Evenfire-darwin-arm64-0.12.0.zip'],
    ['win32', 'x64', 'zip/win32/x64/Evenfire-win32-x64-0.12.0.zip'],
    ['win32', 'arm64', 'zip/win32/arm64/Evenfire-win32-arm64-0.12.0.zip'],
    ['linux', 'x64', 'zip/linux/x64/Evenfire-linux-x64-0.12.0.zip'],
    ['linux', 'arm64', 'zip/linux/arm64/Evenfire-linux-arm64-0.12.0.zip'],
  ] as const)('maps %s/%s to its existing Forge app ZIP', (platform, architecture, expected) => {
    expect(getNestedApplicationZipPath('0.12.0', platform, architecture)).toBe(expected)
  })
})

describe('verified artifact download and ZIP extraction', () => {
  it('downloads through an approved GitHub redirect, verifies SHA-256, and reports progress', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-artifact-test-'))
    const bytes = Buffer.from('release fixture bytes')
    const asset: GitHubReleaseAsset = {
      name: 'evenfire-desktop-v0.12.0-mac-arm64.zip',
      size: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
      browserDownloadUrl:
        'https://github.com/evenfire-ai/evenfire/releases/download/v0.12.0/evenfire-desktop-v0.12.0-mac-arm64.zip',
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/asset' },
        })
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        })
      )
    const progress = vi.fn()
    const destination = path.join(temporaryRoot, 'release.zip')

    await downloadVerifiedReleaseAsset(asset, destination, { fetchImpl, onProgress: progress })

    await expect(readFile(destination)).resolves.toEqual(bytes)
    expect(progress).toHaveBeenCalledWith({
      percent: 100,
      transferred: bytes.length,
      total: bytes.length,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('accepts a digest-valid response when the server omits Content-Length', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-artifact-test-'))
    const bytes = Buffer.from('chunked release fixture bytes')
    const asset: GitHubReleaseAsset = {
      name: 'evenfire-desktop-v0.12.0-mac-arm64.zip',
      size: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
      browserDownloadUrl:
        'https://github.com/evenfire-ai/evenfire/releases/download/v0.12.0/evenfire-desktop-v0.12.0-mac-arm64.zip',
    }
    const response = new Response(bytes)
    expect(response.headers.has('content-length')).toBe(false)
    const fetchImpl = vi.fn().mockResolvedValue(response)
    const destination = path.join(temporaryRoot, 'release.zip')

    await expect(
      downloadVerifiedReleaseAsset(asset, destination, { fetchImpl })
    ).resolves.toBeUndefined()
    await expect(readFile(destination)).resolves.toEqual(bytes)
  })

  it('rejects an untrusted redirect and deletes checksum-mismatched bytes', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-artifact-test-'))
    const bytes = Buffer.from('tampered release')
    const destination = path.join(temporaryRoot, 'release.zip')
    const asset: GitHubReleaseAsset = {
      name: 'evenfire-desktop-v0.12.0-linux-x64.zip',
      size: bytes.length,
      digest: '0'.repeat(64),
      browserDownloadUrl:
        'https://github.com/evenfire-ai/evenfire/releases/download/v0.12.0/evenfire-desktop-v0.12.0-linux-x64.zip',
    }
    const untrustedFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/payload' },
      })
    )
    await expect(
      downloadVerifiedReleaseAsset(asset, destination, { fetchImpl: untrustedFetch })
    ).rejects.toThrow('untrusted host')

    const bytesFetch = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length) },
      })
    )
    await expect(
      downloadVerifiedReleaseAsset(asset, destination, { fetchImpl: bytesFetch })
    ).rejects.toThrow('SHA-256')
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['../outside.txt', '/absolute.txt', 'C:/absolute.txt', 'safe/../outside.txt'])(
    'rejects traversal ZIP entry %s before writing files',
    async name => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-zip-test-'))
      const archive = path.join(temporaryRoot, 'malicious.zip')
      const destination = path.join(temporaryRoot, 'payload')
      await writeFile(archive, makeZip([{ name, contents: 'payload' }]))
      await expect(extractValidatedZip(archive, destination)).rejects.toThrow(
        /relative path|absolute path/
      )
    }
  )

  it('rejects duplicate paths and link entries before extraction', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-zip-test-'))
    const duplicateArchive = path.join(temporaryRoot, 'duplicate.zip')
    await writeFile(
      duplicateArchive,
      makeZip([
        { name: 'Evenfire.exe', contents: 'one' },
        { name: 'evenfire.exe', contents: 'two' },
      ])
    )
    await expect(
      extractValidatedZip(duplicateArchive, path.join(temporaryRoot, 'duplicate'))
    ).rejects.toThrow('duplicate or colliding')

    const unicodeCollisionArchive = path.join(temporaryRoot, 'unicode-collision.zip')
    await writeFile(
      unicodeCollisionArchive,
      makeZip([
        { name: 'caf\u00e9.txt', contents: 'one' },
        { name: 'cafe\u0301.txt', contents: 'two' },
      ])
    )
    await expect(
      extractValidatedZip(unicodeCollisionArchive, path.join(temporaryRoot, 'unicode-collision'))
    ).rejects.toThrow('duplicate or colliding')

    const linkArchive = path.join(temporaryRoot, 'link.zip')
    await writeFile(
      linkArchive,
      makeZip([{ name: 'payload-link', contents: '../outside', mode: 0o120777 }])
    )
    await expect(
      extractValidatedZip(linkArchive, path.join(temporaryRoot, 'link'))
    ).rejects.toThrow('unsupported entry type')

    await expect(
      extractValidatedZip(linkArchive, path.join(temporaryRoot, 'unsafe-link'), {
        allowSymlinks: true,
      })
    ).rejects.toThrow('unsafe symbolic link')
  })

  it('rejects an archive with an excessive compressed expansion ratio before extraction', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-zip-test-'))
    const archive = path.join(temporaryRoot, 'expansion.zip')
    await writeFile(
      archive,
      makeZip([{ name: 'payload.bin', contents: 'A'.repeat(1024 * 1024), deflate: true }])
    )

    await expect(
      extractValidatedZip(archive, path.join(temporaryRoot, 'expanded'))
    ).rejects.toThrow('safe expansion limits')
    await expect(readdir(path.join(temporaryRoot, 'expanded'))).resolves.toEqual([])
  })
})

describe('published macOS v0.12.0 artifact', () => {
  it.skipIf(!process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR)(
    'extracts and verifies the real signed arm64 app from the published Forge ZIP',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-real-mac-test-'))
      const archivePath = path.join(
        process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR!,
        'mac-v0.12.0.zip'
      )
      const destination = path.join(temporaryRoot, 'payload')
      await mkdir(temporaryRoot, { recursive: true })
      await mkdir(destination)
      const payload = await prepareVerifiedDesktopPayload({
        archivePath,
        destination,
        version: '0.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        packageType: 'app-zip',
      })
      expect(payload).toMatchObject({
        appVersion: '0.12.0',
        appId: 'ai.evenfire.desktop',
        architecture: 'arm64',
        updaterCapable: false,
      })
      expect(payload.assetSha256).toBe(
        '858666e54d93b8e73672ec78145af53f7b0aa523cb8706866d574e6d19b54018'
      )
    }
  )

  it.skipIf(!process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR)(
    'rejects the real app when its packaged version differs from the requested version',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-real-mac-version-'))
      const archivePath = path.join(
        process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR!,
        'mac-v0.12.0.zip'
      )
      const destination = path.join(temporaryRoot, 'payload')
      await mkdir(destination)
      const payload = await prepareVerifiedDesktopPayload({
        archivePath,
        destination,
        version: '0.12.0',
        platform: 'darwin',
        architecture: 'arm64',
        packageType: 'app-zip',
      })

      await expect(verifyAppTree(payload.appPath, '0.11.9', 'darwin', 'arm64')).rejects.toThrow(
        'The Desktop app is 0.12.0; expected 0.11.9.'
      )
    }
  )
})

describe('published Windows and Linux v0.12.0 Forge artifacts', () => {
  it.skipIf(!process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR)(
    'verifies the real Windows Squirrel records and x64 app ZIP layout',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-real-windows-test-'))
      const fixtureRoot = process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR!
      const archivePath = path.join(fixtureRoot, 'windows-v0.12.0.zip')
      const payloadRoot = path.join(temporaryRoot, 'payload')
      await mkdir(payloadRoot)
      const setupPath = path.join(payloadRoot, 'EvenfireSetup.exe')
      const nupkgPath = path.join(payloadRoot, 'Evenfire-0.12.0-full.nupkg')
      const releasesPath = path.join(payloadRoot, 'RELEASES')
      const appZipPath = path.join(payloadRoot, 'application.zip')

      await extractOuterZipEntry(archivePath, 'squirrel.windows/x64/EvenfireSetup.exe', setupPath)
      await extractOuterZipEntry(
        archivePath,
        'squirrel.windows/x64/Evenfire-0.12.0-full.nupkg',
        nupkgPath
      )
      await extractOuterZipEntry(archivePath, 'squirrel.windows/x64/RELEASES', releasesPath)
      await verifySquirrelPackage(nupkgPath, releasesPath, '0.12.0')
      await extractOuterZipEntry(
        archivePath,
        'zip/win32/x64/Evenfire-win32-x64-0.12.0.zip',
        appZipPath
      )
      const appRoot = path.join(payloadRoot, 'application')
      await extractValidatedZip(appZipPath, appRoot)
      expect(readPackagedAppManifest(path.join(appRoot, 'resources', 'app.asar'))).toEqual({
        version: '0.12.0',
        name: 'evenfire',
        productName: 'Evenfire',
      })
      const executable = await readFile(path.join(appRoot, 'Evenfire.exe'))
      const peOffset = executable.readUInt32LE(0x3c)
      expect(executable.toString('ascii', peOffset, peOffset + 4)).toBe('PE\0\0')
      expect(executable.readUInt16LE(peOffset + 4)).toBe(0x8664)
      expect(await readFileSha256(archivePath)).toBe(
        '74317450e6f452aa03470dd4e62eb0bcbbf74192283b29b963c1115e39b5425f'
      )
    }
  )

  it.skipIf(!process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR)(
    'extracts the real Linux x64 app ZIP and verifies its ELF, version, and executable mode',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-real-linux-test-'))
      const archivePath = path.join(
        process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR!,
        'linux-v0.12.0.zip'
      )
      const destination = path.join(temporaryRoot, 'payload')
      await mkdir(destination)
      const payload = await prepareVerifiedDesktopPayload({
        archivePath,
        destination,
        version: '0.12.0',
        platform: 'linux',
        architecture: 'x64',
        packageType: 'app-zip',
      })
      expect(payload).toMatchObject({
        appVersion: '0.12.0',
        appId: 'ai.evenfire.desktop',
        architecture: 'x64',
        updaterCapable: false,
      })
      expect(payload.assetSha256).toBe(
        '90351099009f23bc15ed1318f7344524241a2f3a4c0291d69b66b390bb48e869'
      )
    }
  )
})
