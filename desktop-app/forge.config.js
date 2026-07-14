const { execSync } = require('node:child_process')
const { FusesPlugin } = require('@electron-forge/plugin-fuses')
const { FuseV1Options, FuseVersion } = require('@electron/fuses')

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'Evenfire',
    // When you have a real mac icon, uncomment this:
    // icon: './assets/icon.icns',

    // For public distribution later, enable signing on a Mac with valid Apple certs:
    // osxSign: {},
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
          license: 'MIT',
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
