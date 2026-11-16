import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'WORKFLOW_APPROVAL_READER_ENABLED_MEDIA'
const MANIFEST = new URL(
  '../../deploy/base/channels/workflow-approval-request-reader/configmap.yaml',
  import.meta.url
)
const originalEnv = process.env

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('approval-reader code defaults against deploy/base', () => {
  it('the enabled media default equals the deploy/base value', async () => {
    // This package has no YAML parser; the key is one flat line in the ConfigMap.
    const line = new RegExp(`^\\s*${KEY}:\\s*"([^"]+)"\\s*$`, 'm').exec(
      readFileSync(MANIFEST, 'utf8')
    )
    if (!line) throw new Error(`${KEY} is not in ${MANIFEST.pathname}`)

    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env[KEY]
    const { config } = await import('../src/config.js')

    expect([...config.enabledMedia].sort()).toEqual(line[1].split(',').sort())
  })
})
