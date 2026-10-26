import { describe, expect, it } from 'vitest'
import { SUPPORTED_HOST_LANGUAGES } from '@clerum/host-locale'
import {
  hostLanguageLabel,
  hostLanguageOptions,
  hostLocaleSpec,
  hostTimeZoneOptions,
  readHostLocale,
} from '../hostLocale'

describe('host locale form helpers', () => {
  it('names a language tag in English, with the tag', () => {
    expect(hostLanguageLabel('es-MX')).toBe('Mexican Spanish (es-MX)')
    expect(hostLanguageLabel('es')).toBe('Spanish (es)')
  })

  it('offers every supported language and keeps a stored tag the list lacks', () => {
    const offered = hostLanguageOptions('').map(option => option.value)
    for (const tag of SUPPORTED_HOST_LANGUAGES) expect(offered).toContain(tag)
    expect(offered).toContain('es-MX')
    expect(hostLanguageOptions('es-BO').map(option => option.value)).toContain('es-BO')
  })

  it('offers IANA zones with UTC and keeps a stored zone the list lacks', () => {
    const zones = hostTimeZoneOptions('')
    expect(zones).toContain('UTC')
    expect(zones).toContain('America/Mexico_City')
    expect(hostTimeZoneOptions('Asia/Calcutta')).toContain('Asia/Calcutta')
  })

  it('reads a stored locale and writes only the values that are set', () => {
    expect(readHostLocale(undefined)).toEqual({ language: '', timeZone: '' })
    expect(readHostLocale({ language: 'es-MX', timeZone: 7 })).toEqual({
      language: 'es-MX',
      timeZone: '',
    })
    expect(hostLocaleSpec({ language: '', timeZone: '' })).toBeUndefined()
    expect(hostLocaleSpec({ language: '', timeZone: 'Europe/Madrid' })).toEqual({
      timeZone: 'Europe/Madrid',
    })
  })
})
