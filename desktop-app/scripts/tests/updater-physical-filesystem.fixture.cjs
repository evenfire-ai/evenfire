const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { registerHooks } = require('node:module')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')

const [mode, desktopRoot, sourceApp, archive, scratch, policyFile] = process.argv.slice(2)
const native = Boolean(process.versions.electron)
const fs = native ? require('original-fs') : require('node:fs')
const app = native ? require('electron').app : null

if (app) {
  app.setPath('userData', scratch)
  app.setPath('sessionData', scratch)
  app.setName('EvenfireUpdaterFilesystemTest')
  app.setActivationPolicy('prohibited')
}

async function rawDigest(file) {
  const hash = createHash('sha256')
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

async function run() {
  const artifacts = await import(
    pathToFileURL(path.join(desktopRoot, 'dist/desktopUpdateArtifacts.js'))
  )
  const asar = path.join(sourceApp, 'Contents/Resources/app.asar')
  const source = artifacts.readPackagedAppManifest(asar)
  const sourceDigest = await rawDigest(asar)
  if (mode === 'hash') {
    assert.equal(await artifacts.readFileSha256(asar), sourceDigest)
  } else if (mode === 'extract') {
    assert.equal(
      await rawDigest(archive),
      '858666e54d93b8e73672ec78145af53f7b0aa523cb8706866d574e6d19b54018'
    )
    const destination = path.join(scratch, 'payload')
    await fs.promises.mkdir(destination)
    const payload = await artifacts.prepareVerifiedDesktopPayload({
      archivePath: archive,
      destination,
      version: '0.12.0',
      platform: 'darwin',
      architecture: 'arm64',
      packageType: 'app-zip',
    })
    assert.equal(payload.appVersion, '0.12.0')
    assert.equal(payload.appId, 'ai.evenfire.desktop')
    assert.equal(payload.architecture, 'arm64')
    assert.equal(payload.updaterCapable, false)
    assert.ok(
      (await fs.promises.stat(path.join(payload.appPath, 'Contents/Resources/app.asar'))).isFile()
    )
  } else if (mode === 'safety') {
    const { release } = JSON.parse(await fs.promises.readFile(policyFile, 'utf8'))
    const asset = await artifacts.resolveGitHubReleaseAsset('0.12.0', 'darwin', 'arm64', {
      fetchImpl: async () => Response.json(release),
    })
    const fetchImpl = async () =>
      new Response(Readable.toWeb(fs.createReadStream(archive)), {
        headers: { 'content-length': String(asset.size) },
      })
    const rejected = path.join(scratch, 'rejected.zip')
    await assert.rejects(
      artifacts.downloadVerifiedReleaseAsset({ ...asset, digest: '0'.repeat(64) }, rejected, {
        fetchImpl,
      }),
      /SHA-256 verification/
    )
    await assert.rejects(fs.promises.stat(rejected), { code: 'ENOENT' })
    const canceled = path.join(scratch, 'canceled.zip')
    const controller = new AbortController()
    await assert.rejects(
      artifacts.downloadVerifiedReleaseAsset(asset, canceled, {
        fetchImpl,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      /canceled/
    )
    await assert.rejects(fs.promises.stat(canceled), { code: 'ENOENT' })
    const link = path.join(scratch, 'link.asar')
    await fs.promises.symlink(asar, link)
    await assert.rejects(artifacts.readFileSha256(link))
  } else if (mode === 'stage' || mode === 'stage-live') {
    assert.ok(app, 'staging must run in real Electron')
    // Only the packaged-host boundary is substituted; all updater I/O and trust checks are real.
    Object.defineProperty(app, 'isPackaged', { value: true })
    app.getVersion = () => source.version
    app.whenReady = () => new Promise(() => {})
    app.quit = () => assert.fail('staging must never quit or install')
    const stub = path.join(scratch, 'config.mjs')
    await fs.promises.writeFile(stub, 'export const getActiveRuntimeConfigOptionId = () => null;\n')
    registerHooks({
      resolve(specifier, context, next) {
        if (
          specifier === './config.js' &&
          context.parentURL?.endsWith('/desktopUpdateManager.js')
        ) {
          return { url: pathToFileURL(stub).href, shortCircuit: true }
        }
        return next(specifier, context)
      },
    })
    const { DesktopUpdateManager } = await import(
      pathToFileURL(path.join(desktopRoot, 'dist/desktopUpdateManager.js'))
    )
    const { policy, release } = JSON.parse(await fs.promises.readFile(policyFile, 'utf8'))
    const asset = release.assets.find(a => a.name === 'evenfire-desktop-v0.12.0-mac-arm64.zip')
    let binding = 'native-fixture-backend'
    let downloadEvents = 0
    const manager = new DesktopUpdateManager(
      {
        getDesktopReleaseStatus: async () => ({
          checked: true,
          currentVersion: source.version,
          latestVersion: policy.desktopVersion,
          compatibleVersions: policy.compatibleDesktopVersions,
          updateAvailable: source.version !== policy.desktopVersion,
          releaseTag: policy.releaseTag,
        }),
      },
      event => {
        if (event.type === 'downloaded') downloadEvents++
      },
      {
        platform: 'darwin',
        architecture: 'arm64',
        executablePath: path.join(sourceApp, 'Contents/MacOS/Evenfire'),
        getEnvironmentBindingId: () => binding,
        fetchImpl:
          mode === 'stage-live'
            ? undefined
            : async (url, options) => {
                options?.signal?.throwIfAborted()
                if (
                  url === 'https://api.github.com/repos/evenfire-ai/evenfire/releases/tags/v0.12.0'
                ) {
                  return Response.json(release)
                }
                assert.equal(url, asset.browser_download_url)
                return new Response(Readable.toWeb(fs.createReadStream(archive)), {
                  headers: { 'content-length': String(asset.size) },
                })
              },
        launchInstallHelper: async () => assert.fail('staging must never launch an installer'),
      }
    )
    assert.deepEqual(await manager.downloadDesktopUpdate('0.12.0', false), {
      downloaded: true,
      version: '0.12.0',
      updaterCapable: false,
    })
    assert.equal(downloadEvents, 1)
    assert.deepEqual(await manager.getPendingDesktopUpdate(), {
      version: '0.12.0',
      updaterCapable: false,
    })
    const staging = path.join(scratch, 'desktop-update-staging')
    assert.ok((await fs.promises.readdir(staging)).includes('pending.json'))
    binding = 'changed-backend'
    assert.equal(await manager.getPendingDesktopUpdate(), null)
    assert.deepEqual(await fs.promises.readdir(staging), [])
  } else {
    assert.fail('unknown native test mode')
  }
  assert.equal(await rawDigest(asar), sourceDigest, 'installed source must remain unchanged')
}

run().then(
  () => {
    console.log(`PASS ${native ? 'Electron' : 'Node'} ${mode}`)
    if (app) app.exit(0)
  },
  error => {
    console.error(error)
    if (app) app.exit(1)
    else process.exitCode = 1
  }
)
