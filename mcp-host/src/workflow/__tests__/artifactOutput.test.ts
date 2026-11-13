import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { logger } from '../../logger'
import {
  PARTIAL_PREFIX,
  artifactResult,
  capNotes,
  claimOutputFile,
  getDirectorySize,
  outputFilename,
  replacedBytes,
  writeArtifact,
} from '../artifactOutput'
import { ArtifactPathError, openExistingArtifactFile } from '../artifactPaths'
import { loadEmbeddableImage } from '../embeddedImages'
import { INTERNAL_TOOLS, enforceQuota } from '../internalTools'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-output-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

describe('outputFilename', () => {
  it('keeps ordinary names and normalizes the extension', () => {
    expect(outputFilename('q3-report.pdf', 'pdf', 'output')).toBe('q3-report.pdf')
    expect(outputFilename('Q3 Report.PDF', 'pdf', 'output')).toBe('Q3_Report.pdf')
    expect(outputFilename('notes', 'md', 'output')).toBe('notes.md')
    expect(outputFilename('report.docx', 'pdf', 'output')).toBe('report.pdf')
  })

  it('keeps a dotted part that is not an extension', () => {
    expect(outputFilename('report.v2', 'pdf', 'output')).toBe('report.v2.pdf')
  })

  it('strips directories', () => {
    expect(outputFilename('../../etc/passwd.md', 'md', 'output')).toBe('passwd.md')
  })

  it('keeps two different non-Latin names apart', () => {
    const a = outputFilename('報告.md', 'md', 'output')
    const b = outputFilename('資料.md', 'md', 'output')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^output-[0-9a-f]{8}\.md$/)
    expect(outputFilename('Informe año 2026.pdf', 'pdf', 'output')).toMatch(
      /^Informe_a_o_2026-[0-9a-f]{8}\.pdf$/
    )
  })

  it('keeps names apart that differ only in characters it replaces', () => {
    const a = outputFilename('Q3 report: final.md', 'md', 'output')
    const b = outputFilename('Q3 report? final.md', 'md', 'output')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^Q3_report_final-[0-9a-f]{8}\.md$/)
    expect(outputFilename('Q3 report final.md', 'md', 'output')).toBe('Q3_report_final.md')
  })

  it('falls back when nothing usable is left', () => {
    expect(outputFilename('', 'md', 'output')).toBe('output.md')
    expect(outputFilename('.hidden', 'md', 'output')).toMatch(/^hidden-[0-9a-f]{8}\.md$/)
    expect(outputFilename('???', 'md', 'output')).toMatch(/^output-[0-9a-f]{8}\.md$/)
    expect(outputFilename(undefined, 'html', 'dashboard')).toBe('dashboard.html')
  })

  it('keeps the extension on a very long name', () => {
    const name = outputFilename(`${'a'.repeat(400)}.pdf`, 'pdf', 'output')
    expect(name.endsWith('.pdf')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(124)
  })
})

