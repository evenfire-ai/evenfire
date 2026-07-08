import { describe, expect, it, vi } from 'vitest'
import { DesktopSessionService } from './desktopSessionService.js'

describe('DesktopSessionService', () => {
  const service = new DesktopSessionService('test-secret-32-chars-minimum!!', 60_000, 'test_cookie')

  it('creates and validates a session cookie', () => {
    const cookie = service.createSession('chatllm', 'user-123')
    const session = service.validateSession(cookie)
    expect(session).not.toBeNull()
    expect(session!.hostRef).toBe('chatllm')
    expect(session!.userId).toBe('user-123')
  })

  it('rejects tampered cookie', () => {
    const cookie = service.createSession('chatllm', 'user-123')
    const tampered = cookie.slice(0, -4) + 'XXXX'
    expect(service.validateSession(tampered)).toBeNull()
  })

  it('rejects expired cookie', () => {
    vi.useFakeTimers()
    const cookie = service.createSession('chatllm', 'user-123')
    vi.advanceTimersByTime(61_000)
    expect(service.validateSession(cookie)).toBeNull()
    vi.useRealTimers()
  })

  it('rejects garbage input', () => {
    expect(service.validateSession('')).toBeNull()
    expect(service.validateSession('no-dot')).toBeNull()
    expect(service.validateSession('abc.def')).toBeNull()
  })
})
