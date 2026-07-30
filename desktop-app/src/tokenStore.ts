import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SERVICE = 'Evenfire'
/**
 * Legacy single global slot (pre per-environment scoping). Read once for a
 * best-effort migration into the active environment's slot, then deleted.
 */
const LEGACY_ACCOUNT = 'session-token'

/**
 * Exact shape emitted by `resolveEnvKey` (config.ts): a `[a-z0-9_]` slug, a
 * `-` separator, and a 12-hex sha256 suffix. Every call site feeds `envKey`
 * straight into keychain account names and on-disk file names, so validate the
 * shape before interpolating — defense in depth mirroring the
 * `assertSafeFilesystemSegment` guard in chatStore/chatStoreBinding. Today all callers
 * pass sanitized `getActiveEnvKey()` output, so a mismatch signals a bug (or a
 * tampered value), never a normal input.
 */
const ENV_KEY_SHAPE = /^[a-z0-9_]+-[0-9a-f]{12}$/

function assertEnvKey(envKey: string): void {
  if (!ENV_KEY_SHAPE.test(envKey)) {
    throw new Error('Invalid envKey: unexpected shape')
  }
}

/**
 * Per-environment keychain account (spec §5.2). Each environment stores/reads
 * its OWN session token, so switching clusters never leaks env A's token into
 * env B. `envKey` is the stable, filesystem/keychain-safe key from
 * `resolveEnvKey`.
 */
function accountFor(envKey: string): string {
  const key = String(envKey || '').trim()
  return key ? `${LEGACY_ACCOUNT}::${key}` : LEGACY_ACCOUNT
}

type KeytarModule = {
  getPassword: (service: string, account: string) => Promise<string | null>
  setPassword: (service: string, account: string, password: string) => Promise<void>
  deletePassword: (service: string, account: string) => Promise<boolean>
}

function isKeytarModule(value: unknown): value is KeytarModule {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<KeytarModule>
  return (
    typeof candidate.getPassword === 'function' &&
    typeof candidate.setPassword === 'function' &&
    typeof candidate.deletePassword === 'function'
  )
}

async function loadKeytar(): Promise<KeytarModule | null> {
  try {
    const mod = await import('keytar')
    if (isKeytarModule(mod)) {
      return mod
    }
    const defaultExport = (mod as { default?: unknown }).default
    if (isKeytarModule(defaultExport)) {
      return defaultExport
    }
    return null
  } catch {
    return null
  }
}

async function resolvedStorageBase(): Promise<string> {
  const base = app?.isReady() ? app.getPath('userData') : path.join(os.homedir(), '.evenfire')
  await fs.mkdir(base, { recursive: true })
  return base
}

async function encryptedFilePath(envKey: string): Promise<string> {
  const key = String(envKey || '').trim()
  const name = key ? `session-token-${key}.enc` : 'session-token.enc'
  return path.join(await resolvedStorageBase(), name)
}

/** Per-env plain-text fallback (only when neither keytar nor safeStorage exist). */
async function plainFilePath(envKey: string): Promise<string> {
  const key = String(envKey || '').trim()
  const name = key ? `session-token-${key}.json` : 'session-token.json'
  return path.join(await resolvedStorageBase(), name)
}

/** Legacy pre-per-env safeStorage file (global slot). */
async function legacyEncryptedFilePath(): Promise<string> {
  return path.join(await resolvedStorageBase(), 'session-token.enc')
}

/** Legacy plain-text fallback file (global slot). */
async function legacyFilePath(): Promise<string> {
  return path.join(await resolvedStorageBase(), 'session-token.json')
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP'
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(directoryPath, 'r')
    await handle.sync()
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error
  } finally {
    await handle?.close()
  }
}

async function writeTokenFileAtomic(filePath: string, value: string | Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(temporaryPath, 'w', 0o600)
    await handle.writeFile(value)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryPath, filePath)
    await syncDirectory(path.dirname(filePath))
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function removeTokenFileDurably(filePath: string): Promise<void> {
  await fs.unlink(filePath)
  await syncDirectory(path.dirname(filePath))
}

