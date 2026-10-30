import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import JSZip from 'jszip'
import * as os from 'os'
import * as path from 'path'
import { officePackageHasText } from '../../../artifacts/officePackageText'
import { zipEntries } from '../../../workflow/__tests__/support/zipEntries'
import { INTERNAL_TOOLS } from '../../../workflow/internalTools'
import type { ArtifactMetadata } from '../../../workflow/types'
import { CALLER_OUTPUTS_DIR } from '../../../workspace/callerOutputs'
import type { Attachment } from '../../types'
import {
  INTERNAL_GENERATED_ARTIFACT_LANE,
  buildGeneratedArtifactAttachment,
  isInternalGeneratedArtifactAttachment,
} from '../generatedArtifactAttachments'
import { NativeToolRegistry } from '../nativeToolRegistry'

const MIME_BY_FORMAT = new Map([
  ['md', 'text/markdown'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['png', 'image/png'],
])
const b64 = ['base', '64'].join('') as BufferEncoding
const dataKey = ('data' + 'Base' + '64') as 'dataBase64'

function metadata(
  outputDir: string,
  name: string,
  format: ArtifactMetadata['format']
): ArtifactMetadata {
  const filePath = path.join(outputDir, name)
  return {
    name,
    format,
    path: filePath,
    sizeBytes: fs.statSync(filePath).size,
    createdAt: new Date().toISOString(),
  }
}

function decoded(attachment: Attachment): Buffer {
  return Buffer.from(attachment[dataKey], b64)
}

/** A minimal Office package whose one XML part holds `text`. */
function officePackage(text: string): Promise<Buffer> {
  return new JSZip()
    .file('[Content_Types].xml', '<Types/>')
    .file('part.xml', `<part>${text}</part>`)
    .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// statfs reports the volume sized to its free space, so the disk's occupancy
// never meets the free-space floor of the caller's folder.
vi.mock('fs', async original => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    statfsSync: (target: string, options: { bigint: true }) => {
      const reading = actual.statfsSync(target, options)
      return { ...reading, blocks: reading.bavail, bfree: reading.bavail }
    },
  }
})

