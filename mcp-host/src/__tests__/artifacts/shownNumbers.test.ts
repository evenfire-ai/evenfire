import { describe, expect, it } from 'vitest'
import {
  builtinFormatCode,
  isModelledFormatCode,
  renderCount,
  shownForms,
  showsNumber,
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

  it.each([
    '[$-409]yyyy-mm-dd',
    '[$€-407]#,##0',
    '[$-de-DE]dd.mm.yyyy',
    '[$USD-409]0',
    '[$€]0',
    '[$€-x-euro2] #,##0.00',
    '#,##0.00 [$€-x-euro1]',
  ])('reads %s, a currency or a plain locale', code => {
    expect(isModelledFormatCode(code)).toBe(true)
  })

  it('reads built-in 47 as Excel shows it', () => {
    expect(builtinFormatCode(47)).toBe('mm:ss.0')
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
    ['a system date by a padded id', '[$-0F800]dddd'],
    ['the Thai Buddhist calendar by id', '[$-1070000]yyyy-mm-dd'],
    ['the Thai Buddhist calendar by tag', '[$-th-TH,107]yyyy-mm-dd'],
    ['native digits by id', '[$-D000409]0'],
    ['Japanese era years', '[$-ja-JP-x-gannen]ggge'],
    ['a numbering extension', '[$-th-TH-u-nu-thai]0'],
    ['native digits', '[DBNum1]0'],
    ['another calendar', '[B2]yyyy'],
    ['a code over 255 characters', `"${'x'.repeat(260)}"0`],
    ['nothing', ''],
  ])('does not read %s', (_label, code) => {
    expect(isModelledFormatCode(code)).toBe(false)
  })
})

describe('shownForms', () => {
  it('shows a date serial as its date in the code', () => {
    expect(shownForms(JAN_2_2026, 'yyyy-mm-dd')).toContain('2026-01-02')
    expect(shownForms(JAN_2_2026, 'dd/mm/yyyy')).toContain('02/01/2026')
    expect(shownForms(46024.62783564815, 'yyyy-mm-dd hh:mm:ss')).toContain('2026-01-02 15:04:05')
  })

  it('shows a built-in short date in the patterns locales use', () => {
    const forms = shownForms(JAN_2_2026, 'mm-dd-yy', true)
    for (const shown of ['1/2/2026', '2/1/2026', '02.01.2026', '2026-01-02']) {
      expect(forms).toContain(shown)
    }
  })

  it('shows grouped digits, and quoted text beside them', () => {
    expect(shownForms(3141592653, '#,##0')).toEqual(['3,141,592,653'])
    expect(shownForms(123456, '"sk-"0')).toEqual(['sk-123456'])
  })

  it('shows month names in other languages', () => {
    const forms = shownForms(JAN_2_2026, 'mmm d, yyyy')
    expect(forms).toEqual(expect.arrayContaining(['Jan 2, 2026', 'janv. 2, 2026', 'ene 2, 2026']))
  })
})

describe('showsNumber', () => {
  it.each([
    ['grouped with commas', '3,141,592,653', '3141592653'],
    ['grouped the German way', '3.141.592.653', '3141592653'],
    ['grouped with apostrophes', "3'141'592'653", '3141592653'],
    ['grouped with narrow spaces', '3\u202f141\u202f592\u202f653', '3141592653'],
    ['grouped the Indian way', '3,14,15,92,653', '3141592653'],
    ['before a decimal part', '3,141,592,653.00', '3141592653'],
    ['written in blocks, as a card number is', 'Card 4111 1111 1111 1111', '4111111111111111'],
    ['inside a longer grouped number', 'Q1 15,432 units', '5432'],
    ['after a decimal point', '0.1234', '1234'],
    ['as the secret writes it, separators and all', '1,234.50', '1.234,50'],
    ['in blocks set apart by hyphens', 'Card 4111-1111-1111-1111', '4111111111111111'],
    ['in blocks set apart by slashes', '4111/1111/1111/1111', '4111111111111111'],
    [
      'in blocks set apart by thin spaces',
      '4111\u20091111\u20091111\u20091111',
      '4111111111111111',
    ],
    ['in fullwidth digits', '\uff14\uff11\uff11\uff11 1111 1111 1111', '4111111111111111'],
    ['in more blocks than a number groups', '4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', '4111111111111111'],
    ['as a date with periods', '02.01.2026', '02012026'],
    ['with its sign', '-12,345,678', '-12345678'],
    ['without its sign', '12,345,678', '-12345678'],
    ['after the text the secret starts with', 'Key sk-123,456', 'sk-123456'],
    ['before the text the secret ends with', '123 456 USD', '123456 USD'],
  ])('finds a number shown %s', (_label, text, secret) => {
    expect(showsNumber(text, secret)).toBe(true)
  })

  it.each([
    ['across a decimal point', '54.32%', '5432'],
    ['from a value that rounds elsewhere', '3,141,592,652.6', '3141592653'],
    ['across two numbers in a list', '54, 32', '5432'],
    ['in a secret whose digits letters split', 'ab12cd34', 'ab12cd34'],
    ['without the text the secret starts with', '123,456', 'sk-123456'],
    ['after other text', 'pk-123,456', 'sk-123456'],
    ['before other text', '123,456 EUR', '123456 USD'],
    ['in blocks that spell a longer number', '4111 1111 1111 11112', '4111111111111111'],
  ])('does not read a number %s', (_label, text, secret) => {
    expect(showsNumber(text, secret)).toBe(false)
  })

  it('passes over a long list of numbers that cannot hold the secret without reading it', () => {
    // Reading every stretch of a million numbers takes seconds.
    const text = Array.from({ length: 1_000_000 }, (_, i) => String(100 + (i % 900))).join(' ')
    const started = Date.now()
    expect(showsNumber(text, '987654321012')).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('renderCount', () => {
  it.each([
    ['#,##0', false, 1],
    ['mmm d, yyyy', false, 4],
    ['mm-dd-yy', true, 14],
    ['m/d/yy h:mm', true, 84],
  ])('renders %s (short date %s) %i times', (code, shortDate, count) => {
    expect(renderCount(code, shortDate)).toBe(count)
  })
})
