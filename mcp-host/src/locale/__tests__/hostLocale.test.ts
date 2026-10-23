// The host's spec.locale as mcp-host applies it, and what the model is told.
import { afterEach, describe, expect, it } from 'vitest'
import { applyHostLocale, currentHostLocale, hostLocaleGuidance } from '../hostLocale'

afterEach(() => {
  applyHostLocale(undefined)
})

describe('applyHostLocale', () => {
  it('falls back to en and UTC, not the server zone, and tells the model nothing', () => {
    const { locale, defaulted, issues } = applyHostLocale(undefined)
    expect(locale).toEqual({
      language: 'en',
      timeZone: 'UTC',
      languageSet: false,
      timeZoneSet: false,
    })
    expect(defaulted).toEqual(['language', 'timeZone'])
    expect(issues).toEqual([])
    expect(hostLocaleGuidance()).toBe('')
  })

  it('keeps a regional tag and an IANA zone, canonical', () => {
    applyHostLocale({ language: 'es-mx', timeZone: 'america/mexico_city' })
    expect(currentHostLocale()).toEqual({
      language: 'es-MX',
      timeZone: 'America/Mexico_City',
      languageSet: true,
      timeZoneSet: true,
    })
  })

  it('reports values it cannot use and applies their defaults', () => {
    const { locale, defaulted, issues } = applyHostLocale({ language: 'tlh', timeZone: '+01:00' })
    expect(locale.language).toBe('en')
    expect(locale.timeZone).toBe('UTC')
    expect(defaulted).toEqual(['language', 'timeZone'])
    expect(issues).toHaveLength(2)
  })
})

describe('hostLocaleGuidance', () => {
  it('names the language and zone the host sets', () => {
    applyHostLocale({ language: 'es-MX', timeZone: 'America/Mexico_City' })
    expect(hostLocaleGuidance()).toBe(
      'Write the documents you generate, titles and headings included, in Mexican Spanish ' +
        '(es-MX) unless the user asks for another language. Quoted or imported material keeps ' +
        'its own language. Dates and times you write are in the America/Mexico_City time zone.'
    )
  })

  it('names the language without the extensions of its tag', () => {
    applyHostLocale({ language: 'fa-u-ca-gregory' })
    expect(currentHostLocale().language).toBe('fa-u-ca-gregory')
    expect(hostLocaleGuidance()).toContain(' in Persian (fa) unless ')
  })

  it('says only what the host sets', () => {
    applyHostLocale({ timeZone: 'Europe/Madrid' })
    expect(hostLocaleGuidance()).toBe(
      'Dates and times you write are in the Europe/Madrid time zone.'
    )
  })
})
