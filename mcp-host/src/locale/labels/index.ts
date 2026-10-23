import { hostTextLanguage } from '@clerum/host-locale'
import { af } from './af'
import { am } from './am'
import { ar } from './ar'
import { az } from './az'
import { be } from './be'
import { bg } from './bg'
import { bn } from './bn'
import { bs } from './bs'
import { ca } from './ca'
import { cs } from './cs'
import { cy } from './cy'
import { da } from './da'
import { de } from './de'
import { el } from './el'
import { en } from './en'
import { es } from './es'
import { et } from './et'
import { eu } from './eu'
import { fa } from './fa'
import { fi } from './fi'
import { fil } from './fil'
import { fr } from './fr'
import { ga } from './ga'
import { gl } from './gl'
import { gu } from './gu'
import { he } from './he'
import { hi } from './hi'
import { hr } from './hr'
import { hu } from './hu'
import { hy } from './hy'
import { id } from './id'
import { is } from './is'
import { it } from './it'
import { ja } from './ja'
import { ka } from './ka'
import { kk } from './kk'
import { km } from './km'
import { kn } from './kn'
import { ko } from './ko'
import { lo } from './lo'
import { lt } from './lt'
import { lv } from './lv'
import { mk } from './mk'
import { ml } from './ml'
import { mn } from './mn'
import { mr } from './mr'
import { ms } from './ms'
import { mt } from './mt'
import { my } from './my'
import { nb } from './nb'
import { ne } from './ne'
import { nl } from './nl'
import { or } from './or'
import { pa } from './pa'
import { pl } from './pl'
import { pt } from './pt'
import { ptPT } from './pt-PT'
import { ro } from './ro'
import { ru } from './ru'
import { sk } from './sk'
import { sl } from './sl'
import { sq } from './sq'
import { sr } from './sr'
import { srLatn } from './sr-Latn'
import { sv } from './sv'
import { sw } from './sw'
import { ta } from './ta'
import { te } from './te'
import { th } from './th'
import { tr } from './tr'
import type { LabelKey, Labels } from './types'
import { uk } from './uk'
import { ur } from './ur'
import { uz } from './uz'
import { vi } from './vi'
import { zhHans } from './zh-Hans'
import { zhHant } from './zh-Hant'
import { zu } from './zu'

export { LABEL_KEYS } from './types'
export type { LabelKey, Labels } from './types'

/** Each supported language's fixed text (@clerum/host-locale SUPPORTED_HOST_LANGUAGES). */
export const DOCUMENT_LABELS: Readonly<Record<string, Labels>> = {
  af,
  am,
  ar,
  az,
  be,
  bg,
  bn,
  bs,
  ca,
  cs,
  cy,
  da,
  de,
  el,
  en,
  es,
  et,
  eu,
  fa,
  fi,
  fil,
  fr,
  ga,
  gl,
  gu,
  he,
  hi,
  hr,
  hu,
  hy,
  id,
  is,
  it,
  ja,
  ka,
  kk,
  km,
  kn,
  ko,
  lo,
  lt,
  lv,
  mk,
  ml,
  mn,
  mr,
  ms,
  mt,
  my,
  nb,
  ne,
  nl,
  or,
  pa,
  pl,
  pt,
  'pt-PT': ptPT,
  ro,
  ru,
  sk,
  sl,
  sq,
  sr,
  'sr-Latn': srLatn,
  sv,
  sw,
  ta,
  te,
  th,
  tr,
  uk,
  ur,
  uz,
  vi,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  zu,
}

const textOf = new Map<string, Labels>()

/** The text of the language `tag` names, in its script: es for es-MX, sr-Latn for sr-ME, else English. */
function labelsFor(tag: string): Labels {
  let labels = textOf.get(tag)
  if (!labels) {
    labels = DOCUMENT_LABELS[hostTextLanguage(tag) ?? 'en'] ?? en
    if (textOf.size >= 64) textOf.clear()
    textOf.set(tag, labels)
  }
  return labels
}

/** `key` in `language`, or in English when that language has no text. */
export function documentLabel(language: string, key: LabelKey): string {
  return labelsFor(language)[key]
}

/** The keys that are printed with a number: a page, a waterfall step, a funnel stage. */
export type NumberedLabelKey = 'page' | 'step' | 'stage'

/** The text before and after the number of `key` ("Página ", "" or "第", "页"). */
export function numberedLabelParts(language: string, key: NumberedLabelKey): [string, string] {
  const label = documentLabel(language, key)
  const at = label.indexOf('{n}')
  return at < 0 ? [`${label} `, ''] : [label.slice(0, at), label.slice(at + 3)]
}

/** `key` with the number `n` in place ("Paso 2", "2. lépés"). */
export function numberedLabel(language: string, key: NumberedLabelKey, n: number): string {
  const [before, after] = numberedLabelParts(language, key)
  return `${before}${n}${after}`
}

/** The supported languages written right to left. */
const RIGHT_TO_LEFT = new Set(['ar', 'fa', 'he', 'ur'])

/** Which way a page in `language` runs. */
export function writingDirection(language: string): 'ltr' | 'rtl' {
  return RIGHT_TO_LEFT.has(hostTextLanguage(language) ?? '') ? 'rtl' : 'ltr'
}

const GEORGIAN = /\p{Script=Georgian}/u

/**
 * `text` in capitals, by `language`'s rules when given (Turkish dotted İ) and
 * by the default ones otherwise. Georgian text keeps its letters: its capitals
 * (Mtavruli) are missing from many fonts and would print as boxes.
 */
export function inCapitals(text: string, language?: string): string {
  if (GEORGIAN.test(text)) return text
  return language ? text.toLocaleUpperCase(language) : text.toUpperCase()
}

/** A status or severity word in capitals, as the badges print it. */
export function badgeLabel(language: string, key: LabelKey): string {
  return inCapitals(documentLabel(language, key), language)
}
