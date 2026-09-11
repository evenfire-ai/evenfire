import { describe, expect, it } from 'vitest'
import { toKebabCase, toKebabInput } from '../string'

describe('string formatters', () => {
  it('formats final values as lowercase kebab case', () => {
    expect(toKebabCase('Telegram Bot')).toBe('telegram-bot')
    expect(toKebabCase('Telegram_Bot')).toBe('telegram-bot')
    expect(toKebabCase(' telegram---bot_ ')).toBe('telegram-bot')
  })

  it('preserves in-progress separators while typing kebab names', () => {
    expect(toKebabInput('Telegram ')).toBe('telegram-')
    expect(toKebabInput('Telegram_')).toBe('telegram-')
    expect(toKebabInput('telegram-')).toBe('telegram-')
    expect(toKebabInput('_Telegram')).toBe('telegram')
  })
})

// UT-4 — slug contract that shields the wizard auto-slug. Free display text (with
// spaces, capitals, underscores, punctuation) must always derive to a valid
// RFC1123 metadata.name via toKebabCase; and toKebabInput normalizes spaces and
// underscores to hyphens as the user types.
describe('slug contract (UT-4)', () => {
  // RFC1123 DNS label: lowercase alphanumeric + hyphens, start/end alphanumeric,
  // 1-63 chars. Mirrors control-api/src/http/rfc1123.ts.
  const RFC1123_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

  it('derives a hyphenated slug from free display text', () => {
    expect(toKebabInput('Sales Agent')).toBe('sales-agent')
    expect(toKebabCase('Sales Agent')).toBe('sales-agent')
  })

  it('normalizes underscores to hyphens', () => {
    expect(toKebabInput('sales_agent')).toBe('sales-agent')
    expect(toKebabCase('sales_agent')).toBe('sales-agent')
  })

  it('always produces a valid RFC1123 metadata.name from content-bearing display names', () => {
    const displayNames = [
      'Sales Agent',
      'Ventas & Más',
      'Product Agents',
      'Prod X',
      'My_Cool_Agent 42',
      '  Leading and trailing  ',
      'UPPER lower 99',
      'a',
      'agent---name',
    ]
    for (const name of displayNames) {
      const slug = toKebabCase(name)
      expect(slug.length, `slug for "${name}" must be non-empty`).toBeGreaterThan(0)
      expect(RFC1123_RE.test(slug), `"${name}" -> "${slug}" must be RFC1123`).toBe(true)
    }
  })
})
