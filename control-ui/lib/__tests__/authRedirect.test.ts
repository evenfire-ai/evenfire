import { describe, expect, it } from 'vitest'
import { buildControlUiLoginPath, sanitizeControlUiReturnPath } from '../authRedirect'

describe('control-ui auth redirects', () => {
  it('builds a login route with a safe same-origin return path', () => {
    expect(buildControlUiLoginPath('/hosts/chatllm/env#runtime')).toBe(
      '/?next=%2Fhosts%2Fchatllm%2Fenv%23runtime'
    )
  })

  it('ignores external and protocol-relative return paths', () => {
    expect(sanitizeControlUiReturnPath('https://example.com/hosts')).toBeNull()
    expect(sanitizeControlUiReturnPath('//example.com/hosts')).toBeNull()
  })

  it('rejects paths that normalize to another origin', () => {
    expect(sanitizeControlUiReturnPath('/\\evil.com')).toBeNull()
  })

  it('normalizes same-origin path traversal', () => {
    expect(sanitizeControlUiReturnPath('/../../etc/passwd')).toBe('/etc/passwd')
  })

  it('rejects relative return paths', () => {
    expect(sanitizeControlUiReturnPath('../../etc/passwd')).toBeNull()
  })

  it('does not add a next parameter for the login route itself', () => {
    expect(buildControlUiLoginPath('/')).toBe('/')
  })
})
