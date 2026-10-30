const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { registerHooks } = require('node:module')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')
const { app } = require('electron')
const fs = require('original-fs')

const [mode, desktopRoot, sourceApp, archive, scratch, policyFile] = process.argv.slice(2)
app.setPath('userData', scratch)
app.setPath('sessionData', scratch)
app.setName('EvenfireMacInstallTest')
app.setActivationPolicy('prohibited')

let operationPath

async function run() {
  const artifacts = await import(
    pathToFileURL(path.join(desktopRoot, 'dist/desktopUpdateArtifacts.js'))
  )
  const source = artifacts.readPackagedAppManifest(
    path.join(sourceApp, 'Contents/Resources/app.asar')
  )
  const install = path.join(scratch, 'Evenfire.app')
  cp.execFileSync('/usr/bin/ditto', [sourceApp, install])
  const realSpawn = cp.spawn
  cp.spawn = (command, args, options) => {
    // Substitute only external launch observation. All program replacements are static.
    const adapt = program =>
      program
        .replaceAll('/usr/bin/open', '"$stage/fake-open.sh"')
        .replaceAll('/usr/sbin/lsof', '"$stage/fake-lsof.sh"')
        .replaceAll('/usr/bin/osascript', '/usr/bin/true')
    const child = realSpawn(
      command,
      args.map(arg => (arg.includes('verify_target()') ? adapt(arg) : arg)),
      options
    )
    if (child.stdin) {
      const end = child.stdin.end.bind(child.stdin)
      child.stdin.end = (program, ...rest) => end(adapt(program), ...rest)
    }
    return child
  }
  const stub = path.join(scratch, 'config.mjs')
  await fs.promises.writeFile(stub, 'export const getActiveRuntimeConfigOptionId = () => null;\n')
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === './config.js' && context.parentURL?.endsWith('/desktopUpdateManager.js')) {
        return { url: pathToFileURL(stub).href, shortCircuit: true }
      }
      return next(specifier, context)
    },
  })
  const { DesktopUpdateManager } = await import(
    pathToFileURL(path.join(desktopRoot, 'dist/desktopUpdateManager.js'))
  )
  const { launchDesktopInstallHelper } = await import(
    pathToFileURL(path.join(desktopRoot, 'dist/desktopUpdateInstaller.js'))
  )
  Object.defineProperty(app, 'isPackaged', { value: true })
  app.getVersion = () => source.version
  app.whenReady = () => new Promise(() => {})
  const { release, policy } = JSON.parse(await fs.promises.readFile(policyFile, 'utf8'))
  const asset = release.assets.find(a => a.name === 'evenfire-desktop-v0.12.0-mac-arm64.zip')
  const quit = app.quit.bind(app)
  app.quit = () => {
    const pid = fs.readFileSync(path.join(operationPath, 'helper.pid'), 'utf8').trim()
    const parent = cp
      .execFileSync('/bin/ps', ['-p', pid, '-o', 'ppid='], { encoding: 'utf8' })
      .trim()
    assert.equal(parent, '1', 'helper must belong to launchd before the app exits')
    const operation = JSON.parse(fs.readFileSync(path.join(scratch, 'test-operation.json'), 'utf8'))
    assert.equal(
      cp.spawnSync('/bin/launchctl', [
        'print',
        `gui/${process.getuid()}/ai.evenfire.desktop.update.${operation.id}`,
      ]).status,
      0,
      'the exact operation must be registered in the GUI user domain'
    )
    quit()
  }
  const manager = new DesktopUpdateManager(
    {
      getDesktopReleaseStatus: async () => ({
        checked: true,
        latestVersion: policy.desktopVersion,
        compatibleVersions: policy.compatibleDesktopVersions,
        releaseTag: policy.releaseTag,
        currentVersion: source.version,
        updateAvailable: source.version !== policy.desktopVersion,
      }),
    },
    () => {},
    {
      platform: 'darwin',
      architecture: 'arm64',
      executablePath: path.join(install, 'Contents/MacOS/Evenfire'),
      getEnvironmentBindingId: () => 'native-helper-fixture',
      detectInstall: async () => ({
        platform: 'darwin',
        architecture: 'arm64',
        packageType: 'app-zip',
        installRoot: install,
        appPath: install,
        executablePath: path.join(install, 'Contents/MacOS/Evenfire'),
      }),
      fetchImpl: async url => {
        if (url === 'https://api.github.com/repos/evenfire-ai/evenfire/releases/tags/v0.12.0')
          return Response.json(release)
        assert.equal(url, asset.browser_download_url)
        return new Response(Readable.toWeb(fs.createReadStream(archive)), {
          headers: { 'content-length': String(asset.size) },
        })
      },
      launchInstallHelper: async plan => {
        operationPath = plan.operationPath
        await fs.promises.writeFile(path.join(operationPath, 'test-mode'), mode, {
          flag: 'wx',
          mode: 0o600,
        })
        await fs.promises.writeFile(
          path.join(operationPath, 'fake-open.sh'),
          String.raw`#!/bin/sh
here=$(/usr/bin/dirname "$0")
testroot=$(/usr/bin/dirname "$(/usr/bin/dirname "$here")")
mode=$(/bin/cat "$here/test-mode")
wait=0; target=''
for arg do case "$arg" in -W) wait=1;; *.app) target="$arg";; esac; done
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$target/Contents/Info.plist" > "$testroot/launched-version"
if [ "$wait" = 1 ]; then
  [ "$mode" != launch-failure ] && [ "$mode" != other-user-target ] || exit 1
  printf '%s' "$$" > "$testroot/open.pid"
  exec /bin/sleep 90
fi
`,
          { flag: 'wx', mode: 0o700 }
        )
        await fs.promises.writeFile(
          path.join(operationPath, 'fake-lsof.sh'),
          String.raw`#!/bin/sh
here=$(/usr/bin/dirname "$0")
testroot=$(/usr/bin/dirname "$(/usr/bin/dirname "$here")")
mode=$(/bin/cat "$here/test-mode")
if [ "$mode" = source-running ]; then /bin/cat "$testroot/source-instance.pid"; exit; fi
if [ "$mode" = other-user-target ] && [ -f "$testroot/launched-version" ]; then
  for arg do [ "$arg" != -u ] || exit 1; done
  /bin/cat "$testroot/source-instance.pid"; exit
fi
if [ "$mode" = observer-failure ] && [ -f "$testroot/open.pid" ]; then exit 2; fi
/bin/cat "$testroot/open.pid" 2>/dev/null
`,
          { flag: 'wx', mode: 0o700 }
        )
        await fs.promises.writeFile(
          path.join(scratch, 'test-operation.json'),
          JSON.stringify({
            id: plan.operationId,
            path: operationPath,
            sourceDigest: plan.currentAsarSha256,
          })
        )
        return launchDesktopInstallHelper(plan)
      },
    }
  )
  await manager.downloadDesktopUpdate('0.12.0', false)
  await manager.installDownloadedUpdate('0.12.0')
}

run().catch(async error => {
  console.error(error)
  if (operationPath) {
    await fs.promises.writeFile(path.join(operationPath, 'cancel-install.json'), '{}')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  app.exit(1)
})
