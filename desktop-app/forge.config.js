const { execFileSync, execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FusesPlugin } = require('@electron-forge/plugin-fuses')
const { FuseV1Options, FuseVersion } = require('@electron/fuses')
const {
  CLERUM_OAUTH_PROTOCOL,
  SANDBOX_UI_DEEP_LINK_PROTOCOL,
} = require('@clerum/desktop-app-links')

const desktopLicense = require('./package.json').license
const defaultAppleBundleId = 'ai.evenfire.desktop'
const assetsDirectory = path.resolve(__dirname, 'assets')
const adaptiveIconDocument = path.join(assetsDirectory, 'adaptive-icon.icon')
const evenfireProtocol = SANDBOX_UI_DEEP_LINK_PROTOCOL.replace(/:$/, '')
const clerumProtocol = CLERUM_OAUTH_PROTOCOL.replace(/:$/, '')

function compileMacAdaptiveIcon(buildPath, _electronVersion, platform, _arch, callback) {
  if (platform !== 'darwin') {
    callback()
    return
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-app-icon-'))
  const compileDirectory = path.join(temporaryDirectory, 'compiled')
  const compileInput = path.join(temporaryDirectory, 'Icon.icon')
  const partialInfoPath = path.join(temporaryDirectory, 'partial-info.plist')
  const appDirectory = path.join(buildPath, 'Evenfire.app')
  const resourcesDirectory = path.join(appDirectory, 'Contents', 'Resources')
  const infoPlistPath = path.join(appDirectory, 'Contents', 'Info.plist')

  let hookError
  try {
    fs.mkdirSync(compileDirectory, { recursive: true })
    fs.cpSync(adaptiveIconDocument, compileInput, { recursive: true })
    execFileSync(
      'xcrun',
      [
        'actool',
        compileInput,
        '--compile',
        compileDirectory,
        '--output-format',
        'human-readable-text',
        '--notices',
        '--warnings',
        '--platform',
        'macosx',
        '--minimum-deployment-target',
        '26.0',
        '--app-icon',
        'Icon',
        '--include-all-app-icons',
        '--output-partial-info-plist',
        partialInfoPath,
        '--enable-on-demand-resources',
        'NO',
        '--target-device',
        'mac',
      ],
      { stdio: 'inherit' }
    )
    fs.copyFileSync(
      path.join(compileDirectory, 'Assets.car'),
      path.join(resourcesDirectory, 'Assets.car')
    )
    fs.copyFileSync(
      path.join(compileDirectory, 'Icon.icns'),
      path.join(resourcesDirectory, 'Icon.icns')
    )
    execFileSync(
      '/usr/bin/plutil',
      ['-replace', 'CFBundleIconName', '-string', 'Icon', infoPlistPath],
      { stdio: 'inherit' }
    )
  } catch (error) {
    if (process.env.EVENFIRE_REQUIRE_ADAPTIVE_ICONS === '1') {
      hookError = error
    } else {
      console.warn(
        'Skipping the macOS adaptive icon catalog; the compatible static icon remains available.'
      )
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
  callback(hookError)
}

function resolveOsxSignConfig() {
  if (process.platform !== 'darwin' || process.env.ENABLE_APPLE_CODESIGN !== '1') {
    return undefined
  }

  const osxSign = {}

  if (process.env.APPLE_CODESIGN_IDENTITY) {
    osxSign.identity = process.env.APPLE_CODESIGN_IDENTITY
  }

  if (process.env.APPLE_KEYCHAIN) {
    osxSign.keychain = process.env.APPLE_KEYCHAIN
  }

  return osxSign
}

function resolveOsxNotarizeConfig() {
  if (process.platform !== 'darwin' || process.env.ENABLE_APPLE_CODESIGN !== '1') {
    return undefined
  }

  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) {
    return {
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER,
    }
  }

  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    const osxNotarize = {
      keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE,
    }

    if (process.env.APPLE_KEYCHAIN) {
      osxNotarize.keychain = process.env.APPLE_KEYCHAIN
    }

    return osxNotarize
  }

  throw new Error(
    'ENABLE_APPLE_CODESIGN=1 requires either APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER or APPLE_KEYCHAIN_PROFILE.'
  )
}

const osxSign = resolveOsxSignConfig()
const osxNotarize = resolveOsxNotarizeConfig()

module.exports = {
  packagerConfig: {
    asar: true,
    // npm installs internal file: dependencies as symlinks. Copy their contents
    // into the staging app so ASAR never contains links to the monorepo outside
    // desktop-app (which Electron correctly rejects as an escaping symlink).
    derefSymlinks: true,
    executableName: 'Evenfire',
    name: 'Evenfire',
    icon: './assets/icon',
    darwinDarkModeSupport: true,
    extraResource: ['./assets/icon-light.png', './assets/icon-dark.png'],
    afterCopyExtraResources: [compileMacAdaptiveIcon],
    appBundleId: process.env.APPLE_BUNDLE_ID || defaultAppleBundleId,
    appCategoryType: 'public.app-category.productivity',
    protocols: [
      {
        name: 'Evenfire',
        schemes: [evenfireProtocol],
      },
      {
        name: 'Clerum OAuth callback',
        schemes: [clerumProtocol],
      },
    ],
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
  },

  rebuildConfig: {},

  hooks: {
    prePackage: async () => {
      if (process.env.EVENFIRE_SKIP_PACKAGE_BUILD === '1') return
      execSync('npm run build', { stdio: 'inherit' })
    },
  },

  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        icon: path.join(assetsDirectory, 'icon.icns'),
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        authors: 'Evenfire',
        name: 'Evenfire',
        title: 'Evenfire',
        setupExe: 'EvenfireSetup.exe',
        setupIcon: path.join(assetsDirectory, 'icon.ico'),
      },
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'evenfire',
          productName: 'Evenfire',
          genericName: 'Evenfire',
          bin: 'Evenfire',
          categories: ['Utility'],
          icon: path.join(assetsDirectory, 'icon.png'),
          mimeType: [`x-scheme-handler/${evenfireProtocol}`, `x-scheme-handler/${clerumProtocol}`],
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          name: 'evenfire',
          productName: 'Evenfire',
          genericName: 'Evenfire',
          bin: 'Evenfire',
          license: desktopLicense,
          categories: ['Utility'],
          icon: path.join(assetsDirectory, 'icon.png'),
          mimeType: [`x-scheme-handler/${evenfireProtocol}`, `x-scheme-handler/${clerumProtocol}`],
        },
      },
    },
  ],

  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}
