/**
 * Dates and numbers as a host's readers write them. Every date is computed in
 * the host's time zone with IANA rules (daylight saving included), never in the
 * server's.
 */

interface Zoned {
  language: string
  timeZone: string
}

const formats = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>()

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(key: string, make: () => T): T {
  let f = formats.get(key) as T | undefined
  if (!f) {
    f = make()
    if (formats.size >= 256) formats.clear()
    formats.set(key, f)
  }
  return f
}

const LONG_DATE = { year: 'numeric', month: 'long', day: 'numeric' } as const

/** The day `at` falls on in the host's zone, as its language writes it ("21 de octubre de 2026"). */
export function writtenDate(locale: Zoned, at: Date = new Date()): string {
  return cached(
    `date|${locale.language}|${locale.timeZone}`,
    () => new Intl.DateTimeFormat(locale.language, { ...LONG_DATE, timeZone: locale.timeZone })
  ).format(at)
}

/** `at` in the host's zone with its offset, for the model: 2026-10-21T20:05:09-06:00 (always 25 characters). */
export function zonedTimestamp(timeZone: string, at: Date = new Date()): string {
  const parts = cached(
    `iso|${timeZone}`,
    () =>
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
  ).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(p => p.type === type)?.value ?? '00'
  const wall = Date.UTC(
    Number(part('year')),
    Number(part('month')) - 1,
    Number(part('day')),
    Number(part('hour')),
    Number(part('minute')),
    Number(part('second'))
  )
  const offset = Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${zone}`
}

/** A number as the host's language writes it: its digits, grouping and decimal mark. */
export function writtenNumber(
  n: number,
  language: string,
  options: Intl.NumberFormatOptions = {}
): string {
  return cached(
    `number|${language}|${JSON.stringify(options)}`,
    () => new Intl.NumberFormat(language, options)
  ).format(n)
}
