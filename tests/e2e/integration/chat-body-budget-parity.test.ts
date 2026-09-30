/**
 * Parity gate for the chat request body budget (#678).
 *
 * rpc-proxy and mcp-host each parse the chat body with their own copy of the
 * budget (no shared package exists), and the Desktop composer mirrors the same
 * numbers to refuse an attachment before it is sent. A drift between any two
 * of them either lets the composer build a request a server rejects, or lets
 * one hop accept what the next refuses. This suite reads the sources and fails
 * when a limit or a qualification predicate differs.
 *
 * Every lookup must match exactly once: a renamed or duplicated constant fails
 * here instead of turning a comparison into one between two `undefined`s.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..')

const MIB = 1024 * 1024

const sources = {
  rpcProxy: readFileSync(join(repoRoot, 'rpc-proxy/src/middleware/chatJsonBody.ts'), 'utf8'),
  mcpHost: readFileSync(join(repoRoot, 'mcp-host/src/server.ts'), 'utf8'),
  composer: readFileSync(join(repoRoot, 'desktop-app/ui/src/constants/attachments.ts'), 'utf8'),
  hostConfig: readFileSync(join(repoRoot, 'mcp-host/src/config.ts'), 'utf8'),
}

function soleMatch(source: string, pattern: RegExp, label: string): RegExpMatchArray {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))]
  expect(matches.length, `${label} must appear exactly once`).toBe(1)
  return matches[0]
}

/** Value of `const NAME = 16 * 1024 * 1024` (or a plain integer literal). */
function constantValue(source: string, name: string, label: string): number {
  const [, expression] = soleMatch(
    source,
    new RegExp(`^(?:export )?const ${name} = ([0-9_]+(?: \\* [0-9_]+)*)$`, 'm'),
    `${label} ${name}`
  )
  return expression
    .split(' * ')
    .map(factor => Number(factor.replaceAll('_', '')))
    .reduce((product, factor) => product * factor, 1)
}

/** Source text of a top-level `function name(...) { ... }`, closed by a column-0 `}`. */
function functionSource(source: string, name: string, label: string): string {
  return soleMatch(
    source,
    new RegExp(`^function ${name}\\([\\s\\S]*?^\\}$`, 'm'),
    `${label} ${name}`
  )[0]
}

const SERVER_LIMITS: ReadonlyArray<readonly [string, number]> = [
  ['MAX_CHAT_BODY_BYTES', 24 * MIB],
  ['MAX_NON_IMAGE_BODY_BYTES', 6 * MIB],
  ['MAX_CHAT_IMAGES', 20],
  ['MAX_IMAGE_DECODED_BYTES', 16 * MIB],
  ['MAX_IMAGE_DECODED_BYTES_TOTAL', 16 * MIB],
  ['MAX_CHAT_FILES', 20],
  ['MAX_FILE_DECODED_BYTES', 11 * MIB],
  ['MAX_FILE_BASE64_BYTES_TOTAL', 16 * MIB],
]

const BUDGET_FUNCTIONS = [
  'decodedBase64Bytes',
  'inspectChatImageBudget',
  'inspectChatFileBudget',
  'chatBodyExceedsNonImageBudget',
] as const

describe('chat body budget parity across rpc-proxy, mcp-host and the composer (#678)', () => {
  it.each(SERVER_LIMITS)('both parsers declare %s with the same value', (name, expected) => {
    expect(constantValue(sources.rpcProxy, name, 'rpc-proxy')).toBe(expected)
    expect(constantValue(sources.mcpHost, name, 'mcp-host')).toBe(expected)
  })

  it('both parsers require the same lowercase sha256 hex digest', () => {
    const pattern = /^const SHA256_HEX_RE = (\/.+\/)$/m
    const rpcProxy = soleMatch(sources.rpcProxy, pattern, 'rpc-proxy SHA256_HEX_RE')[1]
    const mcpHost = soleMatch(sources.mcpHost, pattern, 'mcp-host SHA256_HEX_RE')[1]
    expect(rpcProxy).toBe('/^[0-9a-f]{64}$/')
    expect(mcpHost).toBe(rpcProxy)
  })

  it.each(BUDGET_FUNCTIONS)('both parsers implement %s identically', name => {
    const rpcProxy = functionSource(sources.rpcProxy, name, 'rpc-proxy')
    const mcpHost = functionSource(sources.mcpHost, name, 'mcp-host')
    // Witness: the extracted text is the function, not an empty or truncated match.
    expect(rpcProxy.split('\n').length).toBeGreaterThan(3)
    expect(mcpHost).toBe(rpcProxy)
  })

  it('credits a file by its decoded size, bounded by the per-file and total quotas', () => {
    const inspect = functionSource(sources.rpcProxy, 'inspectChatFileBudget', 'rpc-proxy')
    expect(inspect).toContain('decoded > MAX_FILE_DECODED_BYTES')
    expect(inspect).toContain('credited + dataBase64.length > MAX_FILE_BASE64_BYTES_TOTAL')
    expect(inspect).toContain('counted >= MAX_CHAT_FILES')
    expect(inspect).toContain('SHA256_HEX_RE.test(digest.hex)')
    const exceeds = functionSource(sources.rpcProxy, 'chatBodyExceedsNonImageBudget', 'rpc-proxy')
    expect(exceeds).toContain(
      'rawBodyBytes - images.creditedBase64 - files.creditedBase64 > MAX_NON_IMAGE_BODY_BYTES'
    )
  })

  it('the composer mirrors the server limits', () => {
    const composer: ReadonlyArray<readonly [string, number]> = [
      [
        'COMPOSER_MAX_REQUEST_BODY_BYTES',
        constantValue(sources.rpcProxy, 'MAX_CHAT_BODY_BYTES', 'rpc-proxy'),
      ],
      [
        'COMPOSER_MAX_NON_IMAGE_BODY_BYTES',
        constantValue(sources.rpcProxy, 'MAX_NON_IMAGE_BODY_BYTES', 'rpc-proxy'),
      ],
      [
        'COMPOSER_MAX_FILE_BYTES',
        constantValue(sources.rpcProxy, 'MAX_FILE_DECODED_BYTES', 'rpc-proxy'),
      ],
      [
        'COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES',
        constantValue(sources.rpcProxy, 'MAX_FILE_BASE64_BYTES_TOTAL', 'rpc-proxy'),
      ],
      ['COMPOSER_MAX_ATTACHMENTS', constantValue(sources.rpcProxy, 'MAX_CHAT_FILES', 'rpc-proxy')],
    ]
    for (const [name, serverValue] of composer) {
      expect(constantValue(sources.composer, name, 'composer'), name).toBe(serverValue)
    }
  })

  it('the Host admission default equals the per-file credit ceiling', () => {
    const [, literal] = soleMatch(
      sources.hostConfig,
      /getExecutionLimit\('CLERUM_ATTACHMENT_FILE_MAX_BYTES', ([0-9_]+)\)/,
      'mcp-host config CLERUM_ATTACHMENT_FILE_MAX_BYTES default'
    )
    expect(Number(literal.replaceAll('_', ''))).toBe(
      constantValue(sources.mcpHost, 'MAX_FILE_DECODED_BYTES', 'mcp-host')
    )
  })
})
