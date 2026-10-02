'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  MAX_PEM_MATERIAL_BYTES,
  parseSigningMaterial,
  parseVerifierMaterial,
} = require('./index.cjs')

const SLOTS = new Set(['rpc', 'session', 'admin'])
const REASON_MESSAGES = Object.freeze({
  invalid_slot: 'slot must be rpc, session, or admin',
  relative_store_path: 'directory must be an absolute path',
  unsupported_platform: 'requires POSIX effective-user and no-follow/nonblocking guarantees',
  invalid_directory: 'path is not a directory',
  symbolic_link: 'path is a symbolic link',
  directory_owner_mismatch: 'directory is not owned by the current user',
  insecure_directory: 'directory has group/other permissions; expected owner-only permissions',
  not_regular_file: 'path is not a regular file',
  file_owner_mismatch: 'file is not owned by the current user',
  insecure_file: 'file has unsafe group/other permissions',
  material_too_large: 'material exceeds the 64 KiB read limit',
  missing_material: 'required material is missing',
  orphan_public: 'has a public file without its signing material; operator recovery is required',
  public_identity_mismatch: 'public file does not match its signing material; operator recovery is required',
  temporary_collision: 'temporary path already exists; its contents were preserved',
  incomplete_write: 'temporary file was not written completely',
})

class DevKeyStoreError extends Error {
  constructor(source, reason) {
    super(`Dev JWT key store ${REASON_MESSAGES[reason]}: ${source}`)
    this.name = 'DevKeyStoreError'
    this.code = 'ERR_JWT_DEV_STORE'
    this.reason = reason
    this.source = source
  }
}

function fail(source, reason) {
  throw new DevKeyStoreError(source, reason)
}

function absoluteStoreDirectory(storeDir) {
  if (typeof storeDir !== 'string' || !path.isAbsolute(storeDir)) {
    fail('EVENFIRE_DEV_KEY_STORE', 'relative_store_path')
  }
  // Lexical normalization preserves the final symlink for lstat. realpath
  // would follow that symlink before the boundary could reject it.
  return path.resolve(storeDir)
}

function resolveDevKeyStoreDir(serviceRoot, override) {
  const supplied = typeof override === 'string' ? override.trim() : override
  if (supplied !== undefined && typeof supplied !== 'string') {
    fail('EVENFIRE_DEV_KEY_STORE', 'relative_store_path')
  }
  if (supplied) return absoluteStoreDirectory(supplied)
  return path.join(absoluteStoreDirectory(serviceRoot), '.dev-keys')
}

function storePaths(slot, storeDir) {
  // Validate the closed slot before constructing any filesystem path.
  if (!SLOTS.has(slot)) fail('dev JWT slot', 'invalid_slot')
  const directory = absoluteStoreDirectory(storeDir)
  assertPosixStoreSupport(directory)
  return {
    directory,
    privatePath: path.join(directory, `${slot}.pem`),
    publicPath: path.join(directory, `${slot}.public.pem`),
  }
}

function assertPosixStoreSupport(source) {
  const requiredFlags = ['O_NOFOLLOW', 'O_NONBLOCK', 'O_CREAT', 'O_EXCL']
  if (
    process.platform === 'win32' ||
    typeof process.geteuid !== 'function' ||
    !requiredFlags.every(name => Number.isInteger(fs.constants[name]) && fs.constants[name] > 0)
  ) {
    fail(source, 'unsupported_platform')
  }
}

function assertDirectoryStats(directory, stats) {
  if (stats.isSymbolicLink()) fail(directory, 'symbolic_link')
  if (!stats.isDirectory()) fail(directory, 'invalid_directory')
  if (stats.uid !== process.geteuid()) fail(directory, 'directory_owner_mismatch')
  if ((stats.mode & 0o077) !== 0) fail(directory, 'insecure_directory')
}

function readDirectoryStats(directory) {
  return fs.lstatSync(directory, { throwIfNoEntry: false })
}

function ensureStoreDirectory(directory) {
  let stats = readDirectoryStats(directory)
  if (!stats) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // A cooperating process created the directory; validate its result.
    }
    stats = readDirectoryStats(directory)
    if (!stats) fail(directory, 'missing_material')
  }
  assertDirectoryStats(directory, stats)
}

function assertFileStats(filePath, stats, visibility) {
  if (!stats.isFile()) fail(filePath, 'not_regular_file')
  if (stats.uid !== process.geteuid()) fail(filePath, 'file_owner_mismatch')
  const unsafeMask = visibility === 'private' ? 0o077 : 0o022
  if ((stats.mode & unsafeMask) !== 0) fail(filePath, 'insecure_file')
  if (stats.size > MAX_PEM_MATERIAL_BYTES) fail(filePath, 'material_too_large')
}

function closePreservingFailure(fd, primaryFailure) {
  try {
    fs.closeSync(fd)
  } catch (error) {
    if (!primaryFailure) throw error
  }
}

