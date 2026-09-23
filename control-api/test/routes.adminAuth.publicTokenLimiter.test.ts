import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'

/**
 * The public control-admin token routes (password reset, invitation, email
 * confirmation) are called before login. Each route has two buckets:
 *
 * - IP + submitted value (email, login or token prefix) at
 *   `adminPublicTokenRlPerMin`: one person retrying the same value.
 * - IP alone at `adminPublicTokenIpRlPerMin`: the ceiling on rotating values
 *   from one source. Many legitimate admins can share one public IP (a
 *   corporate VPN egress, an office NAT), so this ceiling is several times the
 *   per-value one, and a request the per-value bucket refuses is never charged
 *   to the IP bucket: one person's retry loop cannot use up the office's budget.
 *
 * The counter is an in-memory stand-in for the Postgres bucket; the real
 * rateLimitMiddleware runs on top of it.
 */

const counts = vi.hoisted(() => new Map<string, number>())
const limiterCalls = vi.hoisted(() => [] as Array<{ key: string; max: number }>)

vi.mock('../src/services/rateLimiterService.js', () => ({
  RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS: 2,
  checkAndIncrement: vi.fn(async (key: string, max: number) => {
    limiterCalls.push({ key, max })
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return {
      allowed: count <= max,
      remaining: Math.max(0, max - count),
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count,
      backendAvailable: true,
    }
  }),
}))

const registration = vi.hoisted(() => ({
  registerAndSendControlAdminPasswordReset: vi.fn(),
  validateControlAdminEmailConfirmationToken: vi.fn(),
  validateControlAdminInvitationToken: vi.fn(),
  validateControlAdminPasswordResetToken: vi.fn(),
}))
vi.mock('../src/services/controlAdminInvitationRegistrationService.js', () => registration)
vi.mock('../src/services/directory/index.js', () => ({
  acceptInvitationById: vi.fn(),
  getPendingMemberInvitationForEmail: vi.fn(),
  provisionAdminDesktopWorkspace: vi.fn(),
  setInvitationPasswordForUser: vi.fn(),
}))
vi.mock('../src/services/adminAuthService.js', () => ({
  completeControlAdminEmailChangeRequest: vi.fn(),
  completeControlAdminInvitation: vi.fn(),
  completeControlAdminPasswordResetRequest: vi.fn(),
  createControlAdminPasswordResetRequest: vi.fn(),
  findAdminById: vi.fn(),
  findAdminByLogin: vi.fn(),
  getPendingControlAdminEmailChangeRequest: vi.fn(),
  getPendingControlAdminInvitation: vi.fn(),
  getPendingControlAdminPasswordResetRequest: vi.fn(),
  isValidAdminEmail: vi.fn(() => true),
  isValidAdminUsername: vi.fn(() => true),
  markControlAdminInvitationOpened: vi.fn(),
  registerAdminFailedLogin: vi.fn(),
  registerAdminSuccessfulLogin: vi.fn(),
  revokeAdminTokenJti: vi.fn(),
  revokeControlAdminPasswordResetRequest: vi.fn(),
  setupInitialAdminCredentials: vi.fn(),
}))
vi.mock('../src/services/initialAdminSetupService.js', () => ({
  setupInitialAdminWithDesktopWorkspace: vi.fn(),
}))
vi.mock('../src/utils/auth/adminAuthToken.js', () => ({ signAdminToken: vi.fn() }))
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (_req: unknown, _res: unknown, next: () => void) => next(),
}))

const { createAdminAuthRouter } = await import('../src/routes/admin/auth.js')

const PER_VALUE = 3
const PER_IP = 10
const VALIDATE = '/admin/auth/password-reset/validate'

const PUBLIC_TOKEN_ROUTES = [
  ['password_reset_request', '/admin/auth/password-reset/request'],
  ['password_reset_validate', '/admin/auth/password-reset/validate'],
  ['password_reset_complete', '/admin/auth/password-reset/complete'],
  ['invitation_validate', '/admin/auth/control-admin-invitations/validate'],
  ['invitation_complete', '/admin/auth/control-admin-invitations/complete'],
  ['email_confirmation_validate', '/admin/auth/control-admin-email-confirmations/validate'],
  ['email_confirmation_complete', '/admin/auth/control-admin-email-confirmations/complete'],
] as const

function buildApp() {
  const warn = vi.fn()
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { log: { warn: typeof warn } }).log = { warn }
    next()
  })
  app.use(createAdminAuthRouter())
  return { app, warn }
}

function validateFrom(app: express.Express, ip: string, email: string) {
  return request(app)
    .post(VALIDATE)
    .set('x-forwarded-for', ip)
    .send({ token: `token-${email}`, email })
}

function deniedBucketTypes(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls
    .map(([fields]) => fields as { event?: string; bucketType?: string })
    .filter(fields => fields.event === 'rate_limit_denied')
    .map(fields => fields.bucketType ?? '')
}

