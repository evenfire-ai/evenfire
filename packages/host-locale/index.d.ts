/**
 * The language and time zone a host writes its documents in (Host spec.locale).
 * Pure and browser-safe: Intl only.
 */

/** Languages the document tools have their fixed text for. */
export declare const SUPPORTED_HOST_LANGUAGES: readonly string[]

/** Used when a host names no language, or one that is not supported. */
export declare const DEFAULT_HOST_LANGUAGE: string

/** Used when a host names no time zone, or one that is not an IANA zone. */
export declare const DEFAULT_HOST_TIME_ZONE: string

/** A Host's spec.locale as written. */
export interface HostLocaleSpec {
  language?: unknown
  timeZone?: unknown
}

export interface HostLocaleIssue {
  field: string
  message: string
}

export interface ResolvedHostLocale {
  language: string
  timeZone: string
  /** The fields that fell back to their default. */
  defaulted: Array<'language' | 'timeZone'>
}

/** The supported language a tag names ("es-MX" is es), or null. */
export declare function supportedHostLanguage(tag: unknown): string | null

/** The supported language whose fixed text suits a tag, in its script ("sr-ME" is sr-Latn), or null. */
export declare function hostTextLanguage(tag: unknown): string | null

/** A supported language's tag in canonical form ("es-mx" is es-MX), kept whole for formatting; or null. */
export declare function hostLanguageTag(tag: unknown): string | null

/** A place's IANA zone (Europe/Madrid) or UTC, case as Intl lists it, or null; offsets and EST-style names are refused. */
export declare function canonicalTimeZone(zone: unknown): string | null

/** Problems with a Host's spec.locale; none when it is absent. */
export declare function hostLocaleIssues(locale: unknown, field?: string): HostLocaleIssue[]

/** The language and time zone a host uses, with defaults for what is missing or unusable. */
export declare function resolveHostLocale(locale: unknown): ResolvedHostLocale
