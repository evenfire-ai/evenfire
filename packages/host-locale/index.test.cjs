'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const hostLocale = require('./index.cjs')
const {
  DEFAULT_HOST_LANGUAGE,
  DEFAULT_HOST_TIME_ZONE,
  SUPPORTED_HOST_LANGUAGES,
  canonicalTimeZone,
  hostLanguageTag,
  hostLocaleIssues,
  hostTextLanguage,
  resolveHostLocale,
  supportedHostLanguage,
} = hostLocale

test('runtime exports stay aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = Array.from(
    declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
    m => m[1]
  ).sort()
  assert.deepEqual(Object.keys(hostLocale).sort(), declared)
})

test('every supported language is a tag Intl formats in, listed once', () => {
  assert.equal(new Set(SUPPORTED_HOST_LANGUAGES).size, SUPPORTED_HOST_LANGUAGES.length)
  assert.ok(SUPPORTED_HOST_LANGUAGES.includes(DEFAULT_HOST_LANGUAGE))
  for (const tag of SUPPORTED_HOST_LANGUAGES) {
    assert.deepEqual(Intl.getCanonicalLocales(tag), [tag], tag)
    assert.equal(supportedHostLanguage(tag), tag)
    assert.equal(hostTextLanguage(tag), tag)
  }
})

test('a regional or other spelling of a language finds it', () => {
  const cases = {
    'es-MX': 'es',
    ES_mx: 'es',
    'pt-BR': 'pt',
    'pt-PT': 'pt-PT',
    'sr-Latn-RS': 'sr-Latn',
    'sr-Cyrl': 'sr',
    zh: 'zh-Hans',
    'zh-CN': 'zh-Hans',
    'zh-TW': 'zh-Hant',
    'zh-Hant-HK': 'zh-Hant',
    no: 'nb',
    tl: 'fil',
    iw: 'he',
  }
  for (const [tag, want] of Object.entries(cases))
    assert.equal(supportedHostLanguage(tag), want, tag)
  for (const tag of ['xx', 'si', '', ' ', 'e$', 'english', 42, null, undefined]) {
    assert.equal(supportedHostLanguage(tag), null, String(tag))
  }
})

test('a language tag is kept whole and canonical, so numbers and dates follow its region', () => {
  const cases = {
    'es-mx': 'es-MX',
    ' ES_MX ': 'es-MX',
    'pt-br': 'pt-BR',
    'zh-tw': 'zh-TW',
    'sr-latn-rs': 'sr-Latn-RS',
    'es-419': 'es-419',
    iw: 'he',
    in: 'id',
    sh: 'sr-Latn',
    en: 'en',
    'fa-u-ca-gregory': 'fa-u-ca-gregory',
  }
  for (const [tag, want] of Object.entries(cases)) assert.equal(hostLanguageTag(tag), want, tag)
  assert.equal(new Intl.NumberFormat(hostLanguageTag('es-MX')).format(1234.5), '1,234.5')
  assert.equal(new Intl.NumberFormat(hostLanguageTag('es')).format(1234.5), '1234,5')
  // Private-use and other non-Unicode extensions change no format and are refused.
  for (const tag of [
    'si-LK',
    'xx-MX',
    'zh-cmn',
    'es-' + 'x'.repeat(40),
    'es-x-anything',
    'en-t-ja',
    '',
    42,
    null,
  ]) {
    assert.equal(hostLanguageTag(tag), null, String(tag))
  }
})

test('a regional tag reads the fixed text of its own script, or none', () => {
  const cases = {
    'sr-ME': 'sr-Latn',
    'sr-RS': 'sr',
    'zh-TW': 'zh-Hant',
    'zh-SG': 'zh-Hans',
    'es-MX': 'es',
    'pt-PT': 'pt-PT',
    'pt-BR': 'pt',
  }
  for (const [tag, want] of Object.entries(cases)) assert.equal(hostTextLanguage(tag), want, tag)
  // No supported language is written in these scripts, so the tags are refused.
  for (const tag of ['pa-PK', 'uz-Cyrl', 'bs-Cyrl', 'hi-Latn']) {
    assert.equal(hostTextLanguage(tag), null, tag)
    assert.equal(hostLanguageTag(tag), null, tag)
  }
  assert.equal(hostLanguageTag('sr-ME'), 'sr-ME')
})

test('a time zone is an IANA zone, spelled as given apart from case; offsets are refused', () => {
  assert.equal(canonicalTimeZone('America/Mexico_City'), 'America/Mexico_City')
  assert.equal(canonicalTimeZone(' america/mexico_city '), 'America/Mexico_City')
  assert.equal(canonicalTimeZone('utc'), 'UTC')
  // Some engines resolve Kolkata to the older Calcutta; the name given is kept.
  assert.equal(canonicalTimeZone('Asia/Kolkata'), 'Asia/Kolkata')
  // Fixed offsets under any name do not follow daylight-saving rules.
  for (const zone of ['EST', 'Etc/GMT+5', 'US/Eastern', 'GMT', 'Etc/UTC', 'SystemV/EST5EDT']) {
    assert.equal(canonicalTimeZone(zone), null, zone)
  }
  for (const zone of ['+01:00', '-0600', 'GMT+1', 'Mars/Base', '', 'Europe/', 7, null]) {
    assert.equal(canonicalTimeZone(zone), null, String(zone))
  }
})

test('spec.locale problems name the field; an absent locale has none', () => {
  assert.deepEqual(hostLocaleIssues(undefined), [])
  assert.deepEqual(hostLocaleIssues(null), [])
  assert.deepEqual(hostLocaleIssues({}), [])
  assert.deepEqual(hostLocaleIssues({ language: 'es-MX', timeZone: 'Europe/Madrid' }), [])
  assert.deepEqual(
    hostLocaleIssues('es').map(i => i.field),
    ['spec.locale']
  )
  assert.deepEqual(
    hostLocaleIssues({ language: 'xx', timeZone: '+01:00' }).map(i => i.field),
    ['spec.locale.language', 'spec.locale.timeZone']
  )
  // The CRD's patterns refuse spaces around a value, so control-api does too.
  assert.deepEqual(
    hostLocaleIssues({ language: ' es', timeZone: 'Europe/Madrid ' }).map(i => i.field),
    ['spec.locale.language', 'spec.locale.timeZone']
  )
})

test('a missing or unusable value falls back to its documented default, never the server zone', () => {
  assert.deepEqual(resolveHostLocale({ language: 'es-MX', timeZone: 'america/mexico_city' }), {
    language: 'es-MX',
    timeZone: 'America/Mexico_City',
    defaulted: [],
  })
  assert.deepEqual(resolveHostLocale(undefined), {
    language: DEFAULT_HOST_LANGUAGE,
    timeZone: DEFAULT_HOST_TIME_ZONE,
    defaulted: ['language', 'timeZone'],
  })
  assert.deepEqual(resolveHostLocale({ language: 'xx', timeZone: 'Europe/Madrid' }), {
    language: 'en',
    timeZone: 'Europe/Madrid',
    defaulted: ['language'],
  })
  assert.equal(DEFAULT_HOST_TIME_ZONE, 'UTC')
})
