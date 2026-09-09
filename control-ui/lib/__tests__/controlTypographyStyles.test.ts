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

describe('Control UI typography stylesheet contract', () => {
  it('keeps recipe diagnostics on the declared Control UI font-size scale', () => {
    expect(cssRuleBody('.cu-recipe-inline-error')).toMatch(/font-size:\s*var\(--cu-font-size-xs\)/)
    expect(cssRuleBody('.cu-recipe-manifest-editor__textarea')).toMatch(
      /font-size:\s*var\(--cu-font-size-md\)/
    )
  })
})