export class TokenStore {
  /**
   * Read the session token for `envKey`. Falls back keytar → safeStorage file,
   * optional older env-key aliases, then does a one-time best-effort migration
   * of the pre-per-env GLOBAL slot into this environment's slot.
   *
   * The legacy env-key aliases are explicit caller-provided upgrade paths, such
   * as REST-only `resolveEnvKey(rest)` → REST+RPC `resolveEnvKey(rest, rpc)`.
   * When one is found, it is copied to the new slot and deleted from the old
   * slot so it cannot be read into another runtime boundary later.
   */
  async getSessionToken(
    envKey: string,
    options: { legacyEnvKeys?: readonly string[] } = {}
  ): Promise<string | null> {
    assertEnvKey(envKey)
    const account = accountFor(envKey)
    const keytar = await loadKeytar()
    if (keytar) {
      try {
        const stored = await keytar.getPassword(SERVICE, account)
        if (stored) return stored
      } catch {
        // Packaged builds can fail keychain access depending on host policies.
        // Fall back to the local encrypted store so auth flow can continue.
      }
    }

    if (app?.isReady() && safeStorage.isEncryptionAvailable()) {
      try {
        const file = await encryptedFilePath(envKey)
        const encrypted = await fs.readFile(file)
        return safeStorage.decryptString(encrypted)
      } catch {
        // File may not exist yet.
      }
    }

    // Pure-fallback platforms (no keytar AND no safeStorage) persist to the
    // per-env plain-text file — read it back symmetrically before falling
    // through to the one-time legacy-global migration.
    try {
      const file = await plainFilePath(envKey)
      const raw = await fs.readFile(file, 'utf8')
      const data = JSON.parse(raw) as { token?: unknown }
      if (typeof data.token === 'string' && data.token) return data.token
    } catch {
      // No per-env plain-text token — fall through to legacy migration.
    }

    const migratedScopedToken = await this.migrateLegacyEnvToken(
      envKey,
      options.legacyEnvKeys ?? [],
      keytar
    )
    if (migratedScopedToken) return migratedScopedToken

    return this.migrateLegacyGlobalToken(envKey, keytar)
  }

  /**
   * One-time migration from older environment-scoped account/file names into
   * the current env key. Used when the env-key derivation changes but the REST
   * origin still matches the token issuer.
   */
  private async migrateLegacyEnvToken(
    envKey: string,
    legacyEnvKeys: readonly string[],
    keytar: KeytarModule | null
  ): Promise<string | null> {
    const candidates = Array.from(
      new Set(
        legacyEnvKeys.map(key => String(key || '').trim()).filter(key => key && key !== envKey)
      )
    )
    for (const legacyEnvKey of candidates) {
      assertEnvKey(legacyEnvKey)
      const legacyAccount = accountFor(legacyEnvKey)
      if (keytar) {
        try {
          const token = await keytar.getPassword(SERVICE, legacyAccount)
          if (token) {
            await this.setSessionToken(token, envKey)
            await keytar.deletePassword(SERVICE, legacyAccount).catch(() => {})
            return token
          }
        } catch {
          // keychain unavailable — try file fallbacks below.
        }
      }

      if (app?.isReady() && safeStorage.isEncryptionAvailable()) {
        try {
          const file = await encryptedFilePath(legacyEnvKey)
          const encrypted = await fs.readFile(file)
          const token = safeStorage.decryptString(encrypted)
          if (token) {
            await this.setSessionToken(token, envKey)
            await removeTokenFileDurably(file).catch(() => {})
            return token
          }
        } catch {
          // no legacy encrypted file — fall through to plain-text.
        }
      }

      try {
        const file = await plainFilePath(legacyEnvKey)
        const raw = await fs.readFile(file, 'utf8')
        const data = JSON.parse(raw) as { token?: unknown }
        const token = typeof data.token === 'string' && data.token ? data.token : null
        if (token) {
          await this.setSessionToken(token, envKey)
          await removeTokenFileDurably(file).catch(() => {})
          return token
        }
      } catch {
        // no legacy plain-text file — try next candidate.
      }
    }
    return null
  }

