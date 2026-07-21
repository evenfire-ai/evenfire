import { app, safeStorage } from 'electron'
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
 * `assertSafeSegment` guard in chatStore/chatStoreBinding. Today all callers
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

export class TokenStore {
  /**
   * Read the session token for `envKey`. Falls back keytar → safeStorage file,
   * then does a one-time best-effort migration of the pre-per-env GLOBAL slot
   * into this environment's slot. Migrating the legacy token is safe: it was
   * issued for whatever environment was last active (which is the environment
   * being restored at startup), and an env mismatch simply fails `getMe` and
   * drops the user back to login — never a cross-env leak, since after the
   * migration the legacy slot is deleted.
   */
  async getSessionToken(envKey: string): Promise<string | null> {
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

    return this.migrateLegacyGlobalToken(envKey, keytar)
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
          await fs.unlink(file).catch(() => {})
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
        await this.setSessionToken(token, envKey).catch(() => {})
        await fs.unlink(file).catch(() => {})
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
      await fs.writeFile(file, safeStorage.encryptString(token), { mode: 0o600 })
      return
    }

    const file = await plainFilePath(envKey)
    await fs.writeFile(file, JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600 })
  }

  async clearSessionToken(envKey: string): Promise<void> {
    assertEnvKey(envKey)
    const account = accountFor(envKey)
    const keytar = await loadKeytar()
    if (keytar) {
      try {
        await keytar.deletePassword(SERVICE, account)
      } catch {
        // Continue cleaning up file-based storage even if keychain fails.
      }
      // Best-effort cleanup of the legacy global slot so it can't be migrated
      // into another environment later.
      await keytar.deletePassword(SERVICE, LEGACY_ACCOUNT).catch(() => {})
    }
    // Always clean up file-based storage regardless of keychain result,
    // since prior versions may have written both stores.
    await Promise.all([
      encryptedFilePath(envKey)
        .then(file => fs.unlink(file))
        .catch(() => {}),
      plainFilePath(envKey)
        .then(file => fs.unlink(file))
        .catch(() => {}),
      legacyEncryptedFilePath()
        .then(file => fs.unlink(file))
        .catch(() => {}),
      legacyFilePath()
        .then(file => fs.unlink(file))
        .catch(() => {}),
    ])
  }
}
