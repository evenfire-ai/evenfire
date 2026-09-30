import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  type Stats,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
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
const DEFAULT_STORE_DIR =
  process.env.EVENFIRE_DEV_KEY_STORE?.trim() || join(SERVICE_ROOT, '.dev-keys')

export function defaultDevSigningKeyStoreDir(): string {
  return DEFAULT_STORE_DIR
}

type StoreFileVisibility = 'owner-only' | 'shared-read'

function assertStoreFileStats(
  filePath: string,
  stats: Stats,
  visibility: StoreFileVisibility
): void {
  if (!stats.isFile()) {
    throw new Error(`Dev JWT key store path is not a regular file: ${filePath}`)
  }
  if (process.geteuid && stats.uid !== process.geteuid()) {
    throw new Error(`Dev JWT key store file is not owned by the current user: ${filePath}`)
  }
  if (visibility === 'owner-only' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      `Dev JWT key store file has group/other permissions; expected 0600: ${filePath}`
    )
  }
  if (visibility === 'shared-read' && (stats.mode & 0o022) !== 0) {
    throw new Error(`Dev JWT key store public file must not be group/other writable: ${filePath}`)
  }
}

/**
 * Opens an existing store file without following symlinks and validates the
 * opened descriptor itself, eliminating check-then-read filesystem races.
 * Returns undefined only for ENOENT; the caller owns and must close the fd.
 */
function openStoreFileNoFollow(
  filePath: string,
  visibility: StoreFileVisibility
): number | undefined {
  let fd: number | undefined
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP') {
      throw new Error(`Dev JWT key store path is a symbolic link: ${filePath}`)
    }
    throw err
  }
  try {
    assertStoreFileStats(filePath, fstatSync(fd), visibility)
  } catch (err) {
    closeSync(fd)
    throw err
  }
  return fd
}

function readStoreFileNoFollow(
  filePath: string,
  visibility: StoreFileVisibility
): string | undefined {
  const fd = openStoreFileNoFollow(filePath, visibility)
  if (fd === undefined) return undefined
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function assertOwnedRegularFile(filePath: string): void {
  const fd = openStoreFileNoFollow(filePath, 'owner-only')
  if (fd === undefined) throw new Error(`Dev JWT key store file is missing: ${filePath}`)
  closeSync(fd)
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
  let raw: string | undefined
  try {
    raw = readStoreFileNoFollow(filePath, 'owner-only')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  if (raw === undefined) return undefined
  try {
    return validateRsaPrivateKeyPem(raw.trim(), `${slot} dev signing key`)
  } catch (err) {
    throw new Error(
      `Dev JWT key store file is corrupt or not an RSA private key (delete it only if you accept losing dev tokens): ${filePath}: ${(err as Error).message}`
    )
  }
}

let warnedOnce = false

function readStoredDerivedPublic(publicPath: string): string | undefined {
  return readStoreFileNoFollow(publicPath, 'shared-read')?.trim()
}

function assertMatchingDerivedPublic(publicPath: string, existing: string, derived: string): void {
  if (existing !== derived) {
    throw new Error(
      `Dev JWT key store public file does not match its signing material: ${publicPath}. ` +
        'Delete the store only if you accept losing local dev tokens.'
    )
  }
}

/**
 * Publish the verifying half derived from the signing material as
 * `<slot>.public.pem` (0644 inside the 0700 store). Sibling dev verifiers read
 * this file so the monorepo dev boot shares one key identity; it is never
 * written independently, and an existing copy that disagrees with the signing
 * material is a hard error.
 */
function ensureDerivedPublicKey(slot: DevJwtSlot, storeDir: string, signingPem: string): void {
  const publicPath = join(storeDir, `${slot}.public.pem`)
  const derived = createPublicKey(signingPem)
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .trim()
  const existing = readStoredDerivedPublic(publicPath)
  if (existing !== undefined) {
    assertMatchingDerivedPublic(publicPath, existing, derived)
    return
  }
  const tempPath = `${publicPath}.tmp-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tempPath, derived, { mode: 0o644 })
    linkSync(tempPath, publicPath)
    unlinkSync(tempPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      removeIfPresent(tempPath)
      // Validate the winning opened file before returning a usable identity.
      const winner = readStoredDerivedPublic(publicPath)
      if (winner === undefined) {
        throw new Error(`Dev JWT key store public file disappeared: ${publicPath}`)
      }
      assertMatchingDerivedPublic(publicPath, winner, derived)
      return
    }
    throw err
  }
}

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
  if (!isAbsolute(storeDir)) {
    throw new Error('EVENFIRE_DEV_KEY_STORE must be an absolute path when dev JWT keys are needed.')
  }
  const filePath = join(storeDir, `${slot}.pem`)
  // Validate the store boundary on every path, including pure reuse of an
  // already-persisted key.
  ensureStoreDir(storeDir)
  let existing = readPersistedKey(filePath, slot)
  const publicPath = join(storeDir, `${slot}.public.pem`)
  if (!existing && readStoredDerivedPublic(publicPath) !== undefined) {
    // A concurrent first start may have completed between the two reads.
    // Adopt its private key; never publish a new identity over an orphan public key.
    existing = readPersistedKey(filePath, slot)
    if (!existing) {
      throw new Error(
        `Dev JWT key store has a public file without its signing material: ${publicPath}. ` +
          `Restore the matching signing key at ${filePath}, or remove ${publicPath} ` +
          'only if you accept invalidating local dev tokens.'
      )
    }
  }
  if (existing) {
    ensureDerivedPublicKey(slot, storeDir, existing)
    warnOnce(storeDir)
    return existing
  }
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  createPrivateKey(privateKey) // sanity: the generated key must re-parse
  // Publish atomically: write a complete 0600 temp file, then hard-link it
  // under the final name. link(2) fails with EEXIST when another process won,
  // and readers can only ever observe a fully written key.
  const tempPath = `${filePath}.tmp-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tempPath, privateKey, { mode: 0o600 })
    assertOwnedRegularFile(tempPath)
    linkSync(tempPath, filePath)
    unlinkSync(tempPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      removeIfPresent(tempPath)
      // Another local process published a complete key first; adopt it.
      const winner = readPersistedKey(filePath, slot)
      if (winner) {
        ensureDerivedPublicKey(slot, storeDir, winner)
        warnOnce(storeDir)
        return winner
      }
    }
    throw err
  }
  assertOwnedRegularFile(filePath)
  ensureDerivedPublicKey(slot, storeDir, privateKey)
  warnOnce(storeDir)
  return privateKey.trim()
}

function warnOnce(storeDir: string): void {
  if (warnedOnce) return
  warnedOnce = true
  console.warn(
    '[ControlAPI] Dev JWT signing keys are active (CLERUM_DEV_MODE). Keys are generated locally ' +
      `and stored under ${JSON.stringify(storeDir)}; they are never valid for production deployments.`
  )
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