describe('generated internal artifact attachments', () => {
  let outputDir: string
  // The chat caller the registries below generate for: a managed caller root
  // (`<host>/users/<key>`), whose own folder receives their files.
  let callerRoot: string
  let originalOutputDir: string | undefined

  beforeEach(() => {
    originalOutputDir = process.env.CLERUM_OUTPUT_DIR
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-generated-attachments-'))
    callerRoot = path.join(outputDir, 'host', 'users', 'caller-a')
    fs.mkdirSync(callerRoot, { recursive: true })
  })

  /** A chat registry generating for the test caller, with `secretEntriesProvider`'s protected values. */
  function chatRegistry(secretEntriesProvider?: () => Array<{ name: string; value: string }>) {
    return new NativeToolRegistry(
      {
        workspacePath: outputDir,
        shellTimeout: 5000,
        toolTimeout: 60000,
        toolProgressInterval: 30000,
        httpAllowlist: [],
        envAllowlist: ['PATH'],
        memoryMaxSize: 1048576,
      },
      'conv-1',
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      { maxBytes: 52_428_800, secretEntriesProvider },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      callerRoot
    )
  }

  /** A file the chat generators wrote for the test caller. */
  function generated(name: string): string {
    return path.join(callerRoot, CALLER_OUTPUTS_DIR, name)
  }

  afterEach(() => {
    if (originalOutputDir === undefined) delete process.env.CLERUM_OUTPUT_DIR
    else process.env.CLERUM_OUTPUT_DIR = originalOutputDir
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it.each([
    ['clerum__generate_markdown', 'report.md', 'md', Buffer.from('# Report\n')],
    ['clerum__generate_pdf', 'report.pdf', 'pdf', Buffer.from('%PDF-1.7\n%%EOF')],
    ['clerum__generate_docx', 'report.docx', 'docx', Buffer.from('PK docx bytes')],
    ['clerum__generate_xlsx', 'report.xlsx', 'xlsx', Buffer.from('PK xlsx bytes')],
    ['clerum__generate_pptx', 'report.pptx', 'pptx', Buffer.from('PK pptx bytes')],
    ['clerum__generate_chart', 'chart.png', 'png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ] as const)(
    'builds a %s attachment without using workflow_result provenance',
    (sourceTool, filename, format, body) => {
      fs.writeFileSync(path.join(outputDir, filename), body)

      const attachment = buildGeneratedArtifactAttachment({
        sourceTool,
        artifact: metadata(outputDir, filename, format),
        outputDir,
        maxBytes: 52_428_800,
      })

      expect(attachment).toMatchObject({
        kind: 'file',
        sourceTool,
        lane: INTERNAL_GENERATED_ARTIFACT_LANE,
        artifactFormat: format,
        filename,
        mimeType: MIME_BY_FORMAT.get(format),
        producer: 'mcp-host-internal-tool',
      })
      expect(attachment?.sourceTool).not.toBe('workflow_result')
      expect(decoded(attachment!)).toEqual(body)
      expect(isInternalGeneratedArtifactAttachment(attachment!)).toBe(true)
    }
  )

  it('redacts text artifacts before attachment encoding', () => {
    fs.writeFileSync(path.join(outputDir, 'report.md'), 'value=probe-redaction-value\n')

    const attachment = buildGeneratedArtifactAttachment({
      sourceTool: 'clerum__generate_markdown',
      artifact: metadata(outputDir, 'report.md', 'md'),
      outputDir,
      maxBytes: 52_428_800,
      secretEntriesProvider: () => [{ name: 'PROBE_VALUE', value: 'probe-redaction-value' }],
    })

    expect(attachment?.redactionState).toBe('applied')
    expect(decoded(attachment!).toString('utf8')).toBe('value=[REDACTED:PROBE_VALUE]\n')
  })

  it.each([
    ['clerum__generate_pdf', 'report.pdf', 'pdf', async () => Buffer.from('%PDF-1.7\n%%EOF')],
    ['clerum__generate_docx', 'report.docx', 'docx', () => officePackage('safe generated content')],
    ['clerum__generate_xlsx', 'report.xlsx', 'xlsx', () => officePackage('safe generated content')],
    ['clerum__generate_pptx', 'report.pptx', 'pptx', () => officePackage('safe generated content')],
    [
      'clerum__generate_chart',
      'chart.png',
      'png',
      async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ],
  ] as const)(
    'builds a %s binary attachment when the source payload has no configured secrets',
    async (sourceTool, filename, format, make) => {
      const body = await make()
      fs.writeFileSync(path.join(outputDir, filename), body)

      const attachment = buildGeneratedArtifactAttachment({
        sourceTool,
        artifact: metadata(outputDir, filename, format),
        outputDir,
        maxBytes: 52_428_800,
        sourcePayload: { content: 'safe generated content' },
        secretEntriesProvider: () => [{ name: 'PROBE_VALUE', value: 'probe-redaction-value' }],
      })

      expect(attachment).toMatchObject({
        kind: 'file',
        sourceTool,
        artifactFormat: format,
        filename,
        redactionState: 'skipped:binary',
      })
      expect(decoded(attachment!)).toEqual(body)
    }
  )

  it.each([
    ['clerum__generate_pdf', 'report.pdf', 'pdf', Buffer.from('%PDF-1.7\n%%EOF')],
    ['clerum__generate_docx', 'report.docx', 'docx', Buffer.from('PK docx bytes')],
    ['clerum__generate_xlsx', 'report.xlsx', 'xlsx', Buffer.from('PK xlsx bytes')],
    ['clerum__generate_pptx', 'report.pptx', 'pptx', Buffer.from('PK pptx bytes')],
    ['clerum__generate_chart', 'chart.png', 'png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ] as const)(
    'does not auto-attach %s binary artifacts when source payload is unavailable and secrets are configured',
    (sourceTool, filename, format, body) => {
      fs.writeFileSync(path.join(outputDir, filename), body)

      const attachment = buildGeneratedArtifactAttachment({
        sourceTool,
        artifact: metadata(outputDir, filename, format),
        outputDir,
        maxBytes: 52_428_800,
        secretEntriesProvider: () => [{ name: 'PROBE_VALUE', value: 'probe-redaction-value' }],
      })

      expect(attachment).toBeNull()
    }
  )

  it.each([
    ['clerum__generate_pdf', 'report.pdf', 'pdf', Buffer.from('%PDF-1.7\n%%EOF')],
    ['clerum__generate_docx', 'report.docx', 'docx', Buffer.from('PK docx bytes')],
    ['clerum__generate_xlsx', 'report.xlsx', 'xlsx', Buffer.from('PK xlsx bytes')],
    ['clerum__generate_pptx', 'report.pptx', 'pptx', Buffer.from('PK pptx bytes')],
    ['clerum__generate_chart', 'chart.png', 'png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ] as const)(
    'does not auto-attach %s binary artifacts when the source payload contains a configured secret',
    (sourceTool, filename, format, body) => {
      fs.writeFileSync(path.join(outputDir, filename), body)

      const attachment = buildGeneratedArtifactAttachment({
        sourceTool,
        artifact: metadata(outputDir, filename, format),
        outputDir,
        maxBytes: 52_428_800,
        sourcePayload: { content: 'probe-redaction-value' },
        secretEntriesProvider: () => [{ name: 'PROBE_VALUE', value: 'probe-redaction-value' }],
      })

      expect(attachment).toBeNull()
    }
  )

  it.each([
    ['clerum__generate_docx', 'report.docx', 'docx'],
    ['clerum__generate_xlsx', 'report.xlsx', 'xlsx'],
    ['clerum__generate_pptx', 'report.pptx', 'pptx'],
  ] as const)(
    'does not auto-attach a %s whose delivered text holds a secret its payload never spelled',
    async (sourceTool, filename, format) => {
      fs.writeFileSync(path.join(outputDir, filename), await officePackage('<v>3141592653</v>'))

      const attachment = buildGeneratedArtifactAttachment({
        sourceTool,
        artifact: metadata(outputDir, filename, format),
        outputDir,
        maxBytes: 52_428_800,
        sourcePayload: { cell: '3,141,592,653' },
        secretEntriesProvider: () => [{ name: 'PROBE_VALUE', value: '3141592653' }],
      })

      expect(attachment).toBeNull()
    }
  )

  it.each([
    ['clerum__generate_docx', 'report.docx', 'docx'],
    ['clerum__generate_xlsx', 'report.xlsx', 'xlsx'],
    ['clerum__generate_pptx', 'report.pptx', 'pptx'],
  ] as const)(
    'does not auto-attach a %s it cannot read while secrets are configured, and attaches it when none are',
    (sourceTool, filename, format) => {
      fs.writeFileSync(path.join(outputDir, filename), Buffer.from('PK not a package'))
      const params = {
        sourceTool,
        artifact: metadata(outputDir, filename, format),
        outputDir,
        maxBytes: 52_428_800,
        sourcePayload: { content: 'safe generated content' },
      }

      expect(
        buildGeneratedArtifactAttachment({
          ...params,
          secretEntriesProvider: () => [{ name: 'PROBE_VALUE', value: 'probe-redaction-value' }],
        })
      ).toBeNull()
      expect(buildGeneratedArtifactAttachment(params)).toMatchObject({ kind: 'file', filename })
    }
  )

  it('does not auto-attach unsupported or unsafe artifacts', () => {
    fs.writeFileSync(path.join(outputDir, 'dashboard.html'), '<html></html>')
    fs.writeFileSync(path.join(outputDir, 'report.pdf'), '%PDF')

    expect(
      buildGeneratedArtifactAttachment({
        sourceTool: 'clerum__generate_dashboard',
        artifact: metadata(outputDir, 'dashboard.html', 'html'),
        outputDir,
        maxBytes: 52_428_800,
      })
    ).toBeNull()
    expect(
      buildGeneratedArtifactAttachment({
        sourceTool: 'clerum__generate_pdf',
        artifact: metadata(outputDir, 'report.pdf', 'md'),
        outputDir,
        maxBytes: 52_428_800,
      })
    ).toBeNull()
    expect(
      buildGeneratedArtifactAttachment({
        sourceTool: 'clerum__generate_pdf',
        artifact: {
          ...metadata(outputDir, 'report.pdf', 'pdf'),
          name: '../report.pdf',
        },
        outputDir,
        maxBytes: 52_428_800,
      })
    ).toBeNull()
    expect(
      buildGeneratedArtifactAttachment({
        sourceTool: 'clerum__generate_pdf',
        artifact: metadata(outputDir, 'report.pdf', 'pdf'),
        outputDir,
        maxBytes: 3,
      })
    ).toBeNull()
  })

  it('rejects spoofed internal attachment metadata', () => {
    const base: Attachment = {
      id: 'att',
      kind: 'file',
      mimeType: 'application/pdf',
      encoding: ['base', '64'].join('') as Attachment['encoding'],
      [dataKey]: Buffer.from('%PDF').toString(b64),
      filename: 'report.pdf',
      sourceTool: 'clerum__generate_pdf',
      lane: INTERNAL_GENERATED_ARTIFACT_LANE,
      artifactFormat: 'pdf',
      producer: 'mcp-host-internal-tool',
    } as Attachment

    expect(isInternalGeneratedArtifactAttachment(base)).toBe(true)
    expect(isInternalGeneratedArtifactAttachment({ ...base, producer: undefined })).toBe(false)
    expect(isInternalGeneratedArtifactAttachment({ ...base, lane: undefined })).toBe(false)
    expect(isInternalGeneratedArtifactAttachment({ ...base, sourceTool: 'workflow_result' })).toBe(
      false
    )
    expect(isInternalGeneratedArtifactAttachment({ ...base, mimeType: 'text/html' })).toBe(false)
    expect(isInternalGeneratedArtifactAttachment({ ...base, filename: 'report.html' })).toBe(false)
  })

  it.each([
    ['an ANSI escape', 'probe-redaction\u001b[0m-value'],
    ['an HTML tag', 'probe-redaction<b></b>-value'],
    ['a character reference', 'probe&#45;redaction-value'],
    ['a zero-width space', 'probe-redaction\u200B-value'],
    ['markdown emphasis', 'probe-**redaction**-value'],
    ['a markdown link', 'probe-[redaction](https://a.example)-value'],
    ['a markdown link holding a reference', 'probe-[red&#97;ction](https://a.example)-value'],
    ['an image', 'probe-![redaction](missing.png)-value'],
  ])('does not attach a PDF that prints a secret split by %s', async (_label, body) => {
    const registry = chatRegistry(() => [{ name: 'PROBE_VALUE', value: 'probe-redaction-value' }])
    const pdf = registry.get('clerum__generate_pdf')!
    const leaked = await pdf.execute({ filename: 'split.pdf', body })
    expect(leaked.is_error).toBe(false)
    expect(leaked.attachments ?? []).toHaveLength(0)
    const safe = await pdf.execute({ filename: 'safe.pdf', body: 'nothing secret here' })
    expect(safe.attachments ?? []).toHaveLength(1)
  })

  it('does not attach a document whose arguments hold a secret with a quote or a backslash', async () => {
    const secret = 'probe"redac\\tion-value'
    const registry = chatRegistry(() => [{ name: 'PROBE_VALUE', value: secret }])
    const pdf = registry.get('clerum__generate_pdf')!
    const leaked = await pdf.execute({ filename: 'quoted.pdf', body: `value: ${secret}` })
    expect(leaked.is_error).toBe(false)
    expect(leaked.attachments ?? []).toHaveLength(0)
    // Control: the same registry attaches a document without the value.
    const safe = await pdf.execute({ filename: 'safe.pdf', body: 'value: none' })
    expect(safe.attachments ?? []).toHaveLength(1)
  })

  it('does not attach a DOCX whose table cell prints a secret a link splits', async () => {
    const registry = chatRegistry(() => [{ name: 'PROBE_VALUE', value: 'probe-redaction-value' }])
    const docx = registry.get('clerum__generate_docx')!
    const cell = 'probe-[redaction](https://a.example)-value'
    const leaked = await docx.execute({
      filename: 'split.docx',
      body: 'Table:',
      tables: [{ headers: ['Value'], rows: [[cell]] }],
    })
    expect(leaked.is_error).toBe(false)
    expect(leaked.attachments ?? []).toHaveLength(0)
    // Witness: the file the generator wrote prints the value whole.
    const written = fs.readFileSync(generated('split.docx'))
    expect(officePackageHasText(written, text => text.includes('probe-redaction-value'))).toBe(true)
    // Control: the same registry attaches a table without the value.
    const safe = await docx.execute({
      filename: 'safe.docx',
      body: 'Table:',
      tables: [{ headers: ['Value'], rows: [['nothing secret']] }],
    })
    expect(safe.attachments ?? []).toHaveLength(1)
  })

  describe('XLSX record keys, which the sheet prints as its header', () => {
    const protectedValue = 'probe-redaction-value'

    function xlsxTool() {
      const registry = chatRegistry(() => [{ name: 'PROBE_VALUE', value: protectedValue }])
      return registry.get('clerum__generate_xlsx')!
    }

    function sheetXml(file: string): string {
      return [...zipEntries(file)]
        .filter(([name]) => name.startsWith('xl/') && name.endsWith('.xml'))
        .map(([, data]) => data.toString('utf8'))
        .join('\n')
    }

    it('attaches a sheet whose keys hold no secret', async () => {
      const result = await xlsxTool().execute({
        filename: 'ordinary.xlsx',
        sheets: [{ name: 'S', rows: [{ Region: 'North', Total: 5 }] }],
      })
      expect(result.is_error).toBe(false)
      expect(result.attachments ?? []).toHaveLength(1)
      const attached = path.join(outputDir, 'attached.xlsx')
      fs.writeFileSync(attached, decoded(result.attachments![0]!))
      expect(sheetXml(attached)).toContain('Region')
    })

    it.each([
      ['as sent', protectedValue],
      ['split by a control character', 'probe-red\u0007action-value'],
      ['split by an ANSI escape', 'probe-red\u001b[31maction-value'],
      ['split by half a surrogate pair', 'probe-red\uD800action-value'],
    ])('does not attach a sheet whose key prints a secret %s', async (_label, key) => {
      const result = await xlsxTool().execute({
        filename: 'keyed.xlsx',
        sheets: [{ name: 'S', rows: [{ [key]: 'ordinary' }] }],
      })
      expect(result.is_error).toBe(false)
      expect(sheetXml(generated('keyed.xlsx'))).toContain(protectedValue)
      expect(result.attachments ?? []).toHaveLength(0)
    })
  })

  describe('values a generator stores in a form its arguments never spelled', () => {
    const protectedValue = '3141592653'

    function tool(name: string) {
      const registry = chatRegistry(() => [{ name: 'PROBE_VALUE', value: protectedValue }])
      return registry.get(name)!
    }

    function packageXml(file: string): string {
      return [...zipEntries(file)]
        .filter(([name]) => name.endsWith('.xml'))
        .map(([, data]) => data.toString('utf8'))
        .join('\n')
    }

    it.each([
      ['grouped digits under an integer format', '3,141,592,653', { Amount: '0' }],
      ['an amount of money', '$3,141,592,653', undefined],
    ])(
      'does not attach a sheet that stores %s as the protected digits',
      async (_label, cell, formats) => {
        const result = await tool('clerum__generate_xlsx').execute({
          filename: 'stored.xlsx',
          sheets: [
            {
              name: 'S',
              rows: [['Amount'], [cell]],
              ...(formats ? { columnFormats: formats } : {}),
            },
          ],
        })
        expect(result.is_error).toBe(false)
        // Witness: the sheet holds, as a number, digits the arguments never spelled.
        expect(packageXml(generated('stored.xlsx'))).toContain(`<v>${protectedValue}</v>`)
        expect(result.attachments ?? []).toHaveLength(0)
      }
    )

    it('attaches a sheet whose stored numbers hold no secret', async () => {
      const result = await tool('clerum__generate_xlsx').execute({
        filename: 'ordinary.xlsx',
        sheets: [{ name: 'S', rows: [['Amount'], ['1,234']], columnFormats: { Amount: '0' } }],
      })
      expect(result.is_error).toBe(false)
      expect(packageXml(generated('ordinary.xlsx'))).toContain('<v>1234</v>')
      expect(result.attachments ?? []).toHaveLength(1)
    })

    it('does not attach a deck whose chart stores grouped digits as the protected value', async () => {
      const deck = (data: string[]) => ({
        filename: 'chart.pptx',
        slides: [
          {
            layout: 'title-chart',
            title: 'Revenue',
            chart: { type: 'bar', labels: ['A'], datasets: [{ label: 'S', data }] },
          },
        ],
      })
      const leaked = await tool('clerum__generate_pptx').execute(deck(['3,141,592,653']))
      expect(leaked.is_error).toBe(false)
      expect(packageXml(generated('chart.pptx'))).toContain(protectedValue)
      expect(leaked.attachments ?? []).toHaveLength(0)

      const ordinary = await tool('clerum__generate_pptx').execute(deck(['1,234']))
      expect(ordinary.is_error).toBe(false)
      expect(ordinary.attachments ?? []).toHaveLength(1)
    })
  })

  describe('what a delivered file shows that its arguments never spelled', () => {
    function toolWith(name: string, secrets: string[]) {
      const registry = chatRegistry(() =>
        secrets.map((value, i) => ({ name: `PROBE_${i}`, value }))
      )
      return registry.get(name)!
    }

    function packageXml(file: string): string {
      return [...zipEntries(file)]
        .filter(([name]) => name.endsWith('.xml'))
        .map(([, data]) => data.toString('utf8'))
        .join('\n')
    }

    function sheet(cell: unknown, format?: string) {
      return {
        filename: 'shown.xlsx',
        sheets: [
          { name: 'S', rows: [['D'], [cell]], ...(format ? { columnFormats: { D: format } } : {}) },
        ],
      }
    }

    it('holds back a date its arguments spell, through the argument check', async () => {
      const result = await toolWith('clerum__generate_xlsx', ['2026-01-02']).execute(
        sheet('2026-01-02')
      )
      expect(result.is_error).toBe(false)
      expect(result.attachments ?? []).toHaveLength(0)
    })

    it.each([
      ['a UTC time shown with a space', '2026-01-02 15:04:05', '2026-01-02T15:04:05Z', undefined],
      [
        'a time with an offset shown in UTC',
        '2026-01-02 09:34:05',
        '2026-01-02T15:04:05+05:30',
        undefined,
      ],
      ['a date under a day-first format', '02/01/2026', '2026-01-02', 'dd/mm/yyyy'],
      ['grouped digits', '3,141,592,653', 3141592653, '#,##0'],
      ['digits grouped the German way', '3.141.592.653', 3141592653, '#,##0'],
      ['digits beside quoted text', 'sk-123456', 123456, '"sk-"0'],
      ['grouped digits beside quoted text', 'sk-123456', 123456, '"sk-"#,##0'],
      ['a date under a format with periods', '02012026', '2026-01-02', 'dd.mm.yyyy'],
    ])('does not attach a sheet that shows %s', async (_label, secret, cell, format) => {
      const result = await toolWith('clerum__generate_xlsx', [secret]).execute(sheet(cell, format))
      expect(result.is_error).toBe(false)
      // Witness: neither the arguments nor the package spell the value.
      expect(JSON.stringify(sheet(cell, format))).not.toContain(secret)
      expect(packageXml(generated('shown.xlsx'))).not.toContain(secret)
      expect(result.attachments ?? []).toHaveLength(0)
    })

    it('attaches the same sheet when no protected value is shown', async () => {
      const result = await toolWith('clerum__generate_xlsx', ['9,999,999,999']).execute(
        sheet(3141592653, '#,##0')
      )
      expect(result.attachments ?? []).toHaveLength(1)
    })

    it('does not attach a deck whose chart label shows the protected value grouped', async () => {
      const deck = {
        filename: 'labels.pptx',
        slides: [
          {
            layout: 'title-chart',
            title: 'Revenue',
            chart: { type: 'bar', labels: ['A'], datasets: [{ label: 'S', data: [3141592653] }] },
          },
        ],
      }
      const leaked = await toolWith('clerum__generate_pptx', ['3,141,592,653']).execute(deck)
      expect(leaked.is_error).toBe(false)
      expect(packageXml(generated('labels.pptx'))).not.toContain('3,141,592,653')
      expect(leaked.attachments ?? []).toHaveLength(0)
      const ordinary = await toolWith('clerum__generate_pptx', ['9,999,999,999']).execute(deck)
      expect(ordinary.attachments ?? []).toHaveLength(1)
    })

    it('does not attach a chart image whose value label shows the protected value', async () => {
      const chart = (filename: string) => ({
        filename,
        type: 'bar',
        showValues: true,
        valueFormat: 'plain',
        data: { labels: ['A'], datasets: [{ label: 'S', data: [3141592653] }] },
      })
      const leaked = await toolWith('clerum__generate_chart', ['3,141,592,653']).execute(
        chart('v.png')
      )
      expect(leaked.is_error).toBe(false)
      expect(leaked.attachments ?? []).toHaveLength(0)
      const ordinary = await toolWith('clerum__generate_chart', ['9,999,999,999']).execute(
        chart('c.png')
      )
      expect(ordinary.attachments ?? []).toHaveLength(1)
    })

    it.each([
      ['without grouping', '3141592653'],
      ['grouped the German way', '3.141.592.653'],
    ])(
      'does not attach a chart image whose value label shows the protected value %s',
      async (_label, secret) => {
        const result = await toolWith('clerum__generate_chart', [secret]).execute({
          filename: 'g.png',
          type: 'bar',
          showValues: true,
          valueFormat: 'plain',
          decimals: 0,
          // Drawn "3,141,592,653", rounded: the arguments never spell it.
          data: { labels: ['A'], datasets: [{ label: 'S', data: [3141592652.6] }] },
        })
        expect(result.is_error).toBe(false)
        expect(result.attachments ?? []).toHaveLength(0)
      }
    )

    it('attaches a chart image whose separate labels only spell a protected value run together', async () => {
      const result = await toolWith('clerum__generate_chart', ['3405', '1203']).execute({
        filename: 'line.png',
        type: 'line',
        showValues: true,
        data: {
          labels: ['a', 'b', 'c', 'd'],
          datasets: [{ label: 'S', data: [120, 340, 560, 410] }],
        },
      })
      expect(result.is_error).toBe(false)
      expect(result.attachments ?? []).toHaveLength(1)
    })

    it('does not attach markdown that prints a protected value whole once and split once', async () => {
      const markdown = toolWith('clerum__generate_markdown', ['probe-redaction-value'])
      const leaked = await markdown.execute({
        filename: 'twice.md',
        content: 'a: probe-redaction-value\n\nb: probe-**redaction**-value',
      })
      expect(leaked.is_error).toBe(false)
      expect(leaked.attachments ?? []).toHaveLength(0)
      // Control: the whole occurrence alone is redacted and attached.
      const whole = await markdown.execute({
        filename: 'once.md',
        content: 'a: probe-redaction-value',
      })
      expect(whole.attachments ?? []).toHaveLength(1)
      expect(decoded(whole.attachments![0]!).toString('utf8')).toBe('a: [REDACTED:PROBE_0]')
    })

    it("does not attach a sheet that shows a protected value which is also the generator's own text", async () => {
      // "1000" is in every workbook's styles; a cell of 999.6 shown as an integer reads "1,000".
      const leaked = await toolWith('clerum__generate_xlsx', ['1000']).execute(
        sheet(999.6, 'integer')
      )
      expect(leaked.is_error).toBe(false)
      expect(leaked.attachments ?? []).toHaveLength(0)
    })

    it('delivers only the bytes the generator wrote', async () => {
      const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_markdown')!
      const original = tool.execute.bind(tool)
      // Another call writes the same name between this call's write and its delivery.
      vi.spyOn(tool, 'execute').mockImplementationOnce(async (args, dir, options) => {
        const result = await original(args, dir, options)
        fs.writeFileSync(result.artifact!.path, '# someone else\n')
        return result
      })
      const raced = await toolWith('clerum__generate_markdown', []).execute({
        filename: 'race.md',
        content: '# mine\n',
      })
      expect(raced.is_error).toBe(false)
      expect(raced.attachments ?? []).toHaveLength(0)
      const calm = await toolWith('clerum__generate_markdown', []).execute({
        filename: 'race.md',
        content: '# mine\n',
      })
      expect(calm.attachments ?? []).toHaveLength(1)
    })

    it.each([
      [
        'markdown',
        'clerum__generate_markdown',
        { filename: 'card.md', content: 'Card 4111 1111 1111 1111' },
      ],
      ['a PDF', 'clerum__generate_pdf', { filename: 'card.pdf', body: 'Card 4111 1111 1111 1111' }],
      [
        'markdown, with hyphens,',
        'clerum__generate_markdown',
        { filename: 'card.md', content: 'Card 4111-1111-1111-1111' },
      ],
    ])(
      'does not attach %s that writes a protected number in groups',
      async (_label, name, args) => {
        const result = await toolWith(name, ['4111111111111111']).execute(args)
        expect(result.is_error).toBe(false)
        expect(result.attachments ?? []).toHaveLength(0)
      }
    )

    it.each([
      ['an anchor link', 'probe-[redaction](#notes)-value'],
      ['a relative link', 'probe-[redaction](notes.md)-value'],
      ['an angle-bracket destination', 'probe-[redaction](<notes page.md>)-value'],
      ['a reference link', 'probe-[redaction][r]-value\n\n[r]: https://a.example'],
      ['a link titled in single quotes', "probe-[redaction](#a 'x')-value"],
      ['a link titled in parentheses', 'probe-[redaction](#a (x))-value'],
      ['a destination after a space', 'probe-[redaction]( #a )-value'],
      ['a destination holding parentheses', 'probe-[redaction](a(b)c)-value'],
      ['a link after a reference definition', '[r]: #x\n\nprobe-[redaction](#a)-value'],
      ['a bidi control', 'probe-red\u202aaction-value'],
      ['the Arabic letter mark', 'probe-red\u061caction-value'],
      ['a combining grapheme joiner', 'probe-red\u034faction-value'],
      ['a tag character', 'probe-red\u{e0041}action-value'],
    ])(
      'does not attach markdown that splits a protected value with %s',
      async (_label, content) => {
        const result = await toolWith('clerum__generate_markdown', [
          'probe-redaction-value',
        ]).execute({
          filename: 'split.md',
          content,
        })
        expect(result.is_error).toBe(false)
        expect(result.attachments ?? []).toHaveLength(0)
      }
    )

    it('attaches a chart whose decimal label only runs the digits of a protected number together', async () => {
      const result = await toolWith('clerum__generate_chart', ['5432']).execute({
        filename: 'pct.png',
        type: 'bar',
        data: { labels: ['54.32%', 'other'], datasets: [{ label: 'S', data: [1, 2] }] },
      })
      expect(result.is_error).toBe(false)
      expect(result.attachments ?? []).toHaveLength(1)
    })

    it('attaches a document whose only match is the time the generator stamped on it', async () => {
      // core.xml holds the moment of writing; a protected value of the year is not in the arguments.
      const year = String(new Date().getUTCFullYear())
      const result = await toolWith('clerum__generate_docx', [year]).execute({
        filename: 'stamped.docx',
        title: 'Report',
        body: 'Hello',
      })
      expect(result.is_error).toBe(false)
      expect(result.attachments ?? []).toHaveLength(1)
    })

    it("attaches ordinary documents when a protected value is also the generators' own text", async () => {
      const common = ['Office', '1000', 'Calibri', 'General', 'main', 'false', 'solid']
      const calls: Array<[string, Record<string, unknown>]> = [
        [
          'clerum__generate_docx',
          { filename: 'o.docx', title: 'Quarterly', body: 'Revenue grew.' },
        ],
        ['clerum__generate_xlsx', sheet(1200, 'integer')],
        [
          'clerum__generate_pptx',
          {
            filename: 'o.pptx',
            slides: [
              { layout: 'title-bullets', title: 'T', bullets: ['a'] },
              {
                layout: 'title-chart',
                title: 'C',
                chart: { type: 'bar', labels: ['A'], datasets: [{ label: 'S', data: [5] }] },
              },
            ],
          },
        ],
      ]
      for (const [name, args] of calls) {
        const result = await toolWith(name, common).execute(args)
        expect(result.attachments ?? [], name).toHaveLength(1)
      }
    }, 60_000)

    it('does not attach markdown whose markup splits a protected value, and redacts a whole one', async () => {
      const md = toolWith('clerum__generate_markdown', ['probe-redaction-value'])
      const split = await md.execute({
        filename: 's.md',
        content: 'key: probe-**redaction**-value',
      })
      expect(split.attachments ?? []).toHaveLength(0)
      const whole = await md.execute({ filename: 'w.md', content: 'key: probe-redaction-value' })
      expect(whole.attachments).toHaveLength(1)
      expect(decoded(whole.attachments![0]!).toString('utf8')).not.toContain(
        'probe-redaction-value'
      )
    })
  })

  it.skipIf(process.getuid?.() === 0)(
    'logs the stage, name and code of a read that fails, not only that it failed',
    async () => {
      const { logger } = await import('../../../logger')
      const warn = vi.spyOn(logger, 'warn')
      fs.writeFileSync(path.join(outputDir, 'locked.md'), '# locked\n')
      fs.chmodSync(path.join(outputDir, 'locked.md'), 0o000)
      try {
        const attachment = buildGeneratedArtifactAttachment({
          sourceTool: 'clerum__generate_markdown',
          artifact: metadata(outputDir, 'locked.md', 'md'),
          outputDir,
          maxBytes: 1024,
        })
        expect(attachment).toBeNull()
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'artifact_path_error_500',
            stage: 'open',
            errorName: 'ArtifactPathError',
            errorCode: 'EACCES',
          }),
          'Skipping artifact attachment'
        )
      } finally {
        fs.chmodSync(path.join(outputDir, 'locked.md'), 0o600)
        warn.mockRestore()
      }
    }
  )

  it('native internal tools return generated artifact attachments through the adapter', async () => {
    const registry = chatRegistry()

    const result = await registry.get('clerum__generate_markdown')!.execute({
      filename: 'native-report.md',
      content: '# Native report\n',
    })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('File generated: native-report.md (md)')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]).toMatchObject({
      sourceTool: 'clerum__generate_markdown',
      lane: INTERNAL_GENERATED_ARTIFACT_LANE,
      filename: 'native-report.md',
      mimeType: 'text/markdown',
    })
    expect(decoded(result.attachments![0]!)).toEqual(Buffer.from('# Native report\n'))
  })
})
