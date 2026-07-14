/**
 * Playwright Global Setup
 *
 * Runs once before all tests:
 *   1. Verifies Control UI and Control API are reachable
 *   2. Performs admin login and stores token in PLAYWRIGHT_ADMIN_TOKEN env var
 *   3. Verifies Desktop App is built (for electron tests)
 *
 * Prerequisites:
 *   make minikube-pf-all   (port-forwards: :3000 :8090 :8091 :8094)
 *   cd desktop-app && npm run build  (for desktop tests)
 */
import { request } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const CONTROL_UI_URL = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3000'
const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:8090'
const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'

export default async function globalSetup(): Promise<void> {
  console.log('\n[playwright] Global setup starting...')

  // ── 1. Check Control UI reachability ───────────────────────────────────────
  const uiCtx = await request.newContext({ baseURL: CONTROL_UI_URL })
  try {
    const res = await uiCtx.get('/', { timeout: 8_000 })
    if (!res.ok() && res.status() !== 200) {
      throw new Error(`Control UI returned HTTP ${res.status()}`)
    }
    console.log(`[playwright] ✓ Control UI reachable at ${CONTROL_UI_URL}`)
  } catch (err) {
    throw new Error(
      `Control UI not reachable at ${CONTROL_UI_URL}.\n` +
        `Run: make minikube-pf-all\n` +
        `Error: ${err}`
    )
  } finally {
    await uiCtx.dispose()
  }

  // ── 2. Admin login → store token ──────────────────────────────────────────
  const apiCtx = await request.newContext({ baseURL: CONTROL_API_URL })
  try {
    const res = await apiCtx.post('/api/v1/admin/auth/login', {
      data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
      timeout: 10_000,
    })

    if (!res.ok()) {
      const body = await res.text()
      throw new Error(`Admin login failed (HTTP ${res.status()}): ${body}`)
    }

    const body = (await res.json()) as { token?: string }
    if (!body.token) {
      throw new Error('Admin login response missing token field')
    }

    // Store for use in API-only test fixtures (crd-config-validation)
    process.env.PLAYWRIGHT_ADMIN_TOKEN = body.token
    console.log(`[playwright] ✓ Admin login verified (token acquired)`)

    // ── 2b. Save authenticated token for the authedPage fixture ────────────
    // Persist the raw token instead of a full storageState snapshot. The
    // fixture injects localStorage via addInitScript before the app loads,
    // which is more stable than relying on storageState/localStorage capture.
    const authDir = path.join(__dirname, '.auth')
    fs.mkdirSync(authDir, { recursive: true })
    const authFile = path.join(authDir, 'admin-token.json')
    fs.writeFileSync(authFile, JSON.stringify({ token: body.token }, null, 2), 'utf8')
    console.log(`[playwright] ✓ Admin token saved to .auth/admin-token.json`)
  } catch (err) {
    throw new Error(
      `Admin login failed at ${CONTROL_API_URL}.\n` +
        `Credentials: ${ADMIN_USERNAME} / (password from TEST_ADMIN_PASSWORD)\n` +
        `Error: ${err}`
    )
  } finally {
    await apiCtx.dispose()
  }

  // ── 3. Check Desktop App build exists (non-fatal warning) ─────────────────
  const desktopMainJs = path.resolve(__dirname, '../../../desktop-app/dist/main.js')
  if (!fs.existsSync(desktopMainJs)) {
    console.warn(
      `[playwright] ⚠  Desktop App not built — desktop tests will be skipped.\n` +
        `  To build: cd desktop-app && npm run build`
    )
    process.env.PLAYWRIGHT_DESKTOP_BUILT = 'false'
  } else {
    process.env.PLAYWRIGHT_DESKTOP_BUILT = 'true'
    console.log(`[playwright] ✓ Desktop App build found at dist/main.js`)
  }

  console.log('[playwright] Global setup complete.\n')
}
