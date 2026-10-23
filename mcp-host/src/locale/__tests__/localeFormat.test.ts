// Dates in the host's zone by IANA rules, and numbers as its language writes them.
import { describe, expect, it } from 'vitest'
import { writtenDate, writtenNumber, zonedTimestamp } from '../localeFormat'

describe('writtenDate', () => {
  it('dates an instant near midnight by the host zone', () => {
    const at = new Date('2026-03-08T05:30:00Z')
    expect(writtenDate({ language: 'es-ES', timeZone: 'Europe/Madrid' }, at)).toBe(
      '8 de marzo de 2026'
    )
    expect(writtenDate({ language: 'es-MX', timeZone: 'America/Mexico_City' }, at)).toBe(
      '7 de marzo de 2026'
    )
  })

  it('dates by the daylight-saving offset in force, not a fixed one', () => {
    // 00:30 in Madrid once summer time has started (UTC+2); a fixed +01:00 would say the 29th.
    const at = new Date('2026-03-29T22:30:00Z')
    expect(writtenDate({ language: 'es-ES', timeZone: 'Europe/Madrid' }, at)).toBe(
      '30 de marzo de 2026'
    )
  })

  it('follows the regional form of the language', () => {
    const at = new Date('2026-10-22T12:00:00Z')
    expect(writtenDate({ language: 'en-GB', timeZone: 'Europe/London' }, at)).toBe(
      '22 October 2026'
    )
    expect(writtenDate({ language: 'en', timeZone: 'UTC' }, at)).toBe('October 22, 2026')
  })
})

describe('zonedTimestamp', () => {
  it('jumps the spring-forward gap by IANA rules', () => {
    // US clocks go from 02:00 to 03:00 on 8 March 2026, EU clocks on 29 March.
    expect(zonedTimestamp('America/New_York', new Date('2026-03-08T06:59:59Z'))).toBe(
      '2026-03-08T01:59:59-05:00'
    )
    expect(zonedTimestamp('America/New_York', new Date('2026-03-08T07:00:00Z'))).toBe(
      '2026-03-08T03:00:00-04:00'
    )
    expect(zonedTimestamp('Europe/Madrid', new Date('2026-03-29T00:59:59Z'))).toBe(
      '2026-03-29T01:59:59+01:00'
    )
    expect(zonedTimestamp('Europe/Madrid', new Date('2026-03-29T01:00:00Z'))).toBe(
      '2026-03-29T03:00:00+02:00'
    )
  })

  it('tells the repeated hour of a fall-back apart by its offset', () => {
    // EU clocks go back from 03:00 to 02:00 on 25 October 2026.
    expect(zonedTimestamp('Europe/Madrid', new Date('2026-10-25T00:30:00Z'))).toBe(
      '2026-10-25T02:30:00+02:00'
    )
    expect(zonedTimestamp('Europe/Madrid', new Date('2026-10-25T01:30:00Z'))).toBe(
      '2026-10-25T02:30:00+01:00'
    )
  })

  it('crosses midnight by the zone and always writes 25 characters', () => {
    expect(zonedTimestamp('Asia/Kolkata', new Date('2026-03-07T18:45:00Z'))).toBe(
      '2026-03-08T00:15:00+05:30'
    )
    expect(zonedTimestamp('UTC', new Date('2026-03-07T23:59:59.999Z'))).toBe(
      '2026-03-07T23:59:59+00:00'
    )
    expect(zonedTimestamp('Pacific/Chatham', new Date('2026-01-01T00:00:00Z'))).toBe(
      '2026-01-01T13:45:00+13:45'
    )
  })
})

describe('writtenNumber', () => {
  it('writes the digits, grouping and decimal mark of the regional form', () => {
    expect(writtenNumber(1234567.5, 'es-MX')).toBe('1,234,567.5')
    expect(writtenNumber(1234567.5, 'es')).toBe('1.234.567,5')
    expect(writtenNumber(1234567, 'en-IN')).toBe('12,34,567')
    expect(writtenNumber(1234567, 'ar-EG')).toBe('١٬٢٣٤٬٥٦٧')
  })
})
