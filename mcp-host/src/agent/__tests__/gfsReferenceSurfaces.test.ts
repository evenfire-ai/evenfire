import { describe, expect, it } from 'vitest'
import {
  type FileReferenceV1,
  buildGfsFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { resolveFileReferences } from '../fileReferenceResolver'
import type { FileReferenceGfscClient } from '../fileReferenceResolver'
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

  it('attaches fail-closed delivery surfaces to available resolver results', async () => {
    const resourceId = '0123456789abcdef0123456789abcdef'
    const built = buildGfsFileReference({
      drive: 'main',
      resourceId,
      gfsUri: `gfs://main/${resourceId}`,
      version: 7,
      name: 'incident.csv',
      declaredMediaType: 'text/csv',
      byteLength: 3_836_961,
      classification: classifyBytes({
        bytes: new Uint8Array(),
        totalByteLength: 3_836_961,
        declaredMediaType: 'text/csv',
        filename: 'incident.csv',
      }),
    })
    if (!built.ok) throw new Error(built.message)
    const reference = built.value as FileReferenceV1
    const client: FileReferenceGfscClient = {
      resolve: async () => ({
        ok: true,
        data: {
          kind: 'file',
          rid: resourceId,
          drive: 'main',
          resourceId,
          gfsUri: `gfs://main/${resourceId}`,
          name: 'incident.csv',
          version: 7,
          bytes: 3_836_961,
        },
      }),
    }

    const failClosed = await resolveFileReferences([reference], client)
    expect(failClosed.ok).toBe(true)
    if (!failClosed.ok) return
    expect(failClosed.resolutions[0]!.surfaces).toEqual({
      metadata: true,
      inline: false,
      workspace: false,
      localExecutor: false,
      visual: false,
    })

    const enabled = await resolveFileReferences([reference], client, undefined, {
      workspaceFile: true,
      localExecutor: true,
      visual: false,
    })
    expect(enabled.ok).toBe(true)
    if (!enabled.ok) return
    expect(enabled.resolutions[0]!.surfaces).toMatchObject({
      inline: false,
      workspace: true,
      localExecutor: true,
      visual: false,
    })
  })
})
