import { hostLocaleIssues, resolveHostLocale } from '@clerum/host-locale'

/** The language and time zone this host writes its documents in (Host spec.locale). */
export interface HostLocale {
  /** A BCP 47 tag (es-MX): numbers and dates follow it whole, fixed text its language (es). */
  language: string
  /** An IANA zone; dates are computed in it with its daylight-saving rules. */
  timeZone: string
  /** Whether the host names its language; only then is the model told to write in it. */
  languageSet: boolean
  /** Whether the host names its time zone; only then is the model told about it. */
  timeZoneSet: boolean
}

function resolve(spec: unknown): { locale: HostLocale; defaulted: string[] } {
  const r = resolveHostLocale(spec)
  return {
    locale: {
      language: r.language,
      timeZone: r.timeZone,
      languageSet: !r.defaulted.includes('language'),
      timeZoneSet: !r.defaulted.includes('timeZone'),
    },
    defaulted: r.defaulted,
  }
}

let current: HostLocale = resolve(undefined).locale

/**
 * Takes a Host's spec.locale (one process serves one host). Returns the locale
 * now in use, the fields that fell back to their default, and why a value that
 * was set could not be used.
 */
export function applyHostLocale(spec: unknown): {
  locale: HostLocale
  defaulted: string[]
  issues: string[]
} {
  const resolved = resolve(spec)
  current = resolved.locale
  return { ...resolved, issues: hostLocaleIssues(spec).map(issue => issue.message) }
}

/** The language and time zone in use now. */
export function currentHostLocale(): HostLocale {
  return current
}

/** A tag without its extensions ("fa-u-ca-gregory" is fa), and its English name ("Persian"). */
function languageName(language: string): { tag: string; name: string } {
  try {
    const tag = new Intl.Locale(language).baseName
    return { tag, name: new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag }
  } catch {
    return { tag: language, name: language }
  }
}

/**
 * What the system prompt tells the model about the host's language and time
 * zone; empty when the host names neither, so its prompt stays as it was.
 */
export function hostLocaleGuidance(locale: HostLocale = current): string {
  const lines: string[] = []
  if (locale.languageSet) {
    const { tag, name } = languageName(locale.language)
    lines.push(
      `Write the documents you generate, titles and headings included, in ${name} (${tag}) ` +
        'unless the user asks for another language. Quoted or imported material keeps its own ' +
        'language.'
    )
  }
  if (locale.timeZoneSet) {
    lines.push(`Dates and times you write are in the ${locale.timeZone} time zone.`)
  }
  return lines.join(' ')
}
