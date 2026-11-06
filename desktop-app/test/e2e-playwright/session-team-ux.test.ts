// What Desktop shows when a session has no team, during an outage, and when a session ends.
// Needs a seeded branch profile. It stops control-api, so it refuses any other context.
import { type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isLocalPortForwardContext } from './global-setup'
import { openResourcesNavItem } from './navigationHelpers'
import {
  E2E_DESKTOP_PASSWORD,
  E2E_EMAIL,
  EXT_API,
  K8S_CONTEXT,
  awaitPasswordPace,
  launchAndLogin,
  seedPasswordForEmail,
} from './workflowUi'

const SECOND_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL_2 ?? 'test2@clerum.io'
const NO_TEAM_NOTICE = /no active team|select a team|workspace team/i
const SECTIONS: Array<[testId: string, heading: string]> = [
  ['nav-files', 'Files'],
  ['nav-agents', 'Agents'],
  ['nav-workflows', 'Plugins'],
  ['nav-mcp-servers', 'Connectors'],
]

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  if (!isLocalPortForwardContext(K8S_CONTEXT)) {
    throw new Error(`Refusing to stop control-api on context ${K8S_CONTEXT}`)
  }
  if (E2E_EMAIL === SECOND_EMAIL) throw new Error('The two E2E users must differ')
})

function kubectl(args: string[], input?: string): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, '-n', 'control-plane', ...args], {
    encoding: 'utf-8',
    timeout: 240_000,
    input,
  }).trim()
}

function runSql(statement: string): string {
  return kubectl(
    [
      'exec',
      '-i',
      'deployment/control-postgres',
      '--',
      'sh',
      '-c',
      'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${POSTGRES_DB:-postgres}" -f -',
    ],
    `${statement};\n`
  )
}

function setMembership(email: string, member: boolean): void {
  const address = email.replace(/'/g, "''")
  if (!member) {
    runSql(`DELETE FROM team_members WHERE user_id=(SELECT id FROM users WHERE email='${address}')`)
    return
  }
  runSql(
    `INSERT INTO team_members(team_id,user_id,role,status)
     SELECT t.id,u.id,'admin','active' FROM users u JOIN teams t ON t.name=u.name||' team'
      WHERE u.email='${address}'
        AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.user_id=u.id AND m.team_id=t.id)`
  )
  const count = runSql(
    `SELECT count(*) FROM team_members m JOIN users u ON u.id=m.user_id WHERE u.email='${address}'`
  )
  expect(Number(count), `membership of ${email}`).toBeGreaterThan(0)
}

async function sessionTeamId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const state = await (window as any).clerum.auth.getSessionState()
    return state?.me?.teamId ?? null
  })
}

async function workflowsList(page: Page): Promise<{ ok: boolean; message: string }> {
  return page.evaluate(async () => {
    try {
      await (window as any).clerum.workflows.list()
      return { ok: true, message: '' }
    } catch (error) {
      return { ok: false, message: String((error as Error).message).slice(0, 200) }
    }
  })
}

/** Walks every section and asserts that none shows a notice about the session team. */
async function expectNoTeamNoticeInSections(page: Page): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Agent message composer' })
  await expect(composer, 'witness: the chat rendered').toBeVisible()
  await expect(page.getByText(NO_TEAM_NOTICE)).toHaveCount(0)
  for (const [section, heading] of SECTIONS) {
    await openResourcesNavItem(page, section)
    await expect(
      page.getByRole('heading', { name: heading, exact: true }),
      `witness: ${section} opened`
    ).toBeVisible()
    await expect(page.getByText(NO_TEAM_NOTICE), `${section} shows no team notice`).toHaveCount(0)
  }
}

test('a user without a team enters and sees no team notice anywhere', async () => {
  setMembership(SECOND_EMAIL, false)
  try {
    const { app, page } = await launchAndLogin(SECOND_EMAIL)
    try {
      expect(await sessionTeamId(page), 'witness: the session really has no team').toBeNull()
      expect((await workflowsList(page)).ok, 'the session works without a team').toBe(true)
      await expectNoTeamNoticeInSections(page)
    } finally {
      await app.close()
    }
  } finally {
    setMembership(SECOND_EMAIL, true)
  }
})

test('a team member enters and sees no team notice anywhere', async () => {
  setMembership(SECOND_EMAIL, true)
  const { app, page } = await launchAndLogin(SECOND_EMAIL)
  try {
    expect(await sessionTeamId(page), 'witness: the session has its team').toBeTruthy()
    await expectNoTeamNoticeInSections(page)
  } finally {
    await app.close()
  }
})

