import { SUPPORTED_HOST_LANGUAGES, canonicalTimeZone } from '@clerum/host-locale'
import type { HostLocaleValue } from '@components/HostLocaleDialog/types'
import { HOST_LANGUAGE_REGIONS } from '@constants/hostLocale'

/** "Mexican Spanish (es-MX)": a tag's English name with the tag, or the tag alone. */
export function hostLanguageLabel(tag: string): string {
  let name: string | undefined
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag)
  } catch {
    name = undefined
  }
  return name && name !== tag ? `${name} (${tag})` : tag
}

/** The languages the form offers, by name; `current` is kept when the list lacks it. */
export function hostLanguageOptions(current: string): Array<{ value: string; label: string }> {
  const tags = new Set<string>([...SUPPORTED_HOST_LANGUAGES, ...HOST_LANGUAGE_REGIONS])
  if (current) tags.add(current)
  return [...tags]
    .map(tag => ({ value: tag, label: hostLanguageLabel(tag) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en'))
}

/** The places' IANA zones the browser knows, with UTC; `current` is kept when the list lacks it. */
export function hostTimeZoneOptions(current: string): string[] {
  const zones = new Set<string>(
    (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []).filter(
      zone => canonicalTimeZone(zone) !== null
    )
  )
  zones.add('UTC')
  if (current) zones.add(current)
  return [...zones].sort((a, b) => a.localeCompare(b, 'en'))
}

/** A Host's spec.locale as the form edits it: each value as written, or empty. */
export function readHostLocale(locale: unknown): HostLocaleValue {
  const given = locale && typeof locale === 'object' ? (locale as Record<string, unknown>) : {}
  return {
    language: typeof given.language === 'string' ? given.language : '',
    timeZone: typeof given.timeZone === 'string' ? given.timeZone : '',
  }
}

/** The spec.locale to write for `value`: its set fields, or none when both are empty. */
export function hostLocaleSpec(value: HostLocaleValue): Record<string, string> | undefined {
  const spec: Record<string, string> = {}
  if (value.language) spec.language = value.language
  if (value.timeZone) spec.timeZone = value.timeZone
  return Object.keys(spec).length > 0 ? spec : undefined
}
