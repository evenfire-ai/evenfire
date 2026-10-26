'use strict'

/**
 * The language and time zone a host writes its documents in (Host spec.locale),
 * shared by mcp-host (which applies them), control-api (which validates them)
 * and control-ui (which offers them). Pure and browser-safe: Intl only.
 */

/**
 * Languages the document tools have their fixed text for (mcp-host
 * src/locale/labels holds exactly these). Every one is written in a script the
 * PDF and chart renderers draw; Sinhala is left out because the PDF renderer
 * has no face for it. A host may name a regional form of any of them (es-MX,
 * pt-BR), which its numbers and dates follow.
 */
const SUPPORTED_HOST_LANGUAGES = Object.freeze([
  'af',
  'am',
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'eu',
  'fa',
  'fi',
  'fil',
  'fr',
  'ga',
  'gl',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'lo',
  'lt',
  'lv',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'nb',
  'ne',
  'nl',
  'or',
  'pa',
  'pl',
  'pt',
  'pt-PT',
  'ro',
  'ru',
  'sk',
  'sl',
  'sq',
  'sr',
  'sr-Latn',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'ur',
  'uz',
  'vi',
  'zh-Hans',
  'zh-Hant',
  'zu',
])

/** Used when a host names no language, or one that is not supported. */
const DEFAULT_HOST_LANGUAGE = 'en'

/** Used when a host names no time zone, or one that is not an IANA zone. Never the server's. */
const DEFAULT_HOST_TIME_ZONE = 'UTC'

const BY_LOWER = new Map(SUPPORTED_HOST_LANGUAGES.map(tag => [tag.toLowerCase(), tag]))

// Tags that name a supported language another way.
const ALIASES = new Map([
  ['zh', 'zh-Hans'],
  ['zh-cn', 'zh-Hans'],
  ['zh-sg', 'zh-Hans'],
  ['zh-tw', 'zh-Hant'],
  ['zh-hk', 'zh-Hant'],
  ['zh-mo', 'zh-Hant'],
  ['no', 'nb'],
  ['nn', 'nb'],
  ['tl', 'fil'],
  ['iw', 'he'],
  ['in', 'id'],
])

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/

/** The longest language tag taken (RFC 5646 section 4.4.1). */
const MAX_LANGUAGE_TAG_LENGTH = 35

/**
 * The supported language a tag names, or null: the tag itself (case aside),
 * an alias, or its leading subtags ("es-MX" is es, "zh-Hant-TW" is zh-Hant).
 */
function supportedHostLanguage(tag) {
  if (typeof tag !== 'string') return null
  const t = tag.trim().replace(/_/g, '-')
  if (!LANGUAGE_TAG.test(t)) return null
  const parts = t.toLowerCase().split('-')
  for (let n = parts.length; n > 0; n--) {
    const prefix = parts.slice(0, n).join('-')
    const found = BY_LOWER.get(prefix) ?? ALIASES.get(prefix)
    if (found) return found
  }
  return null
}

/**
 * A host's language tag in canonical form ("es-mx" is es-MX, "iw" is he), when
 * the language it names is supported; else null. Numbers and dates follow the
 * whole tag, so es-MX writes 12,345.5 where es writes 12.345,5. Of the
 * extensions only Unicode ones (-u-, as in fa-u-ca-gregory) are taken: the
 * others, private use included, change no format.
 */
function hostLanguageTag(tag) {
  if (typeof tag !== 'string') return null
  const t = tag.trim().replace(/_/g, '-')
  if (t.length > MAX_LANGUAGE_TAG_LENGTH || !LANGUAGE_TAG.test(t)) return null
  let canonical
  try {
    canonical = Intl.getCanonicalLocales(t)[0]
  } catch {
    return null
  }
  if (
    !canonical ||
    canonical.split('-').some(sub => sub.length === 1 && sub.toLowerCase() !== 'u')
  ) {
    return null
  }
  return hostTextLanguage(canonical) !== null ? canonical : null
}

/** The script a tag is written in, as Intl fills it in ("sr-ME" is Latn), or null. */
function scriptOf(tag) {
  try {
    return new Intl.Locale(tag).maximize().script ?? null
  } catch {
    return null
  }
}

