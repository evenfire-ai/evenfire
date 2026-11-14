import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

type Line = { level?: string; svc?: string; msg?: string; [field: string]: unknown }

/** Load config in dev mode and return every structured line it printed. */
async function loadDevConfig(
  env: Record<string, string>
): Promise<{ lines: Line[]; raw: string[] }> {
  vi.resetModules()
  process.env = { ...originalEnv, CLERUM_DEV_MODE: 'true', ...env }
  const raw: string[] = []
  const spies = (['log', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation((line?: unknown) => {
      raw.push(String(line))
    })
  )
  try {
    await import('./config')
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return { lines: raw.filter(line => line.startsWith('{')).map(line => JSON.parse(line)), raw }
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('config.ts logs through the service logger (repository logging standard)', () => {
  it('prints a dev MCP server as a JSON line with hasUrl and without its URL', async () => {
    const url = 'http://dev-internal.example:9/private-path'
    const { lines, raw } = await loadDevConfig({
      CLERUM_MCP_SERVERS: JSON.stringify([{ name: 'dev-a', spec: { transport: { url } } }]),
    })

    const server = lines.find(line => line.msg === '[Config]   - dev-a')
    // Witness: the line was emitted.
    expect(server).toMatchObject({ level: 'info', svc: 'host-context-controller', hasUrl: true })
    expect(
      lines.find(line => line.msg?.startsWith('[Config] Parsed 1 dev MCP server(s)'))
    ).toBeDefined()
    expect(raw.join('\n')).not.toContain('dev-internal.example')
    expect(raw.join('\n')).not.toContain('private-path')
  })

  it('logs a CLERUM_MCP_AUTH parse failure with the error name and no part of the input', async () => {
    const input = '{"dev-a": "tok-input-value-123"'
    const { lines, raw } = await loadDevConfig({ CLERUM_MCP_AUTH: input })

    const failure = lines.find(line => line.msg === '[Config] Failed to parse CLERUM_MCP_AUTH:')
    // Witness: the line was emitted.
    expect(failure).toMatchObject({ level: 'error', errorName: 'SyntaxError' })
    expect(raw.join('\n')).not.toContain('tok-input-value-123')
    expect(raw.join('\n')).not.toContain('dev-a')
  })

  it.each(['CLERUM_MCP_SERVERS', 'CLERUM_CONTEXTS'])(
    'logs a %s parse failure with the error name only',
    async name => {
      const { lines, raw } = await loadDevConfig({ [name]: '[{"name": "quoted-input-value"' })

      const failure = lines.find(line => line.msg === `[Config] Failed to parse ${name}:`)
      expect(failure).toMatchObject({ level: 'error', errorName: 'SyntaxError' })
      expect(raw.join('\n')).not.toContain('quoted-input-value')
    }
  )
})
