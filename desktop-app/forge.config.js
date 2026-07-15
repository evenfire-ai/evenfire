const { execSync } = require('node:child_process')
const { FusesPlugin } = require('@electron-forge/plugin-fuses')
const { FuseV1Options, FuseVersion } = require('@electron/fuses')

const desktopLicense = require('./package.json').license
const defaultAppleBundleId = 'ai.evenfire.desktop'

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
    'ENABLE_APPLE_CODESIGN=1 requires either APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER or APPLE_KEYCHAIN_PROFILE.',
  )
}

const osxSign = resolveOsxSignConfig()
const osxNotarize = resolveOsxNotarizeConfig()

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'Evenfire',
    appBundleId: process.env.APPLE_BUNDLE_ID || defaultAppleBundleId,
    appCategoryType: 'public.app-category.productivity',
    // When you have a real mac icon, uncomment this:
    // icon: './assets/icon.icns',
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
  },

  rebuildConfig: {},

  hooks: {
    prePackage: async () => {
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
      config: {},
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        authors: 'Evenfire',
        name: 'Evenfire',
        title: 'Evenfire',
        setupExe: 'EvenfireSetup.exe',
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
