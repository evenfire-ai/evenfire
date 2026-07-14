import { describe, expect, it } from 'vitest'
import type { K8sGateway } from '../src/k8s.js'
import { loadHostSecretEntries, redactArtifactBuffer } from '../src/services/artifactRedactor.js'

describe('redactArtifactBuffer', () => {
  it('loads the host-prefixed per-Host env Secret and the Host LLM Secret', async () => {
    const requestedSecrets: string[] = []
    const envSecret = 'host-secret-value-abcdef'
    const llmSecret = 'llm-secret-value-abcdef'
    const gateway = {
      async getSecret(name: string, namespace: string) {
        requestedSecrets.push(`${namespace}/${name}`)
        if (name === 'host-chatllm-env-secret') {
          return { data: { E2E_HOST_SECRET: Buffer.from(envSecret).toString('base64') } }
        }
        if (name === 'chatllm-api-keys') {
          return { data: { LLM_SECRET: Buffer.from(llmSecret).toString('base64') } }
        }
        throw new Error('not found')
      },
      async getResource(plural: string, name: string, namespace: string) {
        expect({ plural, name, namespace }).toEqual({
          plural: 'hosts',
          name: 'chatllm',
          namespace: 'mcp-host',
        })
        return { spec: { secretRef: 'chatllm-api-keys' } }
      },
    } as unknown as K8sGateway

    const entries = await loadHostSecretEntries(gateway, 'chatllm', 'mcp-host')

    expect(requestedSecrets).toEqual([
      'mcp-host/host-chatllm-env-secret',
      'mcp-host/chatllm-api-keys',
    ])
    expect(entries).toEqual([
      { name: 'E2E_HOST_SECRET', value: envSecret },
      { name: 'LLM_SECRET', value: llmSecret },
    ])
  })

  it('returns the original buffer unchanged when no entries are provided', () => {
    const buf = Buffer.from('nothing to redact here', 'utf-8')
    const { buffer, redactedCount } = redactArtifactBuffer(buf, [])
    expect(buffer).toBe(buf) // same reference — no allocation when no-op
    expect(redactedCount).toBe(0)
  })

  it('redacts a single API-key value from a markdown artifact', () => {
    // Reproduces the documented attack: shell_exec writes `env > leak.md`,
    // then the user clicks Download. Without redaction the secret would
    // round-trip through control-api unmodified.
    const secret = 'fred-api-key-72e062f0cab640479d569d760f091a6c'
    const original = `# Environment dump\n\nFRED_API_KEY=${secret}\nGLASSNODE_API_KEY=other\n`
    const { buffer, redactedCount } = redactArtifactBuffer(Buffer.from(original, 'utf-8'), [
      { name: 'FRED_API_KEY', value: secret },
    ])
    expect(redactedCount).toBe(1)
    expect(buffer.toString('utf-8')).toContain('FRED_API_KEY=[REDACTED:FRED_API_KEY]')
    expect(buffer.toString('utf-8')).not.toContain(secret)
  })

  it('redacts multiple distinct secrets and counts each', () => {
    const fred = 'fred-key-abcdef0123456789'
    const glass = 'glass-key-zzzzyyyywwwwxxxx'
    const original = `report\nfred=${fred} glass=${glass} fred again=${fred}`
    const { buffer, redactedCount } = redactArtifactBuffer(Buffer.from(original, 'utf-8'), [
      { name: 'FRED_API_KEY', value: fred },
      { name: 'GLASSNODE_API_KEY', value: glass },
    ])
    expect(redactedCount).toBe(2) // two distinct entries each redacted at least once
    const out = buffer.toString('utf-8')
    expect(out).not.toContain(fred)
    expect(out).not.toContain(glass)
    expect(out).toContain('[REDACTED:FRED_API_KEY]')
    expect(out).toContain('[REDACTED:GLASSNODE_API_KEY]')
    // The longer-first ordering invariant: both occurrences of fred are masked.
    const fredMatches = out.match(/\[REDACTED:FRED_API_KEY\]/g) ?? []
    expect(fredMatches.length).toBe(2)
  })

  it('redacts longer overlapping secret values before shorter substrings', () => {
    const longSecret = 'XAABBYY'
    const shortSecret = 'AABB'
    const { buffer, redactedCount } = redactArtifactBuffer(Buffer.from(longSecret, 'utf-8'), [
      { name: 'SHORT', value: shortSecret },
      { name: 'LONG', value: longSecret },
    ])

    expect(redactedCount).toBe(1)
    expect(buffer.toString('utf-8')).toBe('[REDACTED:LONG]')
  })

  it('skips empty / trivially short values — defensive against direct callers', () => {
    // If a caller bypasses loadHostSecretEntries (which filters length<4)
    // and passes an empty value, the naive split("").join(marker) would
    // interleave the marker between every byte — corrupting the buffer.
    // The redactor's own length guard must catch this.
    const original = 'hello world'
    const { buffer, redactedCount } = redactArtifactBuffer(Buffer.from(original, 'utf-8'), [
      { name: 'EMPTY', value: '' },
      { name: 'TINY', value: 'ab' },
    ])
    expect(redactedCount).toBe(0)
    // Same reference returned because no entry was applied.
    expect(buffer.toString('utf-8')).toBe(original)
  })

  it('preserves byte length parity for binary buffers when no match is found', () => {
    // Binary formats (xlsx, pdf) typically zip-compress secret bytes inside,
    // so a raw substring scan finds nothing. The function should be a no-op
    // and return the original buffer reference unchanged.
    const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff, 0xfe, 0xfd])
    const { buffer, redactedCount } = redactArtifactBuffer(bin, [
      { name: 'FRED_API_KEY', value: 'not-present-in-buffer' },
    ])
    expect(redactedCount).toBe(0)
    expect(buffer).toBe(bin)
  })

  it('handles secret values containing UTF-8 multi-byte chars without corrupting other bytes', () => {
    // Sanity check that the latin1 round-trip preserves all bytes for
    // non-matching content even when the secret itself contains multi-byte
    // characters. Not a typical secret shape, but guards the encoding.
    const secret = 'tøkën-with-ümlauts-1234567890'
    const original = `header: ${secret}; trailer: 0xff bytes follow`
    const { buffer, redactedCount } = redactArtifactBuffer(Buffer.from(original, 'utf-8'), [
      { name: 'FUNKY_KEY', value: secret },
    ])
    expect(redactedCount).toBe(1)
    expect(buffer.toString('utf-8')).toContain('[REDACTED:FUNKY_KEY]')
    expect(buffer.toString('utf-8')).not.toContain(secret)
  })
})
