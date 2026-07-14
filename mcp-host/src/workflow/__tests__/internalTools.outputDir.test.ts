import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { getOutputDir, setOutputDirHostAccessor } from '../internalTools'

const OUTPUT_ENV = [
  'CLERUM_OUTPUT_DIR',
  'CLERUM_WORKFLOW_ENABLED',
  'CLERUM_MEMORY_WORKSPACE_PATH',
] as const

describe('getOutputDir (D.2b artifact durability)', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(OUTPUT_ENV.map(k => [k, process.env[k]]))
    for (const k of OUTPUT_ENV) delete process.env[k]
    setOutputDirHostAccessor(() => null)
  })

  afterEach(() => {
    for (const k of OUTPUT_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    setOutputDirHostAccessor(() => null)
  })

  it('honors the CLERUM_OUTPUT_DIR override above everything else', () => {
    process.env.CLERUM_OUTPUT_DIR = '/custom/path'
    process.env.CLERUM_WORKFLOW_ENABLED = 'true'
    process.env.CLERUM_MEMORY_WORKSPACE_PATH = '/ws'
    expect(getOutputDir()).toBe('/custom/path')
  })

  it('returns /output in workflow mode', () => {
    process.env.CLERUM_WORKFLOW_ENABLED = 'true'
    expect(getOutputDir()).toBe('/output')
  })

  it('returns ${workspacePath}/outputs in chat mode from the env var', () => {
    process.env.CLERUM_MEMORY_WORKSPACE_PATH = '/test/workspace'
    expect(getOutputDir()).toBe(path.join('/test/workspace', 'outputs'))
  })

  it('falls back to /workspace/outputs when no workspace path is set', () => {
    expect(getOutputDir()).toBe(path.join('/workspace', 'outputs'))
  })

  it('prefers the Host CRD workspacePath over the env var', () => {
    process.env.CLERUM_MEMORY_WORKSPACE_PATH = '/from/env'
    setOutputDirHostAccessor(() => ({ spec: { memory: { workspacePath: '/from/crd' } } }))
    expect(getOutputDir()).toBe(path.join('/from/crd', 'outputs'))
  })

  it('re-evaluates on every call (CRD hydrated async after boot)', () => {
    expect(getOutputDir()).toBe(path.join('/workspace', 'outputs')) // before CRD
    setOutputDirHostAccessor(() => ({ spec: { memory: { workspacePath: '/late/crd' } } }))
    expect(getOutputDir()).toBe(path.join('/late/crd', 'outputs')) // after CRD hydrates
  })

  it('writes an artifact under the resolved dir that persists on disk', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'clerum-d2b-'))
    try {
      process.env.CLERUM_MEMORY_WORKSPACE_PATH = workspace
      const outputDir = getOutputDir()
      expect(outputDir).toBe(path.join(workspace, 'outputs'))

      mkdirSync(outputDir, { recursive: true })
      writeFileSync(path.join(outputDir, 'report.md'), '# Hello')

      // Survives any later resolve; the file is on the (durable, in prod PVC) FS.
      expect(existsSync(path.join(workspace, 'outputs', 'report.md'))).toBe(true)
      expect(readFileSync(path.join(workspace, 'outputs', 'report.md'), 'utf8')).toBe('# Hello')
      expect(getOutputDir()).toBe(path.join(workspace, 'outputs'))
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
