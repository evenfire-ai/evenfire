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

  it('limits first-party HCC provisioners to read and write', () => {
    expect(provisionerScopesAllowed('1st', ['gfs.read', 'gfs.write'])).toBe(true)
    expect(provisionerScopesAllowed('1st', ['gfs.delete'])).toBe(false)
    expect(provisionerScopesAllowed('1st', ['gfs.manage_acl'])).toBe(false)
    expect(provisionerScopesAllowed('1st', ['gfs.share'])).toBe(false)
  })
})
