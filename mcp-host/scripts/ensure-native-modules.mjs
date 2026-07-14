import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const nativeModules = ['better-sqlite3']

function isNativeAbiError(error) {
  const message = String(error?.message ?? error ?? '')
  return (
    message.includes('NODE_MODULE_VERSION') ||
    message.includes('was compiled against a different Node.js version') ||
    message.includes('Cannot find module') ||
    message.includes('dlopen') ||
    message.includes('wrong architecture')
  )
}

function loadNativeModule(name) {
  const nativeModule = require(name)
  if (name === 'better-sqlite3') {
    const db = new nativeModule(':memory:')
    db.close()
  }
}

function rebuildNativeModule(name) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['rebuild', name], {
    cwd: packageRoot,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.stderr.write(
      `[native-modules] npm rebuild ${name} failed with exit code ${result.status ?? 'unknown'}\n`
    )
    process.exit(result.status ?? 1)
  }
}

for (const name of nativeModules) {
  try {
    loadNativeModule(name)
  } catch (error) {
    if (!isNativeAbiError(error)) {
      throw error
    }

    process.stderr.write(
      `[native-modules] ${name} is not loadable for Node ${process.version} ` +
        `(ABI ${process.versions.modules}); rebuilding package-local native module.\n`
    )
    rebuildNativeModule(name)
    loadNativeModule(name)
  }
}
