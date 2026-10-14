import { describe, expect, it } from 'vitest'
import {
  builtinFormatCode,
  isModelledFormatCode,
  shownForms,
  withoutSeparators,
} from '../../artifacts/shownNumbers'
import { CURRENCY_SYMBOLS } from '../../workflow/xlsxCells'
import { NUMBER_FORMATS, currencyFormat } from '../../workflow/xlsxFormats'

/** 2026-01-02 as a spreadsheet date serial. */
const JAN_2_2026 = 46024

describe('isModelledFormatCode', () => {
  // Every code the sheet writer and the deck charts can write must be read as
  // shown, or the attachment check would withhold their files.
  const emitted = [
    ...Object.values(NUMBER_FORMATS),
    ...Object.values(CURRENCY_SYMBOLS).flatMap(symbol =>
      [0, 2].map(d => currencyFormat(symbol, d))
    ),
    currencyFormat('CHF ', 2),
    ...[3, 4, 5, 6].map(places => `#,##0.${'0'.repeat(places)}`),
    'yyyy-mm-dd hh:mm:ss',
    '#,##0.0',
    '[>=1000]#,##0;[<=-1000]-#,##0;General',
    'General',
    '+#,##0;-#,##0;#,##0',
    '[Red]+#,##0;[Red]-#,##0;[Red]#,##0',
  ]

  it.each(emitted)('reads %s, which a generator writes', code => {
    expect(isModelledFormatCode(code)).toBe(true)
  })

  it('reads every built-in format a package can name by id', () => {
    const ids = [
      0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 37, 38, 39, 40, 45, 46,
      47, 48, 49,
    ]
    for (const id of ids) expect(isModelledFormatCode(builtinFormatCode(id)!)).toBe(true)
    expect(builtinFormatCode(5)).toBeUndefined()
    expect(builtinFormatCode(164)).toBeUndefined()
  })

  it.each([
    ['an unterminated quote', '"x'],
    ['a system long date', '[$-F800]dddd, mmmm dd, yyyy'],
    ['a system date', '[$-x-sysdate]dddd'],
    ['native digits', '[DBNum1]0'],
    ['another calendar', '[B2]yyyy'],
    ['a code over 255 characters', `"${'x'.repeat(260)}"0`],
    ['nothing', ''],
  ])('does not read %s', (_label, code) => {
    expect(isModelledFormatCode(code)).toBe(false)
  })
})

describe('shownForms', () => {
  it('shows a date serial as its date, in the code and without separators', () => {
    expect(shownForms(JAN_2_2026, 'yyyy-mm-dd')).toContain('2026-01-02'.replace(/[.,]/g, ''))
    expect(shownForms(JAN_2_2026, 'dd/mm/yyyy')).toContain('02/01/2026')
    expect(shownForms(46024.62783564815, 'yyyy-mm-dd hh:mm:ss')).toContain('2026-01-0215:04:05')
  })

  it('shows a built-in short date in the patterns locales use', () => {
    const forms = shownForms(JAN_2_2026, 'mm-dd-yy', true)
    for (const shown of ['1/2/2026', '2/1/2026', '02012026', '2026-01-02']) {
      expect(forms).toContain(withoutSeparators(shown))
    }
  })

  it('shows grouped digits, and quoted text beside them', () => {
    expect(shownForms(3141592653, '#,##0')).toEqual(['3141592653'])
    expect(shownForms(123456, '"sk-"0')).toEqual(['sk-123456'])
  })

  it('shows month names in other languages', () => {
    const forms = shownForms(JAN_2_2026, 'mmm d, yyyy')
    expect(forms).toEqual(expect.arrayContaining(['Jan22026', 'janv22026', 'ene22026']))
  })
})

describe('withoutSeparators', () => {
  it.each([
    ['1,234.5', '12345'],
    ['1.234,5', '12345'],
    ['1 234,5', '12345'],
    ['1 234,5', '12345'],
    ["1'234.5", '12345'],
    ['1’234.5', '12345'],
    ['3,14,15,92,653', '3141592653'],
  ])('reads %s as %s', (shown, digits) => {
    expect(withoutSeparators(shown)).toBe(digits)
  })
})
