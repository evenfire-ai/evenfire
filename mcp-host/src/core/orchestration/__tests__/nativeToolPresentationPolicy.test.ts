import { describe, expect, it } from 'vitest'
import { BRIDGE_TOOL_NAMES } from '../../../capabilities/toolCatalogTools'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'
import {
  DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES,
  parseNativeToolDiscoveryBytes,
  parseNativeToolPresentation,
  selectDeferredNatives,
} from '../toolPresentationPolicy'

const nativeConfig = {
  workspacePath: '/tmp',
  shellTimeout: 1000,
  toolTimeout: 1000,
  toolProgressInterval: 0,
  httpAllowlist: [],
  envAllowlist: [],
  memoryMaxSize: 1000,
}
const productionRegistry = (discovery?: { mcpDiscovery: boolean; nativeDiscovery: boolean }) =>
  new NativeToolRegistry(
    nativeConfig,
    'native-policy-test',
    undefined,
    undefined,
    undefined,
    () => ({}),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    discovery
  )

describe('CLERUM_NATIVE_TOOL_PRESENTATION parsing', () => {
  it('defaults to direct when unset', () => {
    expect(parseNativeToolPresentation(undefined)).toBe('direct')
  })

  it.each(['direct', 'auto'] as const)('accepts %s', value => {
    expect(parseNativeToolPresentation(value)).toBe(value)
  })

  it.each(['', ' ', 'AUTO', ' auto', 'discovery', 'off'])('rejects %j', value => {
    expect(() => parseNativeToolPresentation(value)).toThrow(
      `CLERUM_NATIVE_TOOL_PRESENTATION must be direct or auto (got ${JSON.stringify(value)})`
    )
  })
})

describe('CLERUM_NATIVE_TOOL_DISCOVERY_BYTES parsing', () => {
  it('defaults to 2048 bytes when unset', () => {
    expect(DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES).toBe(2048)
    expect(parseNativeToolDiscoveryBytes(undefined)).toBe(2048)
  })

  it.each(['1', '2048', String(Number.MAX_SAFE_INTEGER)])('accepts %s', value => {
    expect(parseNativeToolDiscoveryBytes(value)).toBe(Number(value))
  })

  it.each(['', ' ', ' 2048', '2048 ', '0', '-1', '1e3', '+5', '1.5', '01', String(2 ** 53)])(
    'rejects %j',
    value => {
      expect(() => parseNativeToolDiscoveryBytes(value)).toThrow(
        `CLERUM_NATIVE_TOOL_DISCOVERY_BYTES must be a positive safe integer (got ${JSON.stringify(value)})`
      )
    }
  )
})

describe('selectDeferredNatives on the production native registry', () => {
  const registry = productionRegistry({ mcpDiscovery: false, nativeDiscovery: true })
  const definitions = registry.listDefinitions()
  const bytes = (name: string) =>
    Buffer.byteLength(JSON.stringify(definitions.find(def => def.name === name)), 'utf8')

  it('hides exactly the five generators at the 2048 B default', () => {
    expect(
      [...selectDeferredNatives(definitions, DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES)].sort()
    ).toEqual([
      'clerum__generate_chart',
      'clerum__generate_dashboard',
      'clerum__generate_pdf',
      'clerum__generate_pptx',
      'clerum__generate_xlsx',
    ])
  })

  it('keeps docx and markdown advertised, with docx the closest to the budget', () => {
    expect(definitions.map(def => def.name)).toEqual(
      expect.arrayContaining(['clerum__generate_docx', 'clerum__generate_markdown'])
    )
    // A docx description that grows past the budget must turn this test red.
    expect(bytes('clerum__generate_docx')).toBeLessThanOrEqual(DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES)
    expect(bytes('clerum__generate_markdown')).toBeLessThanOrEqual(
      DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES
    )
  })

  it('never selects bridge tools, whatever the budget', () => {
    expect(definitions.map(def => def.name)).toEqual(expect.arrayContaining([...BRIDGE_TOOL_NAMES]))
    const selected = selectDeferredNatives(definitions, 1)
    // Witness: a 1 B budget selects every other native.
    expect(selected.size).toBe(definitions.length - BRIDGE_TOOL_NAMES.size)
    for (const bridge of BRIDGE_TOOL_NAMES) expect(selected.has(bridge)).toBe(false)
  })

  it('registers no bridge tools without a discovery argument (main.ts tool-name snapshot)', () => {
    const names = productionRegistry()
      .listDefinitions()
      .map(def => def.name)
    // Witness: the snapshot still lists the generators.
    expect(names).toContain('clerum__generate_pptx')
    for (const bridge of BRIDGE_TOOL_NAMES) expect(names).not.toContain(bridge)
    expect(names.length).toBe(definitions.length - BRIDGE_TOOL_NAMES.size)
  })

  it('MCP discovery needs an McpManager to register the bridge; native discovery does not', () => {
    const mcpOnly = productionRegistry({ mcpDiscovery: true, nativeDiscovery: false })
    const names = mcpOnly.listDefinitions().map(def => def.name)
    for (const bridge of BRIDGE_TOOL_NAMES) expect(names).not.toContain(bridge)
    // Witness: native discovery on the same (manager-less) registry registers all three.
    expect(definitions.map(def => def.name)).toEqual(expect.arrayContaining([...BRIDGE_TOOL_NAMES]))
  })
})
