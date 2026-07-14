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