  /**
   * One-time migration of the legacy global slot (keytar `session-token`, then
   * the plain-text/enc files) into this environment's slot. Returns the token
   * if any legacy store held one, else null. The legacy source is deleted once
   * copied so it can never be read into a second environment.
   */
  private async migrateLegacyGlobalToken(
    envKey: string,
    keytar: KeytarModule | null
  ): Promise<string | null> {
    // Legacy keytar global account.
    if (keytar) {
      try {
        const legacy = await keytar.getPassword(SERVICE, LEGACY_ACCOUNT)
        if (legacy) {
          await this.setSessionToken(legacy, envKey)
          await keytar.deletePassword(SERVICE, LEGACY_ACCOUNT).catch(() => {})
          return legacy
        }
      } catch {
        // keychain unavailable — try the file fallbacks below.
      }
    }

    // Legacy safeStorage-encrypted global file.
    if (app?.isReady() && safeStorage.isEncryptionAvailable()) {
      try {
        const file = await legacyEncryptedFilePath()
        const encrypted = await fs.readFile(file)
        const token = safeStorage.decryptString(encrypted)
        if (token) {
          await this.setSessionToken(token, envKey)
          await removeTokenFileDurably(file).catch(() => {})
          return token
        }
      } catch {
        // no legacy encrypted file — fall through to plain-text.
      }
    }

    // Legacy plain-text global file.
    try {
      const file = await legacyFilePath()
      const raw = await fs.readFile(file, 'utf8')
      const data = JSON.parse(raw) as { token?: unknown }
      const token = typeof data.token === 'string' && data.token ? data.token : null
      if (token) {
        await this.setSessionToken(token, envKey)
        await removeTokenFileDurably(file).catch(() => {})
      }
      return token
    } catch {
      return null
    }
  }

  async setSessionToken(token: string, envKey: string): Promise<void> {
    assertEnvKey(envKey)
    const account = accountFor(envKey)
    const keytar = await loadKeytar()
    if (keytar) {
      try {
        await keytar.setPassword(SERVICE, account, token)
        return
      } catch {
        // Fall through to file storage when keychain writes fail.
      }
    }

    if (app?.isReady() && safeStorage.isEncryptionAvailable()) {
      const file = await encryptedFilePath(envKey)
      await writeTokenFileAtomic(file, safeStorage.encryptString(token))
      return
    }

    const file = await plainFilePath(envKey)
    await writeTokenFileAtomic(file, JSON.stringify({ token }))
  }

  async clearSessionToken(
    envKey: string,
    options: { legacyEnvKeys?: readonly string[] } = {}
  ): Promise<void> {
    assertEnvKey(envKey)
    const legacyEnvKeys = Array.from(
      new Set(
        (options.legacyEnvKeys ?? [])
          .map(key => String(key || '').trim())
          .filter(key => key && key !== envKey)
      )
    )
    for (const legacyEnvKey of legacyEnvKeys) assertEnvKey(legacyEnvKey)
    const scopedEnvKeys = [envKey, ...legacyEnvKeys]
    const keytar = await loadKeytar()
    if (keytar) {
      for (const scopedEnvKey of scopedEnvKeys) {
        await keytar.deletePassword(SERVICE, accountFor(scopedEnvKey)).catch(() => {})
      }
      // Best-effort cleanup of the legacy global slot so it can't be migrated
      // into another environment later.
      await keytar.deletePassword(SERVICE, LEGACY_ACCOUNT).catch(() => {})
    }
    // Always clean up file-based storage regardless of keychain result,
    // since prior versions may have written both stores.
    await Promise.all([
      ...scopedEnvKeys.flatMap(scopedEnvKey => [
        encryptedFilePath(scopedEnvKey)
          .then(file => fs.unlink(file))
          .catch(() => {}),
        plainFilePath(scopedEnvKey)
          .then(file => fs.unlink(file))
          .catch(() => {}),
      ]),
      legacyEncryptedFilePath()
        .then(file => fs.unlink(file))
        .catch(() => {}),
      legacyFilePath()
        .then(file => fs.unlink(file))
        .catch(() => {}),
    ])
  }
}
