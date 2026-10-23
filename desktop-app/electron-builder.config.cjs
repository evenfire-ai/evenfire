const { SANDBOX_UI_DEEP_LINK_PROTOCOL } = require('@clerum/desktop-app-links')

const updateReleaseBase = 'https://github.com/evenfire-ai/evenfire/releases/download/'
const evenfireProtocol = SANDBOX_UI_DEEP_LINK_PROTOCOL.replace(/:$/, '')

module.exports = {
  appId: 'ai.evenfire.desktop',
  productName: 'Evenfire',
  executableName: 'Evenfire',
  asar: true,
  compression: 'maximum',
  directories: {
    output: 'out-updater',
  },
  files: ['dist/**/*', 'ui-dist/**/*', 'assets/**/*', 'package.json'],
  extraResources: ['assets/icon-light.png', 'assets/icon-dark.png'],
  protocols: [
    { name: 'Evenfire', schemes: [evenfireProtocol] },
    { name: 'Clerum OAuth callback', schemes: ['clerum'] },
  ],
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  publish: [
    {
      provider: 'generic',
      url: updateReleaseBase,
    },
  ],
  mac: {
    category: 'public.app-category.productivity',
    icon: 'assets/icon.icns',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    artifactName: 'evenfire-desktop-${version}-mac-${arch}.${ext}',
    notarize: Boolean(process.env.APPLE_API_KEY),
  },
  win: {
    icon: 'assets/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    artifactName: 'evenfire-desktop-${version}-windows-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
  linux: {
    category: 'Utility',
    executableName: 'Evenfire',
    icon: 'assets/icon.png',
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
      { target: 'rpm', arch: ['x64', 'arm64'] },
    ],
    artifactName: 'evenfire-desktop-${version}-linux-${arch}.${ext}',
  },
}
