import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { type Stats, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateRsaPrivateKeyPem } from './bannedDevSigningKeys.js'

export type DevJwtSlot = 'rpc' | 'session' | 'admin'

/**
 * Local-only dev key store at <service>/.dev-keys, gitignored and never
 * touched when operators supply the three JWT key env vars or outside
 * CLERUM_DEV_MODE. Works in every supported runtime: CommonJS (dist and
 * ts-node) resolves __dirname to <service>/dist or <service>/src, so its
 * parent is the service root; Vitest's ESM transform has no __dirname and
 * falls back to the service working directory used by every test/npm script.
 */
const SERVICE_ROOT = typeof __dirname === 'string' && __dirname ? dirname(__dirname) : process.cwd()
const DEFAULT_STORE_DIR = join(SERVICE_ROOT, '.dev-keys')

export function defaultDevSigningKeyStoreDir(): string {
  return DEFAULT_STORE_DIR
}

function assertOwnedRegularFile(filePath: string): void {
  const stats = lstatSync(filePath, { throwIfNoEntry: false })
  if (!stats) throw new Error(`Dev JWT key store file is missing after creation: ${filePath}`)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Dev JWT key store path is not a regular file: ${filePath}`)
  }
  if (process.geteuid && stats.uid !== process.geteuid()) {
    throw new Error(`Dev JWT key store file is not owned by the current user: ${filePath}`)
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `Dev JWT key store file has group/other permissions; expected 0600: ${filePath}`
    )
  }
}

function assertOwnedPrivateDirectory(dirPath: string, stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Dev JWT key store path is not a directory: ${dirPath}`)
  }
  if (process.geteuid && stats.uid !== process.geteuid()) {
    throw new Error(`Dev JWT key store directory is not owned by the current user: ${dirPath}`)
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `Dev JWT key store directory has group/other permissions; expected 0700: ${dirPath}`
    )
  }
}

function ensureStoreDir(storeDir: string): void {
  const stats = lstatSync(storeDir, { throwIfNoEntry: false })
  if (stats) {
    assertOwnedPrivateDirectory(storeDir, stats)
    return
  }
  try {
    mkdirSync(storeDir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Lost a creation race with another local process; revalidate the winner.
  }
  const dirStats = lstatSync(storeDir, { throwIfNoEntry: false })
  if (!dirStats) throw new Error(`Dev JWT key store directory disappeared: ${storeDir}`)
  assertOwnedPrivateDirectory(storeDir, dirStats)
}

function readPersistedKey(filePath: string, slot: DevJwtSlot): string | undefined {
  const stats = lstatSync(filePath, { throwIfNoEntry: false })
  if (!stats) return undefined
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Dev JWT key store path is not a regular file: ${filePath}`)
  }
  if (process.geteuid && stats.uid !== process.geteuid()) {
    throw new Error(`Dev JWT key store file is not owned by the current user: ${filePath}`)
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `Dev JWT key store file has group/other permissions; expected 0600: ${filePath}`
    )
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    return validateRsaPrivateKeyPem(raw.trim(), `${slot} dev signing key`)
  } catch (err) {
    throw new Error(
      `Dev JWT key store file is corrupt or not an RSA private key (delete it only if you accept losing dev tokens): ${filePath}: ${(err as Error).message}`
    )
  }
}

let warnedOnce = false

/**
 * Returns the dev private key for a slot, generating and persisting it with
 * exclusive creation on first use. Concurrent first starts converge on one
 * key per slot; existing files are never overwritten. The store directory is
 * only touched when a key is actually needed.
 */
export function loadOrGenerateDevJwtPrivateKey(
  slot: DevJwtSlot,
  storeDir: string = DEFAULT_STORE_DIR
): string {
  const filePath = join(storeDir, `${slot}.pem`)
  const existing = readPersistedKey(filePath, slot)
  if (existing) {
    warnOnce()
    return existing
  }
  ensureStoreDir(storeDir)
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  try {
    writeFileSync(filePath, privateKey, { flag: 'wx', mode: 0o600 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another local process created the key first; adopt it.
      const winner = readPersistedKey(filePath, slot)
      if (winner) {
        warnOnce()
        return winner
      }
    }
    throw err
  }
  assertOwnedRegularFile(filePath)
  createPrivateKey(privateKey) // sanity: the generated key must re-parse
  warnOnce()
  return privateKey.trim()
}

function warnOnce(): void {
  if (warnedOnce) return
  warnedOnce = true
  console.warn(
    '[ControlAPI] Dev JWT signing keys are active (CLERUM_DEV_MODE). Keys are generated locally ' +
      'and stored under control-api/.dev-keys; they are never valid for production deployments.'
  )
}
