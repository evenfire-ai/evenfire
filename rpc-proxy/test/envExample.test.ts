import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// `.env.example` is the list a developer exports before `npm run dev`. Every secret that
// config.ts requires with no code default must be in it, or local startup fails on a
// variable the file never mentions.
const REQUIRED_SECRETS = [
  'RPC_PROXY_CONTROL_API_SERVICE_TOKEN',
  'RPC_PROXY_DESKTOP_COOKIE_SECRET',
  'RPC_PROXY_SANDBOX_UI_COOKIE_SECRET',
]

function exampleKeys(): string[] {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  return text
    .split('\n')
    .map(line => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)
}

describe('rpc-proxy .env.example', () => {
  it('parses the file into its variable names', () => {
    const keys = exampleKeys()

    expect(keys).toContain('CLERUM_DEV_MODE')
    expect(keys.length).toBeGreaterThanOrEqual(5)
  })

  it.each(REQUIRED_SECRETS)('lists the required secret %s', name => {
    expect(exampleKeys()).toContain(name)
  })
})
