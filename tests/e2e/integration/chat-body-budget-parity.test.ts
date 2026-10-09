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
  composerAdmission: readFileSync(
    join(repoRoot, 'desktop-app/ui/src/lib/composerFileAdmission.ts'),
    'utf8'
  ),
  hostConfig: readFileSync(join(repoRoot, 'mcp-host/src/config.ts'), 'utf8'),
  hostAdmission: readFileSync(join(repoRoot, 'mcp-host/src/agent/incomingAttachments.ts'), 'utf8'),
  rpcProxyForwardingTest: readFileSync(
    join(repoRoot, 'rpc-proxy/src/__tests__/wake-and-hold-route.test.ts'),
    'utf8'
  ),
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

/**
 * Source text of a top-level `function name(...) { ... }` (exported or not),
 * closed by a column-0 `}`.
 */
function functionSource(source: string, name: string, label: string): string {
  return soleMatch(
    source,
    new RegExp(`^(?:export )?function ${name}\\([\\s\\S]*?^\\}$`, 'm'),
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

/** Declarations both parsers must spell identically, with the value they must have. */
const SERVER_DECLARATIONS: ReadonlyArray<readonly [string, string]> = [
  ['BASE64_RE', '/^[A-Za-z0-9+/]+={0,2}$/'],
  ['PNG_SIGNATURE', 'Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])'],
  ['JPEG_SIGNATURE', 'Buffer.from([0xff, 0xd8, 0xff])'],
]

/** One trimmed source line of `functionText` that starts with `prefix`. */
function soleLine(functionText: string, prefix: string, label: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return soleMatch(functionText, new RegExp(`^ *${escaped}.*$`, 'm'), label)[0].trim()
}

const BUDGET_FUNCTIONS = [
  'base64SextetValue',
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

  it.each(SERVER_DECLARATIONS)('both parsers declare %s as the same value', (name, expected) => {
    const pattern = new RegExp(`^const ${name} = (.+)$`, 'm')
    const rpcProxy = soleMatch(sources.rpcProxy, pattern, `rpc-proxy ${name}`)[1]
    const mcpHost = soleMatch(sources.mcpHost, pattern, `mcp-host ${name}`)[1]
    expect(rpcProxy).toBe(expected)
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
    expect(soleLine(inspect, 'if (decoded === null', 'per-file credit condition')).toBe(
      'if (decoded === null || decoded <= 0 || decoded > MAX_FILE_DECODED_BYTES) continue'
    )
    expect(soleLine(inspect, 'if (counted >=', 'file quota condition')).toBe(
      'if (counted >= MAX_CHAT_FILES || credited + dataBase64.length > MAX_FILE_BASE64_BYTES_TOTAL) {'
    )
    expect(soleLine(inspect, '!SHA256_HEX_RE.test(', 'digest condition')).toBe(
      '!SHA256_HEX_RE.test(digest.hex)'
    )
    const exceeds = functionSource(sources.rpcProxy, 'chatBodyExceedsNonImageBudget', 'rpc-proxy')
    expect(soleLine(exceeds, 'return rawBodyBytes', 'non-image share condition')).toBe(
      'return rawBodyBytes - images.creditedBase64 - files.creditedBase64 > MAX_NON_IMAGE_BODY_BYTES'
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
      [
        'CODEX_COMPOSER_MAX_IMAGE_BYTES',
        constantValue(sources.rpcProxy, 'MAX_IMAGE_DECODED_BYTES', 'rpc-proxy'),
      ],
      [
        'CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES',
        constantValue(sources.rpcProxy, 'MAX_IMAGE_DECODED_BYTES_TOTAL', 'rpc-proxy'),
      ],
      // The composer counts images and files together, as the Host admission does;
      // MAX_CHAT_FILES bounds only the credited files.
      [
        'COMPOSER_MAX_ATTACHMENTS',
        constantValue(sources.hostAdmission, 'INCOMING_ATTACHMENT_MAX_COUNT', 'mcp-host admission'),
      ],
    ]
    for (const [name, serverValue] of composer) {
      expect(constantValue(sources.composer, name, 'composer'), name).toBe(serverValue)
    }
  })

  it('the composer counts the Codex image quota in decoded bytes, as both parsers do', () => {
    const budget = functionSource(sources.composer, 'composerImageBudget', 'composer')
    const codexBranch = soleMatch(
      budget,
      /if \(provider === CODEX_SUBSCRIPTION_PROVIDER\) \{[\s\S]*?\n {2}\}/,
      'composer Codex branch'
    )[0]
    expect(soleLine(codexBranch, 'counts: ', 'composer Codex total unit')).toBe(
      "counts: 'decoded',"
    )
    expect(soleLine(codexBranch, 'maxBytes: ', 'composer Codex total limit')).toBe(
      'maxBytes: CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES,'
    )
    // A decoded total sums each image's decoded size, which the composer holds as
    // `sizeBytes` (the bytes it read from the file) and both parsers recompute
    // from the base64 they receive.
    const counted = functionSource(sources.composer, 'composerImageCountedBytes', 'composer')
    expect(soleLine(counted, 'return ', 'composer counted bytes')).toBe(
      "return total.counts === 'base64' ? attachment.dataBase64.length : attachment.sizeBytes"
    )
    // Both refuse only above the quota: a set that fills it exactly is admitted.
    const inspect = functionSource(sources.rpcProxy, 'inspectChatImageBudget', 'rpc-proxy')
    expect(soleLine(inspect, 'if (counted >=', 'image quota condition')).toBe(
      'if (counted >= MAX_CHAT_IMAGES || decodedTotal + decoded > MAX_IMAGE_DECODED_BYTES_TOTAL) {'
    )
  })

  it('the composer estimates the non-image share and the file quota from these constants', () => {
    // The estimate constants have no server counterpart: they bound the JSON
    // around the text and the attachments. Pin them and every place the
    // estimate uses them, so a changed literal or a dropped term fails here.
    expect(constantValue(sources.composer, 'COMPOSER_REQUEST_ENVELOPE_BYTES', 'composer')).toBe(
      4096
    )
    expect(constantValue(sources.composer, 'COMPOSER_FILE_ENTRY_METADATA_BYTES', 'composer')).toBe(
      640
    )
    const admission = sources.composerAdmission
    const lines: ReadonlyArray<readonly [string, string, string]> = [
      ['jsonBytes', 'return ', 'return textEncoder.encode(JSON.stringify(value)).length'],
      ['base64Length', 'return ', 'return Math.ceil(sizeBytes / 3) * 4'],
      [
        'composerFileDetailBytes',
        'return ',
        'return jsonBytes(file.filename) + COMPOSER_FILE_ENTRY_METADATA_BYTES',
      ],
      [
        'composerFileBase64Bytes',
        'return ',
        'return files.reduce((total, file) => total + base64Length(file.sizeBytes), 0)',
      ],
      [
        'composerNonImageShareBytes',
        'COMPOSER_REQUEST_ENVELOPE_BYTES',
        'COMPOSER_REQUEST_ENVELOPE_BYTES +',
      ],
      [
        'composerNonImageShareBytes',
        'COMPOSER_FORWARDED_FIELDS_BYTES',
        'COMPOSER_FORWARDED_FIELDS_BYTES +',
      ],
      ['composerNonImageShareBytes', 'jsonBytes(request.content)', 'jsonBytes(request.content) +'],
      [
        'composerNonImageShareBytes',
        '(request.fileReferences.length',
        '(request.fileReferences.length ? jsonBytes(request.fileReferences) : 0) +',
      ],
      [
        'composerNonImageShareBytes',
        '2 * jsonBytes(request.hostRef)',
        '2 * jsonBytes(request.hostRef) +',
      ],
      [
        'composerNonImageShareBytes',
        'request.files.reduce(',
        'request.files.reduce((total, file) => total + composerFileDetailBytes(file), 0) +',
      ],
      [
        'composerNonImageShareBytes',
        '(total, image) =>',
        '(total, image) => total + jsonBytes(image.name) + COMPOSER_FILE_ENTRY_METADATA_BYTES,',
      ],
      [
        'composerFileAdmissionError',
        'if (file.size >',
        'if (file.size > COMPOSER_MAX_FILE_BYTES) {',
      ],
      [
        'composerFileAdmissionError',
        'if (context.attachedCount',
        'if (context.attachedCount >= COMPOSER_MAX_ATTACHMENTS) {',
      ],
      [
        'composerFileAdmissionError',
        'if (composerFileBase64Bytes(',
        'if (composerFileBase64Bytes(files) > COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES) {',
      ],
      [
        'composerFileAdmissionError',
        'const bodyBytes =',
        'const bodyBytes = composerNonImageShareBytes({ ...context.request, files })',
      ],
      [
        'composerFileAdmissionError',
        'if (bodyBytes >',
        'if (bodyBytes > COMPOSER_MAX_NON_IMAGE_BODY_BYTES) {',
      ],
    ]
    for (const [name, prefix, expected] of lines) {
      const body = functionSource(admission, name, 'composer admission')
      expect(soleLine(body, prefix, `composer admission ${name} ${prefix}`)).toBe(expected)
    }
    // The non-image share is the sum of exactly the terms pinned above.
    const share = functionSource(admission, 'composerNonImageShareBytes', 'composer admission')
    expect(share.match(/ \+$/gm), 'composerNonImageShareBytes term count').toHaveLength(6)
  })

  it('the composer reserves the headroom rpc-proxy is tested to add when forwarding', () => {
    expect(constantValue(sources.composer, 'COMPOSER_FORWARDED_FIELDS_BYTES', 'composer')).toBe(
      constantValue(
        sources.rpcProxyForwardingTest,
        'DESKTOP_FORWARDED_FIELDS_HEADROOM_BYTES',
        'rpc-proxy forwarding test'
      )
    )
  })

  it('the Host admission default and configured maximum equal the per-file credit ceiling', () => {
    const [, literal, maximum] = soleMatch(
      sources.hostConfig,
      /getExecutionLimit\(\s*'CLERUM_ATTACHMENT_FILE_MAX_BYTES',\s*([0-9_]+),\s*false,\s*([0-9_]+)\s*\)/,
      'mcp-host config CLERUM_ATTACHMENT_FILE_MAX_BYTES bounds'
    )
    const ceiling = constantValue(sources.mcpHost, 'MAX_FILE_DECODED_BYTES', 'mcp-host')
    expect(Number(literal.replaceAll('_', ''))).toBe(ceiling)
    expect(Number(maximum.replaceAll('_', ''))).toBe(ceiling)
  })
})
