import { describe, expect, it } from 'vitest'
import { isSupportedMacInstallPath } from '../desktopUpdateInstaller.js'

describe('macOS update install location policy', () => {
  it('allows the standard system and per-user Evenfire app locations', () => {
    expect(isSupportedMacInstallPath('/Applications/Evenfire.app', '/Users/alice')).toBe(true)
    expect(
      isSupportedMacInstallPath('/Users/alice/Applications/Evenfire.app', '/Users/alice')
    ).toBe(true)
  })

  it('rejects renamed apps and arbitrary application directories', () => {
    expect(isSupportedMacInstallPath('/Applications/Other.app', '/Users/alice')).toBe(false)
    expect(isSupportedMacInstallPath('/Users/alice/Downloads/Evenfire.app', '/Users/alice')).toBe(
      false
    )
    expect(isSupportedMacInstallPath('/Applications/Nested/Evenfire.app', '/Users/alice')).toBe(
      false
    )
  })
})
