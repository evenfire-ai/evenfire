import { describe, expect, it } from 'vitest'
import { mainWindowRoundedCorners } from '../mainWindowChrome.js'

describe('mainWindowRoundedCorners', () => {
  it('opts Linux out of rounded corners for the square custom chrome', () => {
    expect(mainWindowRoundedCorners('linux')).toBe(false)
  })

  it('keeps the native rounded default on macOS and Windows', () => {
    expect(mainWindowRoundedCorners('darwin')).toBe(true)
    expect(mainWindowRoundedCorners('win32')).toBe(true)
  })
})