describe('public control-admin token limiter', () => {
  beforeEach(() => {
    counts.clear()
    limiterCalls.length = 0
    Object.values(registration).forEach(fn => fn.mockReset())
    // The handler's own outcome is irrelevant here; reaching it is the witness.
    registration.validateControlAdminPasswordResetToken.mockRejectedValue(new Error('invalid'))
    config.adminPublicTokenRlPerMin = PER_VALUE
    config.adminPublicTokenIpRlPerMin = PER_IP
  })

  it('lets every admin behind one shared public IP through, each with their own value', async () => {
    const { app, warn } = buildApp()
    const statuses: number[] = []
    for (let user = 0; user < PER_IP; user += 1) {
      statuses.push((await validateFrom(app, '203.0.113.7', `admin${user}@corp.test`)).status)
    }

    // More admins than the per-value limit, one request each, all from one IP.
    expect(statuses).toHaveLength(PER_IP)
    expect(statuses.every(status => status === 400)).toBe(true)
    expect(registration.validateControlAdminPasswordResetToken).toHaveBeenCalledTimes(PER_IP)
    expect(deniedBucketTypes(warn)).toEqual([])
  })

  it('refuses value rotation from one IP past the IP ceiling, and names the IP bucket', async () => {
    const { app, warn } = buildApp()
    for (let n = 0; n < PER_IP; n += 1) {
      expect((await validateFrom(app, '203.0.113.7', `guess${n}@corp.test`)).status).toBe(400)
    }

    const refused = await validateFrom(app, '203.0.113.7', `guess${PER_IP}@corp.test`)
    expect(refused.status).toBe(429)
    expect(refused.headers['x-ratelimit-limit']).toBe(String(PER_IP))
    expect(deniedBucketTypes(warn)).toEqual(['control_admin_public_ip_password_reset_validate'])
    expect(registration.validateControlAdminPasswordResetToken).toHaveBeenCalledTimes(PER_IP)

    // Another source is unaffected.
    expect((await validateFrom(app, '198.51.100.9', 'someone@else.test')).status).toBe(400)
    expect(registration.validateControlAdminPasswordResetToken).toHaveBeenCalledTimes(PER_IP + 1)
  })

  it('does not charge the IP bucket for a request the per-value bucket refused', async () => {
    const { app, warn } = buildApp()
    const retries: number[] = []
    for (let attempt = 0; attempt < PER_VALUE + 5; attempt += 1) {
      retries.push((await validateFrom(app, '203.0.113.7', 'looping@corp.test')).status)
    }
    expect(retries.filter(status => status === 400)).toHaveLength(PER_VALUE)
    expect(retries.filter(status => status === 429)).toHaveLength(5)
    expect(new Set(deniedBucketTypes(warn))).toEqual(
      new Set(['control_admin_public_password_reset_validate'])
    )

    // The IP bucket saw only the PER_VALUE admitted requests, so the other
    // admins on that IP still have PER_IP - PER_VALUE requests.
    const others: number[] = []
    for (let user = 0; user < PER_IP - PER_VALUE; user += 1) {
      others.push((await validateFrom(app, '203.0.113.7', `colleague${user}@corp.test`)).status)
    }
    expect(others).toHaveLength(PER_IP - PER_VALUE)
    expect(others.every(status => status === 400)).toBe(true)
    expect((await validateFrom(app, '203.0.113.7', 'one-more@corp.test')).status).toBe(429)
  })

  it('groups IPv6 sources by /56, so rotating addresses inside one allocation does not evade the ceiling', async () => {
    const { app } = buildApp()
    for (let n = 0; n < PER_IP; n += 1) {
      // Every address differs, and all of them sit in 2001:db8:0:0000::/56.
      const status = (
        await validateFrom(app, `2001:db8:0:${n.toString(16)}::${n + 1}`, `v6-${n}@corp.test`)
      ).status
      expect(status).toBe(400)
    }
    expect((await validateFrom(app, '2001:db8:0:ff::1', 'v6-last@corp.test')).status).toBe(429)
    // The next /56 is another source.
    expect((await validateFrom(app, '2001:db8:0:100::1', 'v6-next@corp.test')).status).toBe(400)
  })

  it.each(PUBLIC_TOKEN_ROUTES)(
    '%s charges the per-value bucket, then the per-IP bucket, at the configured limits',
    async (routeName, path) => {
      const { app } = buildApp()
      await request(app)
        .post(path)
        .set('x-forwarded-for', '203.0.113.7')
        .send({ token: 'tok', email: 'someone@corp.test', password: 'x'.repeat(12) })

      expect(limiterCalls).toEqual([
        {
          key: `control-admin-public:${routeName}:203.0.113.7:someone@corp.test`,
          max: PER_VALUE,
        },
        { key: `control-admin-public-ip:${routeName}:203.0.113.7`, max: PER_IP },
      ])
    }
  )
})