function readStoreFile(filePath, visibility) {
  let fd
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    if (error.code === 'ELOOP') fail(filePath, 'symbolic_link')
    throw error
  }
  let primaryFailure
  try {
    assertFileStats(filePath, fs.fstatSync(fd), visibility)
    // One bounded buffer also keeps repeated short reads from retaining a new
    // allocation per chunk. The extra byte detects exact-limit file growth.
    const buffer = Buffer.allocUnsafe(MAX_PEM_MATERIAL_BYTES + 1)
    let bytes = 0
    for (;;) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null)
      if (count === 0) return buffer.subarray(0, bytes).toString('utf8')
      bytes += count
      if (bytes > MAX_PEM_MATERIAL_BYTES) fail(filePath, 'material_too_large')
    }
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    closePreservingFailure(fd, primaryFailure)
  }
}

function readSigningFile(privatePath) {
  const raw = readStoreFile(privatePath, 'private')
  return raw === undefined
    ? undefined
    : parseSigningMaterial(raw, `dev JWT signing key (${path.basename(privatePath)})`)
}

function readPublicFile(publicPath) {
  const raw = readStoreFile(publicPath, 'public')
  return raw === undefined
    ? undefined
    : parseVerifierMaterial(raw, `dev JWT verifier key (${path.basename(publicPath)})`, { origin: 'store' })
}

/**
 * Publish a complete owned candidate without replacing a final filename.
 * Trusted ancestors and cooperating processes under the same euid are the
 * filesystem boundary; path operations are not an adversarial openat sandbox.
 * Atomic cooperation does not promise fsync/power-loss durability.
 */
function publishMaterial(finalPath, pem, visibility) {
  const temporary = `${finalPath}.tmp-${process.pid.toString(36)}-${crypto.randomBytes(6).toString('hex')}`
  const bytes = Buffer.from(pem, 'utf8')
  const mode = visibility === 'private' ? 0o600 : 0o644
  let fd
  let ownsTemporary = false
  let primaryFailure
  try {
    try {
      fd = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        mode
      )
      ownsTemporary = true
    } catch (error) {
      // An existing candidate is not a final-publication winner. Never adopt,
      // truncate or remove another operation's temporary file.
      if (error.code === 'EEXIST' || error.code === 'ELOOP') {
        fail(temporary, 'temporary_collision')
      }
      throw error
    }
    assertFileStats(temporary, fs.fstatSync(fd), visibility)
    let written = 0
    while (written < bytes.length) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written, null)
      if (count === 0) fail(temporary, 'incomplete_write')
      written += count
    }
    const stats = fs.fstatSync(fd)
    assertFileStats(temporary, stats, visibility)
    if (stats.size !== bytes.length) fail(temporary, 'incomplete_write')
    try {
      fs.linkSync(temporary, finalPath)
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let cleanupFailure
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (error) { cleanupFailure = error }
    }
    if (ownsTemporary) {
      try { fs.unlinkSync(temporary) } catch (error) {
        if (error.code !== 'ENOENT' && !cleanupFailure) cleanupFailure = error
      }
    }
    if (!primaryFailure && cleanupFailure) throw cleanupFailure
  }
}

function assertPublicIdentity(publicPath, publicMaterial, signingMaterial) {
  if (publicMaterial.fingerprint !== signingMaterial.fingerprint) {
    fail(publicPath, 'public_identity_mismatch')
  }
}

function ensurePublicMaterial(publicPath, signingMaterial) {
  let verifying = readPublicFile(publicPath)
  if (!verifying) {
    publishMaterial(publicPath, signingMaterial.publicPem, 'public')
    // Validate the actual opened winner, including successful own publication.
    verifying = readPublicFile(publicPath)
    if (!verifying) fail(publicPath, 'missing_material')
  }
  assertPublicIdentity(publicPath, verifying, signingMaterial)
}

function loadOrCreateDevSigningMaterial(slot, absoluteStore) {
  const { directory, privatePath, publicPath } = storePaths(slot, absoluteStore)
  ensureStoreDirectory(directory)
  let signing = readSigningFile(privatePath)
  if (!signing && readPublicFile(publicPath)) {
    // A cooperating process may have published its complete pair between the
    // first missing-private read and the public read. Re-read once, never mint
    // a replacement identity over an orphan public file.
    signing = readSigningFile(privatePath)
    if (!signing) fail(publicPath, 'orphan_public')
  }
  if (!signing) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const candidate = parseSigningMaterial(privateKey, `dev JWT signing key (${path.basename(privatePath)})`)
    publishMaterial(privatePath, candidate.privatePem, 'private')
    // Always consume the published inode. An EEXIST winner owns the identity,
    // not this process's generated candidate.
    signing = readSigningFile(privatePath)
    if (!signing) fail(privatePath, 'missing_material')
  }
  ensurePublicMaterial(publicPath, signing)
  return signing
}

function readDevVerifierMaterial(slot, absoluteStore) {
  const { directory, publicPath } = storePaths(slot, absoluteStore)
  const stats = readDirectoryStats(directory)
  if (!stats) fail(directory, 'missing_material')
  assertDirectoryStats(directory, stats)
  const verifying = readPublicFile(publicPath)
  if (!verifying) fail(publicPath, 'missing_material')
  return verifying
}

module.exports = {
  DevKeyStoreError,
  resolveDevKeyStoreDir,
  loadOrCreateDevSigningMaterial,
  readDevVerifierMaterial,
}
