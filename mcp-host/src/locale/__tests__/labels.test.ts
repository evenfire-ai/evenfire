// The fixed text the document tools print, in every supported language.
import { describe, expect, it } from 'vitest'
import { SUPPORTED_HOST_LANGUAGES } from '@clerum/host-locale'
import {
  DOCUMENT_LABELS,
  LABEL_KEYS,
  badgeLabel,
  documentLabel,
  numberedLabel,
  writingDirection,
} from '../labels'

/** The script each language not written in Latin letters uses. */
const SCRIPTS: Record<string, RegExp> = {
  am: /\p{Script=Ethiopic}/u,
  ar: /\p{Script=Arabic}/u,
  be: /\p{Script=Cyrillic}/u,
  bg: /\p{Script=Cyrillic}/u,
  bn: /\p{Script=Bengali}/u,
  el: /\p{Script=Greek}/u,
  fa: /\p{Script=Arabic}/u,
  gu: /\p{Script=Gujarati}/u,
  he: /\p{Script=Hebrew}/u,
  hi: /\p{Script=Devanagari}/u,
  hy: /\p{Script=Armenian}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ka: /\p{Script=Georgian}/u,
  kk: /\p{Script=Cyrillic}/u,
  km: /\p{Script=Khmer}/u,
  kn: /\p{Script=Kannada}/u,
  ko: /\p{Script=Hangul}/u,
  lo: /\p{Script=Lao}/u,
  mk: /\p{Script=Cyrillic}/u,
  ml: /\p{Script=Malayalam}/u,
  mn: /\p{Script=Cyrillic}/u,
  mr: /\p{Script=Devanagari}/u,
  my: /\p{Script=Myanmar}/u,
  ne: /\p{Script=Devanagari}/u,
  or: /\p{Script=Oriya}/u,
  pa: /\p{Script=Gurmukhi}/u,
  ru: /\p{Script=Cyrillic}/u,
  sr: /\p{Script=Cyrillic}/u,
  ta: /\p{Script=Tamil}/u,
  te: /\p{Script=Telugu}/u,
  th: /\p{Script=Thai}/u,
  uk: /\p{Script=Cyrillic}/u,
  ur: /\p{Script=Arabic}/u,
  'zh-Hans': /\p{Script=Han}/u,
  'zh-Hant': /\p{Script=Han}/u,
}

/** The one placeholder each key may hold, once: where the period or the number goes. */
const PLACEHOLDERS: Partial<Record<string, string>> = {
  periodHighlights: '{period}',
  page: '{n}',
  step: '{n}',
  stage: '{n}',
}

/** Headings every translation writes in its own words. */
const HEADINGS = ['report', 'summary', 'keyMetrics', 'nextSteps', 'lessonsLearned'] as const

describe('document labels', () => {
  it('hold every key, and only the supported languages', () => {
    expect(Object.keys(DOCUMENT_LABELS).sort()).toEqual([...SUPPORTED_HOST_LANGUAGES].sort())
    for (const [language, labels] of Object.entries(DOCUMENT_LABELS)) {
      expect(Object.keys(labels).sort(), language).toEqual([...LABEL_KEYS].sort())
      for (const key of LABEL_KEYS) {
        const text = labels[key]
        expect(text.trim(), `${language}.${key}`).not.toBe('')
        expect(text, `${language}.${key}`).toBe(text.trim())
        expect(text.length, `${language}.${key}`).toBeLessThanOrEqual(40)
        const allowed = PLACEHOLDERS[key]
        for (const found of text.match(/\{[^}]*\}/g) ?? []) {
          expect(found, `${language}.${key}`).toBe(allowed)
        }
        if (allowed) expect(text.split(allowed).length, `${language}.${key}`).toBeLessThanOrEqual(2)
      }
      expect(labels.periodHighlights, language).toContain('{period}')
      // Excel refuses these in a sheet name, which the stem and a number make.
      expect(labels.sheet, language).not.toMatch(/[\\/?*:[\]']/)
      expect(labels.sheet.length, language).toBeLessThanOrEqual(28)
    }
  })

  it('are written in each language, not left in English', () => {
    for (const [language, labels] of Object.entries(DOCUMENT_LABELS)) {
      if (language === 'en') continue
      const script = SCRIPTS[language]
      for (const key of HEADINGS) {
        if (script) expect(labels[key], `${language}.${key}`).toMatch(script)
        else expect(labels[key], `${language}.${key}`).not.toBe(DOCUMENT_LABELS.en[key])
      }
    }
  })

  it("find a regional tag's text by its language in its script, and English for none", () => {
    expect(documentLabel('es-MX', 'page')).toBe('Página')
    expect(documentLabel('es', 'page')).toBe('Página')
    expect(documentLabel('sr-ME', 'report')).toBe(DOCUMENT_LABELS['sr-Latn'].report)
    expect(documentLabel('sr-RS', 'report')).toBe(DOCUMENT_LABELS.sr.report)
    expect(documentLabel('tlh', 'page')).toBe('Page')
  })

  it('run right to left for Arabic, Persian, Hebrew and Urdu', () => {
    for (const tag of ['ar', 'ar-EG', 'fa', 'he', 'ur-PK'])
      expect(writingDirection(tag), tag).toBe('rtl')
    for (const tag of ['en', 'es-MX', 'ja', 'tlh']) expect(writingDirection(tag), tag).toBe('ltr')
  })

  it('put the number where the language writes it', () => {
    expect(numberedLabel('es', 'step', 2)).toBe('Paso 2')
    expect(numberedLabel('hu', 'page', 3)).toBe('3. oldal')
  })

  it("print badges in capitals by the language's own rules", () => {
    expect(badgeLabel('es-MX', 'serviceDown')).toBe('CAÍDO')
    expect(badgeLabel('en', 'statusGreen')).toBe('GREEN')
    expect(badgeLabel('tr', 'serviceHealthy')).toBe('ÇALIŞIYOR')
    // Georgian capitals are missing from many fonts, so its badges keep their letters.
    expect(badgeLabel('ka', 'statusGreen')).toBe(DOCUMENT_LABELS.ka.statusGreen)
  })
})
