import { type Page, expect } from '@playwright/test'

export const LOGOUT_FENCE_KEY = 'profile_logout_unconfirmed'
export const RECOVERY_MEMBER = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'recovery-member@example.invalid',
  password: 'Synthetic-Recovery-Password-123',
  replacementPassword: 'Synthetic-Replacement-Password-123',
}
export const LOGOUT_MEMBER = {
  id: '44444444-4444-4444-8444-444444444444',
  email: 'logout-member@example.invalid',
  password: 'Synthetic-Logout-Password-123',
}
export const ONBOARDING_MEMBER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'onboarding-member@example.invalid',
  password: 'Synthetic-Onboarding-Password-123',
  teamId: '22222222-2222-4222-8222-222222222222',
  teamName: 'Synthetic Member Team',
}

type ControlApiMetrics = {
  meRequests: Array<{ userId: string }>
  passwordTokenRequests: Array<{ token: string; invitationId: string }>
  loginSuccesses: Array<{ userId: string }>
  passwordUpdates: Array<{ userId: string; invitationId: string | null }>
  logoutRequests: Array<{ hasToken: boolean }>
  unauthorizedMeRequests: Array<{ userId: string }>
  invitations: Array<{
    id: string
    token: string
    purpose: string
    status: string
    acceptedUserId: string | null
    passwordPending: boolean
  }>
}

export async function readControlApiMetrics(page: Page): Promise<ControlApiMetrics> {
  const port = process.env.PROFILE_UI_RECOVERY_METRICS_PORT || '31874'
  const response = await page.request.get(`http://127.0.0.1:${port}/__test/metrics`)
  expect(response.status()).toBe(200)
  return (await response.json()) as ControlApiMetrics
}

export async function expectBrowserRoute(
  page: Page,
  expected: { pathname: string; query?: Record<string, string> }
) {
  const current = new URL(page.url())
  expect(current.pathname).toBe(expected.pathname)
  expect(Object.fromEntries(current.searchParams.entries())).toEqual(expected.query ?? {})
}

export async function sessionCookieValue(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies()
  const cookie = cookies.find(candidate => candidate.name === 'profile_session')
  return cookie ? cookie.value : null
}

export async function signInThroughUi(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  const loginResponse = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/auth/password-login') &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  expect((await loginResponse).status()).toBe(200)
}

// Read-only view of the logout fence. The lane never seeds it: J2 produces it
// through a real logout whose revocation request is aborted.
export async function readLogoutFence(page: Page): Promise<string | null> {
  return page.evaluate(key => window.localStorage.getItem(key), LOGOUT_FENCE_KEY)
}

export async function fetchMeWithCookie(page: Page, cookieValue: string) {
  const response = await page.request.get('/external-rest-api/api/v1/me', {
    headers: { cookie: `profile_session=${cookieValue}` },
  })
  const text = await response.text()
  return {
    status: response.status(),
    body: text ? (JSON.parse(text) as unknown) : null,
  }
}
