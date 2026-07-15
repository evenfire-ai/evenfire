/**
 * Playwright fixture: authedPage
 *
 * Provides a browser page pre-authenticated as the admin user.
 *
 * Authentication strategy: globalSetup logs in once (cookie-only admin
 * session since commit 0230b3166) and saves the request context's
 * storageState -- including the httpOnly session cookie -- to
 * .auth/admin-session.json. This fixture creates a browser context from
 * that storageState, so the app boots already authenticated.
 * auth.spec.ts (which uses plain `page`) stays unaffected and still gets
 * a clean unauthenticated context.
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
import { CUI_DASHBOARD } from './selectors'

const CONTROL_UI_URL = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3000'
const AUTH_STATE_FILE = path.join(__dirname, '../.auth/admin-session.json')

type AuthFixtures = {
  authedPage: Page
}

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ browser }: { browser: Browser }, use) => {
    if (!fs.existsSync(AUTH_STATE_FILE)) {
      throw new Error(`Missing auth storageState file: ${AUTH_STATE_FILE}`)
    }

    const context = await browser.newContext({ storageState: AUTH_STATE_FILE })
    const page = await context.newPage()

    await page.goto(CONTROL_UI_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(CUI_DASHBOARD.HEADING, { timeout: 30_000 })

    await use(page)
    await context.close()
  },
})

export { expect } from '@playwright/test'
