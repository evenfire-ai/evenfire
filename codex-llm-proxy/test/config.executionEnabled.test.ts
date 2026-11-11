import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'

const KEY = 'CODEX_LLM_PROXY_EXECUTION_ENABLED'
const MANIFEST = new URL('../../deploy/base/control-plane/codex-llm-proxy.yaml', import.meta.url)
const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString()

function load(value: string | undefined) {
  const env: NodeJS.ProcessEnv = {
    CODEX_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
    CODEX_LLM_PROXY_CONTROL_API_URL: 'http://control-api:8080',
    CODEX_LLM_PROXY_CONTROL_API_TOKEN: 'service-token',
  }
  if (value !== undefined) env[KEY] = value
  return loadConfig(env)
}

function baseValue(): string {
  const matches = [...readFileSync(MANIFEST, 'utf8').matchAll(new RegExp(`^\\s+${KEY}:\\s*"([^"]*)"\\s*$`, 'gm'))]
  expect(matches, `${KEY} must appear once in deploy/base`).toHaveLength(1)
  return matches[0][1]
}

describe('Codex proxy execution switch', () => {
  it('is on when unset, empty or true', () => {
    expect(load(undefined).executionEnabled).toBe(true)
    expect(load('').executionEnabled).toBe(true)
    expect(load('true').executionEnabled).toBe(true)
  })

  it('is off only when false', () => {
    expect(load('false').executionEnabled).toBe(false)
  })

  it('refuses to start on any other value', () => {
    for (const raw of ['TRUE', '0', 'off', 'true\n']) {
      expect(() => load(raw), JSON.stringify(raw)).toThrow(new RegExp(`${KEY} must be 'true' or 'false'`))
    }
  })

  it('defaults to the value deploy/base ships', () => {
    expect(String(load(undefined).executionEnabled)).toBe(baseValue())
  })
})
