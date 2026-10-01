import { describe, expect, it } from 'vitest'
import { classifyGfsReferenceSurfaces } from '../gfsReferenceSurfaces'

describe('classifyGfsReferenceSurfaces', () => {
  it('keeps inline text independent from workspace delivery', () => {
    expect(
      classifyGfsReferenceSurfaces(
        { byteLength: 8192, reader: 'text', modelImageInput: 'unsupported' },
        { workspaceFile: false, localExecutor: false, visual: false }
      )
    ).toEqual({
      metadata: true,
      inline: true,
      workspace: false,
      localExecutor: false,
      visual: false,
    })
  })

  it('separates workspace delivery from approved local execution for the incident size', () => {
    const reference = {
      byteLength: 3_836_961,
      reader: 'text' as const,
      modelImageInput: 'unsupported' as const,
    }
    expect(
      classifyGfsReferenceSurfaces(reference, {
        workspaceFile: true,
        localExecutor: false,
        visual: false,
      })
    ).toMatchObject({ inline: false, workspace: true, localExecutor: false })
    expect(
      classifyGfsReferenceSurfaces(reference, {
        workspaceFile: true,
        localExecutor: true,
        visual: false,
      })
    ).toMatchObject({ workspace: true, localExecutor: true })
  })

  it('requires producer image candidacy and runtime visual support', () => {
    const reference = {
      byteLength: 3_836_961,
      reader: 'none' as const,
      modelImageInput: 'candidate' as const,
    }
    expect(
      classifyGfsReferenceSurfaces(reference, {
        workspaceFile: true,
        localExecutor: true,
        visual: true,
      })
    ).toMatchObject({ visual: true })
    expect(
      classifyGfsReferenceSurfaces(reference, {
        workspaceFile: true,
        localExecutor: true,
        visual: false,
      })
    ).toMatchObject({ visual: false })
    expect(
      classifyGfsReferenceSurfaces(
        { ...reference, modelImageInput: 'unsupported' as const },
        { workspaceFile: true, localExecutor: true, visual: true }
      )
    ).toMatchObject({ visual: false })
  })

  it('rejects workspace delivery above the generic GFS source limit', () => {
    expect(
      classifyGfsReferenceSurfaces(
        { byteLength: 16 * 1024 * 1024 + 1, reader: 'text', modelImageInput: 'unsupported' },
        { workspaceFile: true, localExecutor: true, visual: true }
      )
    ).toMatchObject({ inline: false, workspace: false, localExecutor: false })
  })
})
