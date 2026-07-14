/**
 * Playwright fixture: authedPage
 *
 * Provides a browser page pre-authenticated as the admin user.
 *
 * Authentication strategy: globalSetup logs in once and saves the raw
 * admin token to .auth/admin-token.json. This fixture injects that token
 * into localStorage via addInitScript before the page loads, so the app
 * boots already authenticated. auth.spec.ts (which uses plain `page`)
 * stays unaffected and still gets a clean unauthenticated context.
 *
 * Usage:
 *   import { test } from "../helpers/auth-fixture";
 *
 *   test("some test", async ({ authedPage }) => {
 *     // Dashboard is already visible
 *   });
 */
import { Browser, Page, test as base } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const CONTROL_UI_URL = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3000'
const AUTH_TOKEN_FILE = path.join(__dirname, '../.auth/admin-token.json')

type AuthFixtures = {
  authedPage: Page
}

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ browser }: { browser: Browser }, use) => {
    if (!fs.existsSync(AUTH_TOKEN_FILE)) {
      throw new Error(`Missing auth token file: ${AUTH_TOKEN_FILE}`)
    }

    const raw = JSON.parse(fs.readFileSync(AUTH_TOKEN_FILE, 'utf8')) as { token?: string }
    if (!raw.token) {
      throw new Error(`Auth token file does not contain a token: ${AUTH_TOKEN_FILE}`)
    }

    const context = await browser.newContext()
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        localStorage.setItem(key, value)
      },
      { key: 'controlUiAdminToken', value: raw.token }
    )
    const page = await context.newPage()

    await page.goto(CONTROL_UI_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1.cu-sidebar__title', { timeout: 30_000 })

    await use(page)
    await context.close()
  },
})

export { expect } from '@playwright/test'
