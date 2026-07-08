import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SERVICE = 'Evenfire'
const ACCOUNT = 'session-token'

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

async function encryptedFilePath(): Promise<string> {
  return path.join(await resolvedStorageBase(), 'session-token.enc')
}

async function legacyFilePath(): Promise<string> {
  return path.join(await resolvedStorageBase(), 'session-token.json')
}

export class TokenStore {
  async getSessionToken(): Promise<string | null> {
    const keytar = await loadKeytar()
    if (keytar) {
      try {
        return await keytar.getPassword(SERVICE, ACCOUNT)
      } catch {
        // Packaged builds can fail keychain access depending on host policies.
        // Fall back to the local encrypted store so auth flow can continue.
      }
    }

    if (app?.isReady() && safeStorage.isEncryptionAvailable()) {
      try {
        const file = await encryptedFilePath()
        const encrypted = await fs.readFile(file)
        return safeStorage.decryptString(encrypted)
      } catch {
        // File may not exist yet.
      }
    }

    // Legacy plain-text fallback — migrate to a better store when one is available.
    try {
      const file = await legacyFilePath()
      const raw = await fs.readFile(file, 'utf8')
      const data = JSON.parse(raw) as { token?: unknown }
      const token = typeof data.token === 'string' && data.token ? data.token : null
      if (token) {
        const betterStoreAvailable =
          !!keytar || (app?.isReady() && safeStorage.isEncryptionAvailable())
        if (betterStoreAvailable) {
          await this.setSessionToken(token)
            .then(() => fs.unlink(file))
            .catch(() => {})
        }
      }
      return token
    } catch {
      return null
    }
  }

  async setSessionToken(token: string): Promise<void> {
    const keytar = await loadKeytar()
    if (keytar) {
      try {
        await keytar.setPassword(SERVICE, ACCOUNT, token)
        return
      } catch {
        // Fall through to file storage when keychain writes fail.
      }
    }

    if (app?.isReady() && safeStorage.isEncryptionAvailable()) {
      const file = await encryptedFilePath()
      await fs.writeFile(file, safeStorage.encryptString(token), { mode: 0o600 })
      return
    }

    const file = await legacyFilePath()
    await fs.writeFile(file, JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600 })
  }

  async clearSessionToken(): Promise<void> {
    const keytar = await loadKeytar()
    if (keytar) {
      try {
        await keytar.deletePassword(SERVICE, ACCOUNT)
      } catch {
        // Continue cleaning up file-based storage even if keychain fails.
      }
    }
    // Always clean up file-based storage regardless of keychain result,
    // since prior versions may have written both stores.
    await Promise.all([
      encryptedFilePath()
        .then(file => fs.unlink(file))
        .catch(() => {}),
      legacyFilePath()
        .then(file => fs.unlink(file))
        .catch(() => {}),
    ])
  }
}