/**
 * The supported language whose fixed text suits `tag`: its longest supported
 * prefix in the tag's own script ("sr-ME" is sr-Latn, "zh-TW" zh-Hant), or null
 * when no supported language is written in that script ("pa-PK", "uz-Cyrl").
 */
function hostTextLanguage(tag) {
  const found = supportedHostLanguage(tag)
  if (found === null) return null
  const script = scriptOf(tag.trim().replace(/_/g, '-'))
  if (script === null || scriptOf(found) === script) return found
  const scripted = supportedHostLanguage(`${found.split('-')[0]}-${script}`)
  return scripted !== null && scriptOf(scripted) === script ? scripted : null
}

let listedZones

// Zone names as Intl lists them, by lower case. Intl's own canonical names are
// left alone: some engines resolve Asia/Kolkata to the older Asia/Calcutta.
function zoneSpelling(zone) {
  if (listedZones === undefined) {
    let names = []
    try {
      names = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
    } catch {
      names = []
    }
    listedZones = new Map([...names, 'UTC'].map(name => [name.toLowerCase(), name]))
  }
  return listedZones.get(zone.toLowerCase()) ?? zone
}

/** The areas IANA files the zones of places under ("Europe/Madrid"). */
const ZONE_AREAS = new Set([
  'africa',
  'america',
  'antarctica',
  'arctic',
  'asia',
  'atlantic',
  'australia',
  'europe',
  'indian',
  'pacific',
])

/**
 * The IANA time zone a name gives, a place's zone such as Europe/Madrid or
 * UTC, spelled as Intl lists it when it differs only in case
 * ("america/mexico_city" is America/Mexico_City), or null. Offsets such as
 * "+01:00" and fixed-offset names such as EST or Etc/GMT+5 are refused: they
 * do not follow daylight-saving rules.
 */
function canonicalTimeZone(zone) {
  if (typeof zone !== 'string') return null
  const z = zone.trim()
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(z)) return null
  const area = z.split('/')[0].toLowerCase()
  if (z.toLowerCase() !== 'utc' && !(z.includes('/') && ZONE_AREAS.has(area))) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
  } catch {
    return null
  }
  return zoneSpelling(z)
}

/** Whether `value` is a string with nothing around it, as the Host CRD's patterns require. */
function bare(value) {
  return typeof value === 'string' && value === value.trim()
}

/** Problems with a Host's spec.locale; none when it is absent. */
function hostLocaleIssues(locale, field = 'spec.locale') {
  if (locale === undefined || locale === null) return []
  if (typeof locale !== 'object' || Array.isArray(locale)) {
    return [{ field, message: `${field} must be an object with language and timeZone.` }]
  }
  const issues = []
  if (
    locale.language !== undefined &&
    (!bare(locale.language) || hostLanguageTag(locale.language) === null)
  ) {
    issues.push({
      field: `${field}.language`,
      message: `${field}.language must be a supported language tag, such as en, es-MX or pt-BR.`,
    })
  }
  if (
    locale.timeZone !== undefined &&
    (!bare(locale.timeZone) || canonicalTimeZone(locale.timeZone) === null)
  ) {
    issues.push({
      field: `${field}.timeZone`,
      message: `${field}.timeZone must be the IANA zone of a place, such as Europe/Madrid or America/New_York, or UTC.`,
    })
  }
  return issues
}

/**
 * The language and time zone a host uses, each from its spec.locale when that
 * value is usable, else the default; `defaulted` names the ones that fell back.
 */
function resolveHostLocale(locale) {
  const given =
    locale !== null && typeof locale === 'object' && !Array.isArray(locale) ? locale : {}
  const language = hostLanguageTag(given.language)
  const timeZone = canonicalTimeZone(given.timeZone)
  const defaulted = []
  if (!language) defaulted.push('language')
  if (!timeZone) defaulted.push('timeZone')
  return {
    language: language ?? DEFAULT_HOST_LANGUAGE,
    timeZone: timeZone ?? DEFAULT_HOST_TIME_ZONE,
    defaulted,
  }
}

module.exports = {
  SUPPORTED_HOST_LANGUAGES,
  DEFAULT_HOST_LANGUAGE,
  DEFAULT_HOST_TIME_ZONE,
  supportedHostLanguage,
  hostTextLanguage,
  hostLanguageTag,
  canonicalTimeZone,
  hostLocaleIssues,
  resolveHostLocale,
}
