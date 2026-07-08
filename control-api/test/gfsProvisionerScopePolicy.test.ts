import { describe, expect, it } from 'vitest'
import { provisionerScopesAllowed } from '../src/gfs/provisionerScopePolicy.js'

describe('provisionerScopesAllowed', () => {
  it('allows a third-party host provisioner to mint read-only scope', () => {
    expect(provisionerScopesAllowed('3rd', ['gfs.read'])).toBe(true)
  })

  it('allows a third-party host provisioner to mint read + write for publish targets', () => {
    expect(provisionerScopesAllowed('3rd', ['gfs.read', 'gfs.write'])).toBe(true)
  })

  it('denies destructive scopes for third-party host provisioners', () => {
    expect(provisionerScopesAllowed('3rd', ['gfs.delete'])).toBe(false)
    expect(provisionerScopesAllowed('3rd', ['gfs.manage_acl'])).toBe(false)
    expect(provisionerScopesAllowed('3rd', ['gfs.share'])).toBe(false)
  })

  it('leaves first-party host provisioners governed by the existing subject-class gate', () => {
    expect(provisionerScopesAllowed('1st', ['gfs.read', 'gfs.write', 'gfs.delete'])).toBe(true)
  })
})
