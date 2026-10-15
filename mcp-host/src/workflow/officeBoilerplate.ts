/**
 * Text every package a document generator writes carries whatever its
 * arguments: theme and font names, namespaces, part and style names, the
 * generators' own labels. A protected value found in such text cannot be told
 * apart from it, so the delivered-package scan leaves that value to the check
 * of the arguments. Built once per format from a package the generator writes
 * with neutral content, so it follows the generators as they change.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { officePackageTexts } from '../artifacts/officePackageText'
import { logger } from '../logger'
import type { InternalToolResult } from './types'

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'

type Runner = (args: Record<string, unknown>, outputDir: string) => Promise<InternalToolResult>

/** Each format's generator and a call that uses its layouts, with content too short to be a protected value. */
const SAMPLES: Record<
  OfficeFormat,
  { load: () => Promise<Runner>; args: Record<string, unknown> }
> = {
  docx: {
    load: async () => (await import('./docxGenerator')).runGenerateDocx,
    args: {
      filename: 'b.docx',
      title: 'x',
      body:
        '# x\n\nx **x** *x* `x` [x](https://x.y)\n\n- x\n  - x\n\n1. x\n\n| a | b |\n|---|--:|\n| x | 1 |\n\n' +
        '> x\n\n```\nx\n```',
      tables: [{ headers: ['a'], rows: [['x']] }],
    },
  },
  xlsx: {
    load: async () => (await import('./xlsxGenerator')).runGenerateXlsx,
    args: {
      filename: 'b.xlsx',
      sheets: [
        {
          name: 'x',
          titleRow: { text: 'x' },
          rows: [
            ['a', 'b', 'c'],
            ['x', 1, 0.5],
            ['y', 2, 0.25],
          ],
          columnFormats: { b: 'currency', c: 'percent' },
          conditionalFormatting: [
            { column: 'b', rules: [{ greaterThan: 1, fillColor: '#dcfce7' }] },
          ],
        },
      ],
    },
  },
  pptx: {
    load: async () => (await import('./pptxGenerator')).runGeneratePptx,
    args: {
      filename: 'b.pptx',
      title: 'x',
      slides: [
        { layout: 'cover', title: 'x', subtitle: 'x' },
        { layout: 'section', title: 'x' },
        { layout: 'title-bullets', title: 'x', bullets: ['x'] },
        { layout: 'kpis', title: 'x', kpis: [{ label: 'x', value: '1' }] },
        { layout: 'title-table', title: 'x', table: { headers: ['a'], rows: [['x']] } },
        {
          layout: 'title-chart',
          title: 'x',
          chart: { type: 'bar', labels: ['a'], datasets: [{ label: 'x', data: [1] }] },
        },
        {
          layout: 'title-chart',
          title: 'x',
          chart: { type: 'pie', labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2] }] },
        },
        {
          layout: 'title-chart',
          title: 'x',
          chart: { type: 'line', labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2] }] },
        },
        { layout: 'quote', quote: { text: 'x', attribution: 'x' } },
      ],
    },
  },
}

/** How long a call waits for the reference before checking without it. */
export const REFERENCE_WAIT_MS = 10_000

const references = new Map<OfficeFormat, Promise<string[]>>()

/**
 * The texts a package of `format` holds on its own. Empty when the sample
 * cannot be written, or is not ready within REFERENCE_WAIT_MS, which leaves
 * the scan as strict as before. A failed build is tried again on the next
 * call.
 */
export function boilerplateTexts(format: OfficeFormat): Promise<string[]> {
  let reference = references.get(format)
  if (!reference) {
    reference = writeSample(format).catch((err: unknown) => {
      references.delete(format)
      logger.warn(
        {
          component: 'OfficeBoilerplate',
          format,
          error: err instanceof Error ? err.name : typeof err,
        },
        'Could not build the reference package; protected values are checked against all its text'
      )
      return []
    })
    references.set(format, reference)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<string[]>(resolve => {
    timer = setTimeout(() => {
      logger.warn(
        { component: 'OfficeBoilerplate', format },
        'The reference package is not ready; protected values are checked against all its text'
      )
      resolve([])
    }, REFERENCE_WAIT_MS)
    timer.unref?.()
  })
  return Promise.race([reference, waited]).finally(() => clearTimeout(timer))
}

/** When a package was written, which its document properties hold. */
const WRITE_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

/**
 * `text` without the times a generator stamps on the package it writes. They
 * are no part of the reference, which no other package shares them with, and
 * no part of what a delivered package is checked for: the generator wrote
 * them, not the arguments.
 */
export function withoutWriteTimes(text: string): string {
  return text.replace(WRITE_TIME, '\u0000')
}

async function writeSample(format: OfficeFormat): Promise<string[]> {
  const sample = SAMPLES[format]
  const run = await sample.load()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-boilerplate-'))
  try {
    const result = await run(sample.args, dir)
    if (!result.success || !result.artifact) throw new Error(result.error ?? 'no artifact')
    const texts = officePackageTexts(fs.readFileSync(result.artifact.path))
    if (!texts) throw new Error('the reference package could not be read')
    return texts.map(withoutWriteTimes)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
