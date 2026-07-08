import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '../config.js'

interface DesktopSession {
  hostRef: string
  userId: string
  createdAt: number
  expiresAt: number
}

/**
 * Creates and validates desktop session cookies.
 * Format: base64(JSON) + "." + hmac_signature
 */
export class DesktopSessionService {
  private readonly secret: string
  private readonly maxAgeMs: number
  private readonly cookieName: string

  constructor(
    secret: string = config.desktopCookieSecret,
    maxAgeMs: number = config.desktopCookieMaxAgeMs,
    cookieName: string = config.desktopCookieName
  ) {
    this.secret = secret
    this.maxAgeMs = maxAgeMs
    this.cookieName = cookieName
  }

  createSession(hostRef: string, userId: string): string {
    const now = Date.now()
    const session: DesktopSession = {
      hostRef,
      userId,
      createdAt: now,
      expiresAt: now + this.maxAgeMs,
    }
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
    const sig = this.sign(payload)
    return `${payload}.${sig}`
  }

  validateSession(cookieValue: string): DesktopSession | null {
    const [payload, sig] = cookieValue.split('.')
    if (!payload || !sig) return null

    const expectedSig = this.sign(payload)
    const sigBuf = Buffer.from(sig, 'base64url')
    const expectedBuf = Buffer.from(expectedSig, 'base64url')
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null

    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as DesktopSession
      if (Date.now() > session.expiresAt) return null
      return session
    } catch {
      return null
    }
  }

  getCookieName(): string {
    return this.cookieName
  }

  getMaxAgeMs(): number {
    return this.maxAgeMs
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }
}