async function apiLogin(): Promise<string> {
  await awaitPasswordPace()
  const response = await fetch(`${EXT_API}/api/v1/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_DESKTOP_PASSWORD }),
  })
  expect(response.status, 'API login').toBe(200)
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string' || !body.token) throw new Error('Login answered no token')
  return body.token
}

async function edgeCall(
  method: string,
  route: string,
  token: string,
  body?: unknown
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${EXT_API}/api/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

/**
 * Spends all of this source's attempts of the current clock minute, with an identity that
 * does not exist. An early 429 only reflects the 7.5 s global pace, which ends soon, so the
 * loop goes past the limit of five. It starts early in the minute so the limit still holds
 * when Desktop signs in.
 */
async function spendSourceAttempts(): Promise<void> {
  const secondOfMinute = new Date().getSeconds()
  if (secondOfMinute > 30) {
    await new Promise(resolve => setTimeout(resolve, (61 - secondOfMinute) * 1_000))
  }
  let lastStatus = 0
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${EXT_API}/api/v1/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `no-such-user-${randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-password',
      }),
    })
    lastStatus = response.status
    expect([401, 429], 'an unknown identity is rejected or limited').toContain(lastStatus)
  }
  expect(lastStatus, 'the sixth attempt is over the source limit').toBe(429)
}

test('an outage keeps the Desktop session, and a real session end returns to sign-in', async () => {
  setMembership(E2E_EMAIL, true)
  const { app, page } = await launchAndLogin(E2E_EMAIL)
  try {
    const signInForm = page.locator('#email-input')
    const teamId = await sessionTeamId(page)
    expect(teamId, 'witness: the session has its team').toBeTruthy()
    expect((await workflowsList(page)).ok, 'witness: the call works before the outage').toBe(true)

    kubectl(['scale', 'deployment/control-api', '--replicas=0'])
    try {
      await expect
        .poll(() => kubectl(['get', 'pods', '-l', 'app=control-api', '-o', 'name']), {
          timeout: 120_000,
          intervals: [3_000],
        })
        .toBe('')
      expect((await workflowsList(page)).ok, 'witness: the call fails during the outage').toBe(
        false
      )
      const secondAttempt = await workflowsList(page)
      expect(secondAttempt.ok, 'witness: the outage still holds').toBe(false)
      await expect(signInForm, 'an outage does not sign the user out').toBeHidden()
      await expect(page.getByText('Your session ended')).toHaveCount(0)
    } finally {
      kubectl(['scale', 'deployment/control-api', '--replicas=1'])
      kubectl(['rollout', 'status', 'deployment/control-api', '--timeout=180s'])
    }
    await expect
      .poll(async () => (await workflowsList(page)).ok, { timeout: 60_000, intervals: [3_000] })
      .toBe(true)
    await expect(signInForm, 'the session survives recovery').toBeHidden()
    await expect(page.getByText(NO_TEAM_NOTICE)).toHaveCount(0)

    const ended = await apiLogin()
    const liveTeam = await edgeCall('GET', '/team', ended)
    expect(liveTeam.status, 'witness: the team call is live').toBe(200)
    expect(JSON.parse(liveTeam.text).team, 'witness: GET /team returns the team').toBeTruthy()

    const changer = await apiLogin()
    const change = await edgeCall('PUT', '/me/password', changer, {
      currentPassword: E2E_DESKTOP_PASSWORD,
      newPassword: `Rotated-${randomBytes(12).toString('hex')}`,
    })
    expect(change.status, 'the password change commits').toBe(200)

    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/team'],
      ['PUT', '/team/name', { name: 'must-not-apply' }],
      ['PATCH', '/team/members/no-such-user/role', { role: 'member' }],
      ['DELETE', '/team/members/no-such-user'],
      ['POST', '/me/switch-team', { teamId }],
    ]
    for (const [method, route, body] of routes) {
      const result = await edgeCall(method, route, ended, body)
      expect(result.status, `${method} ${route} with an ended session`).toBe(401)
    }

    const switched = await page.evaluate(async id => {
      try {
        await (window as any).clerum.team.switch(id)
        return 'ok'
      } catch (error) {
        return String((error as Error).message).slice(0, 200)
      }
    }, teamId)
    expect(switched, 'an ended session cannot switch team').not.toBe('ok')
    expect(switched.toLowerCase()).not.toContain('not a member')

    await workflowsList(page)
    await expect(signInForm, 'Desktop returns to sign-in').toBeVisible()
    expect(await sessionTeamId(page), 'no team remains in the session').toBeNull()

    // A rate-limited sign-in explains the wait and does not blame the password.
    await spendSourceAttempts()
    await page.locator('#email-input').fill(E2E_EMAIL)
    await page.locator('#password-input').fill(E2E_DESKTOP_PASSWORD)
    await page.getByRole('button', { name: /^Sign in$/ }).click()
    const notice = page.getByRole('alert').filter({ hasText: 'too many sign-in attempts' })
    await expect(notice, 'the rate-limit notice appears').toBeVisible({ timeout: 20_000 })
    await expect(notice).toContainText('Your password was not checked.')
    await expect(notice).toContainText(/try again in about \d+ (second|seconds|minutes)/)
    await expect(page.getByText('Check your email and password')).toHaveCount(0)
    await expect(signInForm, 'the user stays on the sign-in screen').toBeVisible()
  } finally {
    await app.close()
    seedPasswordForEmail(E2E_EMAIL)
  }
})
