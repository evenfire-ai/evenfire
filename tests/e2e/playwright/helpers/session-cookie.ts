/**
 * Admin session cookie helpers for API-only test requests.
 *
 * Since commit 0230b3166 ("fix: harden browser session cookies") control-api's
 * admin plane is cookie-only: POST /api/v1/admin/auth/login returns
 * 200 {me: {...}} and sets an httpOnly session cookie. The middleware
 * (control-api/src/middleware/controlUIAuth.ts) reads ONLY that cookie --
 * there is no Authorization/Bearer path anymore.
 */

/**
 * MUST stay in sync with CONTROL_UI_ADMIN_SESSION_COOKIE in
 * control-api/src/utils/auth/sessionCookies.ts (the source of truth).
 * Mirrored here because this standalone test package cannot import
 * control-api TypeScript sources cross-package.
 */
export const CONTROL_UI_ADMIN_SESSION_COOKIE = 'control_ui_admin_session'

/**
 * Cookie header for direct control-api requests.
 *
 * PLAYWRIGHT_ADMIN_TOKEN now carries the admin session COOKIE VALUE
 * (extracted from the login storageState by global-setup.ts), NOT a bearer
 * token. An empty value yields no Cookie header, so the request fails loudly
 * with 401 instead of sending a bogus cookie.
 */
export function adminSessionCookieHeader(): Record<string, string> {
  const value = process.env.PLAYWRIGHT_ADMIN_TOKEN ?? ''
  return value ? { Cookie: `${CONTROL_UI_ADMIN_SESSION_COOKIE}=${value}` } : {}
}
