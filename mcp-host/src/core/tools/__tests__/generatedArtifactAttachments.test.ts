import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ArtifactMetadata } from '../../../workflow/types'
import type { NativeToolConfig } from '../../interfaces'
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

describe('generated internal artifact attachments', () => {
  let outputDir: string
  let originalOutputDir: string | undefined

  beforeEach(() => {
    originalOutputDir = process.env.CLERUM_OUTPUT_DIR
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-generated-attachments-'))
  })

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
    ['clerum__generate_pdf', 'report.pdf', 'pdf', Buffer.from('%PDF-1.7\n%%EOF')],
    ['clerum__generate_docx', 'report.docx', 'docx', Buffer.from('PK docx bytes')],
    ['clerum__generate_xlsx', 'report.xlsx', 'xlsx', Buffer.from('PK xlsx bytes')],
    ['clerum__generate_pptx', 'report.pptx', 'pptx', Buffer.from('PK pptx bytes')],
    ['clerum__generate_chart', 'chart.png', 'png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ] as const)(
    'builds a %s binary attachment when the source payload has no configured secrets',
    (sourceTool, filename, format, body) => {
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

  it('native internal tools return generated artifact attachments through the adapter', async () => {
    const config: NativeToolConfig = {
      workspacePath: outputDir,
      shellTimeout: 5000,
      toolTimeout: 60000,
      toolProgressInterval: 30000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    }
    process.env.CLERUM_OUTPUT_DIR = outputDir
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      { maxBytes: 52_428_800 }
    )

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
