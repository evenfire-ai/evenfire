/**
 * Every document tool writes in the host's language and dates by the host's
 * time zone (Host spec.locale): the same instant near midnight is the 8th in
 * Madrid and the 7th in Mexico City, whatever zone the server runs in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PDFDocument } from 'pdf-lib'
import { applyHostLocale } from '../../locale/hostLocale'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolResult } from '../types'
import { allText, readPdf } from './support/pdfText'
import { slideXml } from './support/pptxXml'
import { zipEntries } from './support/zipEntries'

const MADRID = { language: 'es-ES', timeZone: 'Europe/Madrid' }
const MEXICO_CITY = { language: 'es-MX', timeZone: 'America/Mexico_City' }
// 06:30 in Madrid on the 8th, 23:30 in Mexico City on the 7th.
const NEAR_MIDNIGHT = new Date('2026-03-08T05:30:00Z')

let outputDir: string

async function generate(
  format: string,
  args: Record<string, unknown>
): Promise<InternalToolResult & { file: string }> {
  const tool = INTERNAL_TOOLS.find(t => t.name === `clerum__generate_${format}`)
  if (!tool) throw new Error(`clerum__generate_${format} is not registered`)
  const result = await tool.execute(args, outputDir)
  expect(result.success, result.error).toBe(true)
  return { ...result, file: result.artifact!.path }
}

function entryText(file: string, pattern: RegExp): string {
  const entries = zipEntries(file)
  return [...entries.keys()]
    .filter(name => pattern.test(name))
    .map(name => entries.get(name)!.toString('utf8'))
    .join('\n')
}

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-host-locale-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NEAR_MIDNIGHT)
})

afterEach(() => {
  vi.useRealTimers()
  applyHostLocale(undefined)
  fs.rmSync(outputDir, { recursive: true, force: true })
})

describe('documents in the host language and time zone', () => {
  it('dates a PDF cover by the host zone near midnight', async () => {
    for (const [locale, day] of [
      [MADRID, '8 de marzo de 2026'],
      [MEXICO_CITY, '7 de marzo de 2026'],
    ] as const) {
      applyHostLocale(locale)
      const { file } = await generate('pdf', {
        filename: `portada-${locale.language}.pdf`,
        coverPage: true,
        body: 'Texto.',
      })
      expect(allText(await readPdf(file)).replace(/\s+/g, ' ')).toContain(day)
      // An untitled document is titled in the host language.
      expect((await PDFDocument.load(fs.readFileSync(file))).getTitle()).toBe('Informe')
    }
  })

  it('dates a slide deck by the daylight-saving offset in force', async () => {
    // 00:30 in Madrid on the 30th once summer time has started; a fixed +01:00 would say the 29th.
    vi.setSystemTime(new Date('2026-03-29T22:30:00Z'))
    applyHostLocale(MADRID)
    const { file } = await generate('pptx', {
      filename: 'portada.pptx',
      slides: [{ layout: 'cover', title: 'Revisión' }],
    })
    expect(slideXml(file, 1)).toContain('30 de marzo de 2026')
  })

  it('writes the slide templates in the host language', async () => {
    applyHostLocale(MEXICO_CITY)
    const { file } = await generate('pptx', {
      filename: 'incidente.pptx',
      template: 'incident-review',
      data: {
        title: 'Caída del API',
        severity: 'critical',
        summary: 'El API no respondió durante 20 minutos.',
        rootCause: 'Un certificado vencido.',
      },
    })
    const cover = slideXml(file, 1)
    expect(cover).toContain('CRÍTICA')
    expect(cover).toContain('7 de marzo de 2026')
    expect(slideXml(file, 2)).toContain('Resumen')
    expect(slideXml(file, 3)).toContain('Causa raíz')
  })

  it('groups an amount as the regional form writes it', async () => {
    const amounts: Array<[typeof MADRID, string]> = [
      [MADRID, '12.000.000.000'],
      [MEXICO_CITY, '12,000,000,000'],
    ]
    for (const [locale, amount] of amounts) {
      applyHostLocale(locale)
      const { file } = await generate('pptx', {
        filename: `ronda-${locale.language}.pptx`,
        template: 'pitch-deck',
        data: {
          company: 'Acme',
          tagline: 'Facturas sin errores',
          problem: 'Errores manuales.',
          solution: 'Automatización.',
          marketSize: { value: 12000000000 },
        },
      })
      const market = slideXml(file, 4)
      expect(market).toContain('Tamaño del mercado')
      expect(market).toContain(amount)
    }
  })

  it('labels DOCX pages and an untitled document in the host language', async () => {
    applyHostLocale(MADRID)
    const { file } = await generate('docx', { filename: 'informe.docx', body: 'Texto.' })
    expect(entryText(file, /^word\/footer\d*\.xml$/)).toContain('Página ')
    expect(entryText(file, /^docProps\/core\.xml$/)).toContain('<dc:title>Informe</dc:title>')
  })

  it('names an unnamed sheet the way Excel does in the host language', async () => {
    applyHostLocale(MADRID)
    const { file } = await generate('xlsx', {
      filename: 'datos.xlsx',
      sheets: [
        {
          rows: [
            ['Mes', 'Total'],
            ['enero', 3],
          ],
        },
      ],
    })
    expect(entryText(file, /^xl\/workbook\.xml$/)).toContain('name="Hoja1"')
  })

  it('writes a dashboard in the host language and dates it by the host zone', async () => {
    applyHostLocale(MEXICO_CITY)
    const { file } = await generate('dashboard', {
      filename: 'panel.html',
      template: 'operations-pulse',
      data: {
        title: 'Operaciones',
        status: 'green',
        kpis: [{ label: 'Ingresos', value: 1234567.5, sparkline: [1, 2, 3] }],
        services: [{ name: 'API', status: 'down' }],
        incidents: [{ time: '10:42', title: 'Errores 500', severity: 'critical' }],
        charts: [{ type: 'bar', labels: ['enero'], datasets: [{ label: 'Ventas', data: [4] }] }],
      },
    })
    const html = fs.readFileSync(file, 'utf8')
    expect(html).toContain('<html lang="es-MX">')
    expect(html).toContain('1,234,567.5')
    expect(html).toContain('VERDE')
    expect(html).toContain('CAÍDO')
    expect(html).toContain('CRÍTICA')
    expect(html).toContain('abierto')
    expect(html).toContain('Estado de los servicios')
    expect(html).toContain('Tendencias de rendimiento')
    expect(html).toContain('7 de marzo de 2026')
    expect(html).toContain('"locale":"es-MX"')
    expect(html).toContain('No se pudo dibujar la tendencia')
  })

  it('runs a dashboard right to left in a right-to-left language only', async () => {
    const page = async (language: string) => {
      applyHostLocale({ language })
      const { file } = await generate('dashboard', {
        filename: `dir-${language}.html`,
        data: { title: 'Panel', kpis: [{ label: 'a', value: 1, delta: 2 }] },
      })
      return fs.readFileSync(file, 'utf8')
    }
    expect(await page('ar')).toContain('<html lang="ar" dir="rtl">')
    expect(await page('es-MX')).toContain('<html lang="es-MX">')
  })

  it('dates a footer timestamp in the host zone and keeps a calendar day on its day', async () => {
    const dated = async (date: unknown) => {
      const { file } = await generate('dashboard', {
        filename: `pie-${String(date).replace(/[:.]/g, '-')}.html`,
        data: { title: 'Panel', kpis: [{ label: 'Pedidos', value: 3 }], meta: { date } },
      })
      return fs.readFileSync(file, 'utf8')
    }
    applyHostLocale(MADRID)
    // 23:30 UTC on the 7th is 00:30 on the 8th in Madrid.
    expect(await dated(Date.parse('2026-03-07T23:30:00Z') / 1000)).toContain('8 de marzo de 2026')
    expect(await dated('2026-03-07T23:30:00Z')).toContain('8 de marzo de 2026')
    expect(await dated('2026-03-07')).toContain('7 de marzo de 2026')
    expect(await dated('2026-02-30')).toContain('2026-02-30')
    // Past the range of a date, a number is shown as written rather than failing the page.
    expect(await dated(1729555200000000000)).toContain('1729555200000000000')
    // Midnight UTC stands for a day, which a zone behind UTC must not move to the 6th.
    applyHostLocale(MEXICO_CITY)
    expect(await dated('2026-03-07T00:00:00Z')).toContain('7 de marzo de 2026')
    // A host without a locale shows a timestamp as written, as before.
    applyHostLocale(undefined)
    expect(await dated('2026-03-07T23:30:00Z')).toContain('2026-03-07T23:30:00Z')
  })

  it('writes the numbers the dashboard prints itself in the host language', async () => {
    applyHostLocale(MADRID)
    const page = async (inlineChartJs: boolean) => {
      const { file } = await generate('dashboard', {
        filename: `cifras-${inlineChartJs}.html`,
        inlineChartJs,
        data: {
          title: 'Panel',
          kpis: [{ label: 'Pedidos', value: 12345 }],
          charts: [
            { type: 'gauge', title: 'SLA', labels: ['SLA'], datasets: [{ data: [72.5] }] },
            { type: 'bar', labels: ['enero'], datasets: [{ label: 'Ventas', data: [1234567.5] }] },
          ],
        },
      })
      return fs.readFileSync(file, 'utf8')
    }
    expect(await page(true)).toContain('"gauge":{"value":"72,5","max":"100"}')
    const tables = await page(false)
    expect(tables).toContain('<td>72,5</td>')
    expect(tables).toContain('<td>1234567,5</td>')
    expect(tables).toContain('12.345')
  })

  it("keeps a year whole in the host's words for it", async () => {
    applyHostLocale({ language: 'de' })
    const { file } = await generate('dashboard', {
      filename: 'jahr.html',
      data: {
        title: 'Bericht',
        kpis: [
          { label: 'Geschäftsjahr', value: 2026 },
          { label: 'Kunden', value: 2026 },
        ],
      },
    })
    const html = fs.readFileSync(file, 'utf8')
    expect(html).toContain('>2026</p>')
    expect(html).toContain('>2.026</p>')
  })

  it("capitalizes the host's own words by its rules and the model's by the default ones", async () => {
    applyHostLocale({ language: 'tr' })
    const { file } = await generate('dashboard', {
      filename: 'durum.html',
      template: 'operations-pulse',
      data: {
        title: 'Durum',
        services: [
          { name: 'API', status: 'online' },
          { name: 'Arama', status: 'down' },
        ],
      },
    })
    const html = fs.readFileSync(file, 'utf8')
    expect(html).toContain('>ONLINE</p>')
    expect(html).toContain('>KESİNTİ</p>')
    const deck = await generate('pptx', {
      filename: 'durum.pptx',
      template: 'quarterly-review',
      data: { title: 'Q3', period: 'Q3 2026', outlook: ['Büyüme'] },
    })
    expect(slideXml(deck.file, 2)).toContain('İLERİYE BAKIŞ')
  })

  it('marks slide text in the host language for spell checking', async () => {
    const tags = async (language: string | undefined) => {
      applyHostLocale(language ? { language } : undefined)
      const { file } = await generate('pptx', {
        filename: `prueba-${language ?? 'none'}.pptx`,
        slides: [{ layout: 'title-bullets', title: 'Resumen', bullets: ['Texto del informe'] }],
      })
      // The tags of the runs that hold words; a page number has none to check.
      const runs = [...slideXml(file, 1).matchAll(/<a:r>(.*?)<\/a:r>/gs)].map(m => m[1])
      const worded = runs.filter(run => /<a:t>[^<]*\p{L}/u.test(run))
      return [...new Set(worded.map(run => /lang="([^"]+)"/.exec(run)?.[1]))]
    }
    expect(await tags('es-MX')).toEqual(['es-MX'])
    expect(await tags('de')).toEqual(['de-DE'])
    expect(await tags(undefined)).toEqual(['en-US'])
    expect(await tags('ja')).toEqual(['en-US'])
  })

  it('tags right-to-left text in the host language, page label included', async () => {
    // The runs that hold `word`, with their properties.
    const runsWith = (xml: string, open: string, close: string, word: string) =>
      xml
        .split(open)
        .slice(1)
        .map(run => run.split(close)[0])
        .filter(run => run.includes(word))
    const tags = async (language: string | undefined) => {
      applyHostLocale(language ? { language } : undefined)
      const docx = await generate('docx', {
        filename: `informe-${language ?? 'none'}.docx`,
        body: 'فروش رشد کرد.',
      })
      const body = runsWith(
        entryText(docx.file, /^word\/document\.xml$/),
        '<w:r>',
        '</w:r>',
        'فروش'
      )
      const pptx = await generate('pptx', {
        filename: `informe-${language ?? 'none'}.pptx`,
        slides: [{ layout: 'title-bullets', title: 'خلاصه', bullets: ['فروش رشد کرد'] }],
      })
      const slide = runsWith(slideXml(pptx.file, 1), '<a:r>', '</a:r>', 'فروش')
      return {
        docx: [...new Set(body.map(run => /w:bidi="([^"]+)"/.exec(run)?.[1]))],
        pptx: [...new Set(slide.map(run => /lang="([^"]+)"/.exec(run)?.[1]))],
        footer: entryText(docx.file, /^word\/footer\d*\.xml$/),
      }
    }
    const persian = await tags('fa')
    expect(persian.docx).toEqual(['fa-IR'])
    expect(persian.pptx).toEqual(['fa-IR'])
    // The label and the page numbers after it run right to left together,
    // or Word reads the numbers in the wrong order.
    const label = runsWith(persian.footer, '<w:r>', '</w:r>', 'صفحه')
    const numbers = runsWith(persian.footer, '<w:r>', '</w:r>', 'PAGE')
    expect(label).toHaveLength(1)
    expect(numbers).toHaveLength(2)
    for (const run of [...label, ...numbers]) {
      expect(run).toContain('<w:rtl/>')
      expect(run).toContain('w:bidi="fa-IR"')
    }
    // Without a host language, or in another script's, the letters decide.
    for (const language of [undefined, 'he']) {
      const other = await tags(language)
      expect(other.docx).toEqual(['ar-SA'])
      expect(other.pptx).toEqual(['ar-SA'])
    }
    const english = runsWith((await tags(undefined)).footer, '<w:r>', '</w:r>', 'PAGE')
    expect(english).toHaveLength(2)
    for (const run of english) expect(run).not.toContain('<w:rtl/>')
  })

  it('draws chart text in the host language', async () => {
    applyHostLocale(MADRID)
    const values = await generate('chart', {
      filename: 'ventas.png',
      type: 'bar',
      data: { labels: ['enero'], datasets: [{ label: 'Ventas', data: [1234567.5] }] },
      valueFormat: 'plain',
    })
    expect(values.shownText).toContain('1.234.567,5')
    const empty = await generate('chart', {
      filename: 'vacio.png',
      type: 'bar',
      data: { labels: ['enero'], datasets: [{ label: 'Ventas', data: [0] }] },
    })
    expect(empty.shownText).toContain('No hay datos para mostrar')
  })

  it('records the language and time zone of every generated file', async () => {
    applyHostLocale(MEXICO_CITY)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['markdown', { filename: 'nota.md', content: '# Nota' }],
      ['pdf', { filename: 'nota.pdf', body: 'Texto.' }],
      ['docx', { filename: 'nota.docx', body: 'Texto.' }],
      ['xlsx', { filename: 'nota.xlsx', sheets: [{ name: 'Datos', rows: [['a'], [1]] }] }],
      ['pptx', { filename: 'nota.pptx', slides: [{ layout: 'cover', title: 'Nota' }] }],
      [
        'chart',
        { filename: 'nota.png', type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] } },
      ],
      [
        'dashboard',
        { filename: 'nota.html', data: { title: 'Nota', kpis: [{ label: 'a', value: 1 }] } },
      ],
    ]
    for (const [format, args] of calls) {
      const { artifact } = await generate(format, args)
      expect(artifact, format).toMatchObject({
        language: 'es-MX',
        timeZone: 'America/Mexico_City',
      })
    }
  })
})
