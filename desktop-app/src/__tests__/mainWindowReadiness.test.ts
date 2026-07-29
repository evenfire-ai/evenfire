import { describe, expect, it } from 'vitest'
import { shouldResetRendererReadinessForNavigation } from '../mainWindowReadiness.js'

describe('main window renderer readiness', () => {
  it('resets only for main-frame cross-document navigations', () => {
    expect(
      shouldResetRendererReadinessForNavigation({
        isMainFrame: true,
        isSameDocument: false,
      })
    ).toBe(true)
    expect(
      shouldResetRendererReadinessForNavigation({
        isMainFrame: false,
        isSameDocument: false,
      })
    ).toBe(false)
    expect(
      shouldResetRendererReadinessForNavigation({
        isMainFrame: true,
        isSameDocument: true,
      })
    ).toBe(false)
  })
})
