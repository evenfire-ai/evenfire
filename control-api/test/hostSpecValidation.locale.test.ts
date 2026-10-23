import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { SUPPORTED_HOST_LANGUAGES } from '@clerum/host-locale'
import { validateHostSpec } from '../src/routes/admin/hostSpecValidation.js'

// spec.locale holds a supported language tag and an IANA time zone. control-api
// checks it when it is new or changed; host.yaml declares it with patterns every
// value the shared rules accept satisfies.

const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')
const deps = () => ({ isModelAllowed: vi.fn().mockResolvedValue(true) })

describe('Host spec.locale', () => {
  it('accepts a regional language and an IANA time zone', async () => {
    const spec = { locale: { language: 'es-MX', timeZone: 'America/Mexico_City' } }
    expect(await validateHostSpec(spec, deps())).toBeNull()
  })

  it('names each field it refuses', async () => {
    const res = await validateHostSpec({ locale: { language: 'tlh', timeZone: '+01:00' } }, deps())
    expect(res?.errors.map(error => error.field)).toEqual([
      'spec.locale.language',
      'spec.locale.timeZone',
    ])
  })

  it('refuses what the CRD would: spaces around a value and private-use tags', async () => {
    for (const locale of [
      { language: ' es' },
      { timeZone: 'Europe/Madrid ' },
      { language: 'es-x-a' },
      { timeZone: 'EST' },
      { language: 'pa-PK' },
    ]) {
      const res = await validateHostSpec({ locale }, deps())
      expect(res?.errors, JSON.stringify(locale)).toHaveLength(1)
    }
  })

  it('refuses a changed value but leaves an unchanged stored one to mcp-host', async () => {
    const stored = { locale: { timeZone: 'Mars/Base' } }
    expect(
      await validateHostSpec({ locale: { timeZone: 'Mars/Base' } }, deps(), {
        stored,
        tolerations: [],
      })
    ).toBeNull()
    const changed = await validateHostSpec({ locale: { timeZone: 'Mars/Station' } }, deps(), {
      stored,
      tolerations: [],
    })
    expect(changed?.errors.map(error => error.field)).toEqual(['spec.locale.timeZone'])
  })

  it('is declared in host.yaml with patterns every accepted value satisfies', () => {
    const doc = parse(readFileSync(resolve(crdsDir, 'host.yaml'), 'utf8'))
    const locale = doc.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.locale
    const language = new RegExp(locale.properties.language.pattern)
    const timeZone = new RegExp(locale.properties.timeZone.pattern)
    for (const tag of [...SUPPORTED_HOST_LANGUAGES, 'es-MX', 'zh-Hant-TW', 'sr-Latn-RS']) {
      expect(tag).toMatch(language)
    }
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      expect(zone).toMatch(timeZone)
      expect(zone.length).toBeLessThanOrEqual(locale.properties.timeZone.maxLength)
    }
  })
})
