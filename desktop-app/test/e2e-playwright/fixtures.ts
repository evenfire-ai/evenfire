import {
  type ElectronApplication,
  type Page,
  test as base,
  expect as baseExpect,
  _electron as electron,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { E2E_DESKTOP_PASSWORD, loginAs as apiLoginAs, seedDesktopPasswordLogin } from './workflowUi'

const E2E_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL || 'test@clerum.io'

type Fixtures = {
  electronApp: ElectronApplication
  appPage: Page
}

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', 'Evenfire', '-a', 'session-token'],
        {
          stdio: 'ignore',
        }
      )
    } catch {
      // no stored session — OK
    }

    const sessionFile = path.join(os.homedir(), '.evenfire', 'session-token.json')
    try {
      fs.unlinkSync(sessionFile)
    } catch {
      // not present — OK
    }
    const sessionEncFile = path.join(os.homedir(), '.clerum-desktop', 'session-token.enc')
    try {
      fs.unlinkSync(sessionEncFile)
    } catch {
      // not present — OK
    }

    const app = await electron.launch({
      args: [path.resolve(__dirname, '../../dist/main.js')],
      env: {
        ...process.env,
        EXTERNAL_REST_API_BASE_URL:
          process.env.EXTERNAL_REST_API_BASE_URL || 'http://localhost:8091',
        RPC_PROXY_BASE_URL: process.env.RPC_PROXY_BASE_URL || 'http://localhost:8094',
      },
    })
    await use(app)
    await app.close()
  },

  appPage: async ({ electronApp }, use) => {
    const login = await apiLoginAs(E2E_EMAIL)
    seedDesktopPasswordLogin(login.userId, E2E_EMAIL)

    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const dashboard = page.locator('[data-testid="user-display-name"]')
    const emailInput = page.locator('#email-input')
    const passwordInput = page.locator('#password-input')

    await Promise.race([
      emailInput.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
      dashboard.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    ])

    if (await emailInput.isVisible()) {
      await emailInput.fill(E2E_EMAIL)
      await passwordInput.fill(E2E_DESKTOP_PASSWORD)
      await page.click('button:has-text("Sign in")')
    }

    await dashboard.waitFor({ state: 'visible', timeout: 15_000 })
    const displayName = await dashboard.textContent()
    baseExpect(displayName, `Expected logged-in user to be ${E2E_EMAIL}`).toContain(
      E2E_EMAIL.split('@')[0]
    )

    await use(page)
  },
})

export { expect } from '@playwright/test'

export async function wipeChatsDir(): Promise<void> {
  const chatsDir = path.join(os.homedir(), '.clerum', 'chats')
  try {
    await (await import('node:fs/promises')).rm(chatsDir, { recursive: true, force: true })
  } catch {
    /* already absent — ok */
  }
}

export function clearStoredSession(): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', 'Evenfire', '-a', 'session-token'], {
      stdio: 'ignore',
    })
  } catch {
    /* no stored session — OK */
  }
  const sessionFile = path.join(os.homedir(), '.evenfire', 'session-token.json')
  try {
    fs.unlinkSync(sessionFile)
  } catch {
    /* not present — OK */
  }
}

export async function launchFreshElectron(): Promise<ElectronApplication> {
  clearStoredSession()
  return electron.launch({
    args: [path.resolve(__dirname, '../../dist/main.js')],
    env: {
      ...process.env,
      EXTERNAL_REST_API_BASE_URL: process.env.EXTERNAL_REST_API_BASE_URL || 'http://127.0.0.1:8091',
      RPC_PROXY_BASE_URL: process.env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094',
    },
  })
}

export async function loginAs(page: Page, email: string): Promise<void> {
  const login = await apiLoginAs(email)
  seedDesktopPasswordLogin(login.userId, email)

  const emailInput = page.locator('#email-input')
  const passwordInput = page.locator('#password-input')
  const dashboard = page.locator('[data-testid="user-display-name"]')

  await Promise.race([
    emailInput.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    dashboard.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
  ])

  if (await emailInput.isVisible()) {
    await emailInput.fill(email)
    await passwordInput.fill(E2E_DESKTOP_PASSWORD)
    await page.click('button:has-text("Sign in")')
  }

  await dashboard.waitFor({ state: 'visible', timeout: 15_000 })
  const displayName = await dashboard.textContent()
  if (!displayName?.includes(email.split('@')[0])) {
    throw new Error(`Expected logged-in user to be ${email}, saw ${displayName}`)
  }
}
