import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

function selectorRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

describe('loading style accessibility', () => {
  it('disables skeleton and spinner animations for reduced-motion users', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(css).toMatch(
      /@media[\s\S]*prefers-reduced-motion[\s\S]*\.cu-skeleton[\s\S]*animation:\s*none/
    )
    expect(css).toMatch(
      /@media[\s\S]*prefers-reduced-motion[\s\S]*\.cu-spin[\s\S]*animation:\s*none/
    )
    expect(css).toMatch(
      /@media[\s\S]*prefers-reduced-motion[\s\S]*\.cu-btn__spinner[\s\S]*animation:\s*none/
    )
    expect(css).toMatch(
      /@media[\s\S]*prefers-reduced-motion[\s\S]*\.cu-identity-skeleton__line[\s\S]*animation:\s*none/
    )
  })

  it('keeps the shared skeleton class visibly styled', () => {
    const rule = selectorRule('.cu-skeleton')
    expect(rule).toMatch(/background:/)
    expect(rule).toMatch(/background-size:/)
  })
})
