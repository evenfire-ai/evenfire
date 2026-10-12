import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

function cssRuleBody(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1]
}

// Both theme blocks (:root/dark and :root[data-theme='light']) must declare
// the token; an undeclared var() silently drops the whole declaration.
function themeTokenDeclarations(token: string): string[] {
  const declarations = [...css.matchAll(new RegExp(`${token}:\\s*([^;]+);`, 'g'))].map(match =>
    match[1].trim()
  )
  if (declarations.length !== 2) {
    throw new Error(
      `${token} must be declared exactly twice (dark + light themes), found ${declarations.length}`
    )
  }
  return declarations
}

// The connector edit Access tab renders .cu-entity-access legend cards. Its
// colors must come from the declared tokens — theme-aware muted tints instead
// of per-rule rgba() derivations, and the font-size scale instead of raw rem.
describe('Connector Access tab stylesheet contract', () => {
  it('derives the count-chip tints from the muted accent tokens', () => {
    expect(cssRuleBody('.cu-entity-access__heading span')).toMatch(
      /background:\s*var\(--cu-accent-muted\)/
    )
    expect(
      cssRuleBody(".cu-entity-access__group[data-kind='teams'] .cu-entity-access__heading span")
    ).toMatch(/background:\s*var\(--cu-success-muted\)/)
    expect(
      cssRuleBody(".cu-entity-access__group[data-kind='agents'] .cu-entity-access__heading span")
    ).toMatch(/background:\s*var\(--cu-warning-muted\)/)
  })

  it('uses the established ok/warn border tokens for the team and agent chips', () => {
    expect(
      cssRuleBody(".cu-entity-access__group[data-kind='teams'] .cu-entity-access__heading span")
    ).toMatch(/border-color:\s*var\(--cu-ok-border\)/)
    expect(
      cssRuleBody(".cu-entity-access__group[data-kind='agents'] .cu-entity-access__heading span")
    ).toMatch(/border-color:\s*var\(--cu-warn-border\)/)
  })

  it('declares the muted tint tokens in both themes so the chips never resolve to nothing', () => {
    for (const token of ['--cu-success-muted', '--cu-warning-muted']) {
      for (const value of themeTokenDeclarations(token)) {
        expect(value).toMatch(/^rgba\(/)
      }
    }
  })

  it('keeps the legend typography on the declared font-size scale', () => {
    expect(cssRuleBody('.cu-entity-access__intro > span')).toMatch(
      /font-size:\s*var\(--cu-font-size-2xs\)/
    )
    expect(cssRuleBody('.cu-entity-access__heading h4')).toMatch(
      /font-size:\s*var\(--cu-font-size-xs\)/
    )
    expect(cssRuleBody('.cu-entity-access__heading span')).toMatch(
      /font-size:\s*var\(--cu-font-size-xs\)/
    )
    expect(cssRuleBody('.cu-entity-access__list')).toMatch(/font-size:\s*var\(--cu-font-size-sm\)/)
  })
})