describe('claimOutputFile', () => {
  it('replaces an existing file', () => {
    expect(claimOutputFile(outputDir, 'r.pdf')).toMatchObject({
      filename: 'r.pdf',
      replacesExisting: false,
    })
    fs.writeFileSync(path.join(outputDir, 'r.pdf'), 'old')
    expect(claimOutputFile(outputDir, 'r.pdf')).toMatchObject({
      filename: 'r.pdf',
      replacesExisting: true,
    })
  })

  it('writes a regular file where a symbolic link stood, never through it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'victim.txt'), 'original')
      fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(outputDir, 'r.pdf'))
      fs.symlinkSync(path.join(outside, 'missing.txt'), path.join(outputDir, 'dangling.pdf'))
      const replaced = claimOutputFile(outputDir, 'r.pdf')
      expect(replaced.replacesExisting).toBe(false)
      fs.writeFileSync(replaced.filePath, 'new')
      expect(fs.lstatSync(replaced.filePath).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('original')
      const dangling = claimOutputFile(outputDir, 'dangling.pdf')
      fs.writeFileSync(dangling.filePath, 'new')
      expect(fs.existsSync(path.join(outside, 'missing.txt'))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('writeArtifact', () => {
  const partials = () => fs.readdirSync(outputDir).filter(name => name.startsWith(PARTIAL_PREFIX))

  it('writes the bytes, replaces an earlier file and leaves no partial file', () => {
    writeArtifact(claimOutputFile(outputDir, 'r.md'), '# first\n')
    writeArtifact(claimOutputFile(outputDir, 'r.md'), Buffer.from('# second\n'))
    expect(fs.readFileSync(path.join(outputDir, 'r.md'), 'utf8')).toBe('# second\n')
    expect(partials()).toEqual([])
  })

  it('replaces a link put in the name after the claim, never writing through it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'victim.txt'), 'original')
      const target = claimOutputFile(outputDir, 'r.pdf')
      fs.symlinkSync(path.join(outside, 'victim.txt'), target.filePath)
      writeArtifact(target, 'new')
      // Opened without following a link, then checked and read through that
      // one descriptor: the name now holds a file of its own.
      const fd = fs.openSync(target.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        expect(fs.fstatSync(fd).isFile()).toBe(true)
        expect(fs.readFileSync(fd, 'utf8')).toBe('new')
      } finally {
        fs.closeSync(fd)
      }
      expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('original')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps the earlier file and no partial file when the write fails', () => {
    writeArtifact(claimOutputFile(outputDir, 'r.md'), 'kept')
    expect(() => writeArtifact(claimOutputFile(outputDir, 'r.md'), 42 as never)).toThrow()
    expect(fs.readFileSync(path.join(outputDir, 'r.md'), 'utf8')).toBe('kept')
    expect(partials()).toEqual([])
  })

  it('treats a partial file as no artifact: not counted, not opened, not embedded', () => {
    const name = `${PARTIAL_PREFIX}in-progress`
    fs.writeFileSync(path.join(outputDir, name), Buffer.alloc(1024))
    fs.writeFileSync(path.join(outputDir, 'done.md'), 'x')
    // Witness: the counter does see regular files.
    expect(getDirectorySize(outputDir)).toBe(1)
    expect(() => openExistingArtifactFile(outputDir, name)).toThrow(ArtifactPathError)
    const warnings: string[] = []
    expect(loadEmbeddableImage(name, outputDir, warnings)).toBeUndefined()
    expect(warnings.join(' ')).toContain('was not found')
  })

  it('removes a partial file left by a write that never finished', () => {
    const stale = path.join(outputDir, `${PARTIAL_PREFIX}stale`)
    const fresh = path.join(outputDir, `${PARTIAL_PREFIX}fresh`)
    fs.writeFileSync(stale, 'x')
    fs.writeFileSync(fresh, 'x')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo)
    writeArtifact(claimOutputFile(outputDir, 'r.md'), 'x')
    expect(fs.existsSync(stale)).toBe(false)
    // A partial file this recent may belong to a write in progress.
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('does not count the size behind a link planted in the name after the claim', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-outside-'))
    try {
      fs.writeFileSync(path.join(outputDir, 'r.pdf'), 'old')
      const target = claimOutputFile(outputDir, 'r.pdf')
      expect(replacedBytes(target)).toBe(3)
      fs.writeFileSync(path.join(outside, 'big.bin'), Buffer.alloc(4096))
      fs.rmSync(target.filePath)
      fs.symlinkSync(path.join(outside, 'big.bin'), target.filePath)
      expect(replacedBytes(target)).toBe(0)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('artifactResult', () => {
  it('reports the saved name and the warnings', () => {
    fs.writeFileSync(path.join(outputDir, 'r.pdf'), 'pdf')
    const result = artifactResult(
      { filename: 'r.pdf', filePath: path.join(outputDir, 'r.pdf'), replacesExisting: false },
      'pdf',
      { warnings: ["Image 'x.png' was not found in the output folder and was left out."] }
    )
    expect(result.artifact).toMatchObject({ name: 'r.pdf', format: 'pdf', sizeBytes: 3 })
    expect(result.content).toContain('File generated: r.pdf (pdf).')
    expect(result.content).toContain("Notes: Image 'x.png' was not found")
  })
})

describe('capNotes', () => {
  it('counts a flood of notes that differ only in their numbers, keeping loss notes first', () => {
    const flood = Array.from(
      { length: 1200 },
      (_, i) => `slides[0].table.rows[${i}][2] is longer than 500 characters and was shortened.`
    )
    const notes = capNotes([...flood, "Image 'x.png' was not found and was left out."])
    expect(notes[0]).toContain('left out')
    expect(notes).toHaveLength(4)
    expect(notes[3]).toContain('(1197 more like it.)')
  })

  it('keeps notes about different columns apart', () => {
    const notes = capNotes(["column 'A' is text.", "column 'B' is text.", "column 'C' is text."])
    expect(notes).toHaveLength(3)
  })
})

describe('enforceQuota', () => {
  it('does not count a file the write replaces', () => {
    const prev = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
    process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1'
    try {
      fs.writeFileSync(path.join(outputDir, 'big.bin'), Buffer.alloc(700 * 1024))
      expect(() => enforceQuota(outputDir, 700 * 1024)).toThrow(/Output quota exceeded/)
      expect(() => enforceQuota(outputDir, 700 * 1024, 700 * 1024)).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
      else process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = prev
    }
  })

  it.each(['2GB', '1.5', '0', 'fifty'])(
    'reads %j as no quota of its own: the default applies, and that is logged once',
    value => {
      const prev = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = value
      const warn = vi.spyOn(logger, 'warn')
      try {
        // Three megabytes: over the 2 or 1 a lenient read would take, under the 50 default.
        fs.writeFileSync(path.join(outputDir, 'some.bin'), Buffer.alloc(3 * 1024 * 1024))
        expect(() => enforceQuota(outputDir, 1024)).not.toThrow()
        expect(() => enforceQuota(outputDir, 1024)).not.toThrow()
        const reports = warn.mock.calls.filter(([, message]) =>
          String(message).includes('CLERUM_WORKFLOW_OUTPUT_QUOTA_MB')
        )
        expect(reports).toHaveLength(1)
      } finally {
        warn.mockRestore()
        if (prev === undefined) delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
        else process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = prev
      }
    }
  )
})

describe('generators through the shared output path', () => {
  const markdown = () => INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_markdown')!

  it('keeps two non-Latin names from overwriting each other', async () => {
    const a = await markdown().execute({ filename: '報告.md', content: 'uno' }, outputDir)
    const b = await markdown().execute({ filename: '資料.md', content: 'dos' }, outputDir)
    expect(a.artifact!.name).not.toBe(b.artifact!.name)
    expect(fs.readFileSync(a.artifact!.path, 'utf8')).toBe('uno')
    expect(fs.readFileSync(b.artifact!.path, 'utf8')).toBe('dos')
  })

  it('replaces a file of the same name', async () => {
    await markdown().execute({ filename: 'r.md', content: 'first' }, outputDir)
    const again = await markdown().execute({ filename: 'r.md', content: 'second' }, outputDir)
    expect(again.artifact!.name).toBe('r.md')
    expect(fs.readFileSync(path.join(outputDir, 'r.md'), 'utf8')).toBe('second')
  })

  it('cleans control characters and CRLF before a generator sees them', async () => {
    const result = await markdown().execute(
      { filename: 'log.md', content: '# Build\r\n\u001b[31mFAILED\u001b[0m\u0007' },
      outputDir
    )
    expect(fs.readFileSync(result.artifact!.path, 'utf8')).toBe('# Build\nFAILED')
  })
})
