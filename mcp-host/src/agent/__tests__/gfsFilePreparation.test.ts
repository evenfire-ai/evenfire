import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { buildGfsFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { UnifiedApprovalGateController } from '../../core/extensions/mcpApprovalGateController'
import type { Tool, ToolRegistry } from '../../core/interfaces'
import type { ToolOutput } from '../../core/types'
import { GFS_FILE_LIMITS } from '../../internalTools/gfsFilePolicy'
import { GFS_LOCAL_PROCESSING_GUIDANCE } from '../../internalTools/gfsReadTypes'
import type { FileReferenceResolution } from '../fileReferenceResolver'
import { prepareGfsFiles } from '../gfsFilePreparation'

const body = Buffer.from('preparation-unit-row\n'.repeat(512))
const sha256 = createHash('sha256').update(body).digest('hex')
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const usage = {
  pathSemantics: 'relative-to-caller-workspace',
  nextTool: 'shell_exec_when_local_processing_is_needed',
  visualDelivery: 'not_included',
  approval: 'user-approval-required',
  writeOutputsTo: 'outputs/',
  processLocally: true,
  boundedOutputOnly: true,
  wholeFileToContextAllowed: false,
  processingInstructions: GFS_LOCAL_PROCESSING_GUIDANCE,
}

function resolution(rid = 'a'.repeat(32), bytes = body): FileReferenceResolution {
  const parsed = buildGfsFileReference({
    drive: 'main',
    resourceId: rid,
    gfsUri: `gfs://main/${rid}`,
    version: 7,
    name: 'unit.input',
    byteLength: bytes.byteLength,
    classification: classifyBytes({
      bytes,
      totalByteLength: bytes.byteLength,
      filename: 'unit.input',
      declaredMediaType: null,
    }),
  })
  if (!parsed.ok) throw new Error('Invalid unit reference')
  return {
    availability: 'available',
    reference: parsed.value,
    surfaces: {
      metadata: true,
      workspace: true,
      localExecutor: true,
      inline: false,
      visual: false,
    },
  }
}

function receipt(reference: FileReferenceResolution['reference']) {
  if (reference.source.kind !== 'gfs') throw new Error('Expected a GFS unit reference')
  return {
    delivery: 'workspace_file',
    id,
    path: `.gfs-downloads/input-${id}/source`,
    sizeBytes: reference.byteLength,
    sha256,
    expiresAt: '2099-01-01T00:00:00.000Z',
    source: { ...reference.source, name: reference.name },
    usage,
  }
}

function subject(
  execute = vi.fn(
    async (_params: Record<string, unknown>, _context?: unknown): Promise<ToolOutput> => ({
      content: JSON.stringify(receipt(resolution().reference)),
      duration_ms: 1,
      is_error: false,
    })
  )
) {
  const tool: Tool = {
    name: () => 'clerum__gfs_download',
    description: () => 'Unit download',
    parametersSchema: () => ({}),
    requiresApproval: () => false,
    requiresSanitization: () => false,
    execute,
  }
  const registry: ToolRegistry = {
    register: () => {},
    get: name => (name === tool.name() ? tool : null),
    listDefinitions: () => [],
  }
  const signal = new AbortController().signal
  const context = {
    registry,
    controller: new UnifiedApprovalGateController(registry, undefined, registry),
    signal,
    callerIdentity: 'unit-caller',
    toolTimeoutMs: 1000,
    budget: { assertTime: () => {}, remainingDurationMs: 500 },
  }
  return { context, registry, execute, signal }
}

describe('GFS file preparation', () => {
  it('uses only admitted large references, pins the version and projects a byte-free receipt', async () => {
    const reference = resolution()
    const value = receipt(reference.reference)
    const execute = vi.fn(async (_params: Record<string, unknown>, _context?: unknown) => ({
      content: JSON.stringify({
        ...value,
        usage: { ...value.usage, processingInstructions: 'untrusted-result-instruction' },
        unexpectedBody: body.toString(),
      }),
      duration_ms: 1,
      is_error: false,
    }))
    const test = subject(execute)
    const original = structuredClone(reference)
    const result = await prepareGfsFiles([reference], test.context)
    expect(result).toEqual([
      { referenceId: reference.reference.id, status: 'ready', receipt: value },
    ])
    expect(execute).toHaveBeenCalledWith(
      { drive: 'main', resourceId: 'a'.repeat(32), expectedVersion: 7 },
      {
        signal: test.signal,
        timeoutMs: 500,
        onOutput: expect.any(Function),
      }
    )
    expect(JSON.stringify(result)).not.toContain('preparation-unit-row')
    expect(reference).toEqual(original)
  })

  it('does not bypass an effective policy requiring approval', async () => {
    const test = subject()
    test.context.controller = new UnifiedApprovalGateController(
      test.registry,
      {
        defaultPolicy: 'channel_users',
        channels: {},
        tools: { clerum__gfs_download: true },
      },
      test.registry
    )
    const result = await prepareGfsFiles([resolution()], test.context)
    expect(result).toEqual([
      { referenceId: resolution().reference.id, status: 'unavailable', code: 'approval_required' },
    ])
    expect(test.execute).not.toHaveBeenCalled()
  })

  it.each(['denied', 'stale', 'not_found'] as const)(
    'never transfers an admission result of %s',
    async availability => {
      const test = subject()
      const reference = resolution()
      reference.availability = availability
      expect(await prepareGfsFiles([reference], test.context)).toEqual([])
      expect(test.execute).not.toHaveBeenCalled()
    }
  )

  it('requires the current caller and workspace capability, and leaves small references on demand', async () => {
    const test = subject()
    const small = resolution('b'.repeat(32), Buffer.from('small'))
    expect(await prepareGfsFiles([small], test.context)).toEqual([])
    expect(
      await prepareGfsFiles([resolution()], { ...test.context, callerIdentity: undefined })
    ).toMatchObject([{ status: 'unavailable', code: 'workspace_unavailable' }])
    const unsupported = resolution()
    unsupported.surfaces = { ...unsupported.surfaces!, workspace: false }
    expect(await prepareGfsFiles([unsupported], test.context)).toMatchObject([
      { status: 'unavailable', code: 'workspace_unavailable' },
    ])
    expect(test.execute).not.toHaveBeenCalled()
  })

  it.each([
    ['Error: GFS read failed (gfsc 403: forbidden)', 'denied'],
    ['Error: GFS read failed (gfsc 404: not_found)', 'missing'],
    ['Error: GFS download failed (version_conflict)', 'stale'],
    ['Error: GFS download store failed (caller_quota_exceeded)', 'quota_exceeded'],
    ['Error: untrusted transport detail', 'download_failed'],
  ] as const)('publishes a fixed category for %s', async (content, code) => {
    const test = subject(vi.fn(async () => ({ content, duration_ms: 1, is_error: true })))
    const result = await prepareGfsFiles([resolution()], test.context)
    expect(result).toEqual([
      { referenceId: resolution().reference.id, status: 'unavailable', code },
    ])
    expect(JSON.stringify(result)).not.toContain(content)
  })

  it('keeps the native pinned-version metadata conflict truthful instead of fabricating a receipt', async () => {
    const reference = resolution()
    const test = subject(
      vi.fn(async () => ({
        duration_ms: 1,
        is_error: false,
        content: JSON.stringify({
          availability: 'stale',
          drive: 'main',
          resourceId: 'a'.repeat(32),
          expectedVersion: 7,
        }),
      }))
    )
    expect(await prepareGfsFiles([reference], test.context)).toEqual([
      { referenceId: reference.reference.id, status: 'unavailable', code: 'stale' },
    ])
  })

  it.each(['version', 'size', 'path', 'source', 'oversize', 'images'] as const)(
    'never fabricates success from a %s receipt mismatch',
    async field => {
      const reference = resolution()
      const value = receipt(reference.reference)
      if (field === 'version') value.source.version = 8
      if (field === 'size') value.sizeBytes++
      if (field === 'path') value.path = '/unit-only/source'
      if (field === 'source') {
        if (value.source.kind !== 'gfs') throw new Error('Expected GFS source')
        value.source.resourceId = 'b'.repeat(32)
      }
      const output = {
        content:
          field === 'oversize'
            ? 'x'.repeat(GFS_FILE_LIMITS.metadataBytes + 1)
            : JSON.stringify(value),
        duration_ms: 1,
        is_error: false,
        ...(field === 'images' ? { attachments: [{ id: 'unexpected-image' }] as never } : {}),
      }
      const test = subject(vi.fn(async () => output))
      expect(await prepareGfsFiles([reference], test.context)).toEqual([
        { referenceId: reference.reference.id, status: 'unavailable', code: 'invalid_response' },
      ])
    }
  )

  it('uses the remaining task deadline for each file instead of granting a new budget', async () => {
    const references = [resolution(), resolution('b'.repeat(32))]
    let remainingMs = 50
    const timeouts: number[] = []
    const execute = vi.fn(async (_params: Record<string, unknown>, context?: unknown) => {
      timeouts.push((context as { timeoutMs: number }).timeoutMs)
      const reference = references[timeouts.length - 1]!.reference
      remainingMs -= 25
      return { content: JSON.stringify(receipt(reference)), duration_ms: 1, is_error: false }
    })
    const test = subject(execute)
    const result = await prepareGfsFiles(references, {
      ...test.context,
      budget: {
        assertTime: () => {},
        get remainingDurationMs() {
          return remainingMs
        },
      },
    })
    expect(result.map(file => file.status)).toEqual(['ready', 'ready'])
    expect(timeouts).toEqual([50, 25])
  })
})
