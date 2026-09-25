import { describe, expect, it } from 'vitest'
import { parseFileReferenceV1 } from '@clerum/gfs-interaction-policy'
import type { ComposerGlobalFileReference, ComposerReferenceAttachment } from '../../uiTypes'
import { buildComposerFileReferences } from '../composerFileReferences'

const RID = '0123456789abcdef0123456789abcdef'

function globalFile(
  overrides: Partial<ComposerGlobalFileReference> = {}
): ComposerGlobalFileReference {
  return {
    id: `global-file:${RID}`,
    type: 'global_file',
    resourceId: RID,
    drive: 'main',
    gfsUri: `gfs://main/${RID}`,
    label: 'plan.md',
    version: 4,
    bytes: 2048,
    ...overrides,
  }
}

describe('buildComposerFileReferences (#666)', () => {
  it('turns a Global Files selection into a FileReference v1', () => {
    const [reference] = buildComposerFileReferences([globalFile()])

    expect(reference).toEqual({
      schemaVersion: 1,
      id: `gfs:main:${RID}@v4`,
      source: {
        kind: 'gfs',
        drive: 'main',
        resourceId: RID,
        gfsUri: `gfs://main/${RID}`,
        version: 4,
      },
      name: 'plan.md',
      declaredMediaType: null,
      detectedMediaType: 'text/markdown',
      class: 'markdown',
      detection: 'declared',
      mismatch: false,
      byteLength: 2048,
      textReadable: true,
      reader: 'text',
      modelImageInput: 'unsupported',
    })
    // The value is what the IPC boundary accepts.
    expect(parseFileReferenceV1(reference)).toEqual({ ok: true, value: reference })
  })

  it('classifies by file name when the picker lists no media type', () => {
    const references = buildComposerFileReferences([
      globalFile({ label: 'photo.png' }),
      globalFile({ label: 'report.pdf' }),
      globalFile({ label: 'archive.bin' }),
    ])

    expect(references.map(r => [r.class, r.reader, r.modelImageInput])).toEqual([
      ['png', 'none', 'candidate'],
      ['pdf', 'none', 'unsupported'],
      ['binary_unsupported', 'none', 'unsupported'],
    ])
  })

  it('keeps the selection order and ignores other reference kinds', () => {
    const second = `fedcba9876543210fedcba9876543210`
    const references: ComposerReferenceAttachment[] = [
      { id: 'connector:github', type: 'connector', name: 'github', label: 'GitHub' },
      globalFile(),
      {
        id: 'agent-file:ctx-1:assets:/a.txt:file',
        type: 'agent_file',
        contextId: 'ctx-1',
        filesystemName: 'assets',
        path: '/a.txt',
        kind: 'file',
        label: 'assets/a.txt',
      },
      globalFile({
        resourceId: second,
        gfsUri: `gfs://main/${second}`,
        label: 'notes.txt',
        version: 1,
      }),
    ]

    expect(buildComposerFileReferences(references).map(r => r.id)).toEqual([
      `gfs:main:${RID}@v4`,
      `gfs:main:${second}@v1`,
    ])
  })

  it('returns no references when nothing from Global Files is selected', () => {
    const references: ComposerReferenceAttachment[] = [
      { id: 'connector:github', type: 'connector', name: 'github', label: 'GitHub' },
    ]
    const result = buildComposerFileReferences(references)
    // Witness: the call returned a list, not undefined.
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it('throws instead of sending a selection the contract refuses', () => {
    expect(() => buildComposerFileReferences([globalFile({ label: 'drafts/plan.md' })])).toThrow(
      /^Global file reference is invalid \(FILE_REFERENCE_INVALID\)/
    )
    // The classifier refuses an impossible size before the contract sees it.
    expect(() => buildComposerFileReferences([globalFile({ bytes: -1 })])).toThrow(
      /totalByteLength/
    )
    // Control: the unmodified selection builds.
    expect(buildComposerFileReferences([globalFile()])).toHaveLength(1)
  })
})
