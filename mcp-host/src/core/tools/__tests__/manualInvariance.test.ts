/**
 * P1-T11: in manual, PR 1 changes no tool the model sees except
 * json_transform. The literals were captured from the tree before PR 1
 * (feat 8b3da2e2b) with the same normalization: the shell description embeds
 * this machine's Node and exceljs paths, so both are replaced by markers.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

const SHELL_BEFORE = {
  name: 'shell_exec',
  description:
    'Execute a shell command in the workspace directory. Supports full shell syntax (pipes, redirects, &&, etc.). Commands run with a timeout and restricted environment. Node.js executable: "<node>". Resolve installed Host libraries with require(\'node:module\').createRequire("<exceljs>"); load fast-csv through that resolver and use parseStream for streaming CSV parsing (exceljs.csv is not available). Verify any other executable or library before using it. This tool requires approval before execution.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          "The shell command to execute (e.g., 'ls -la', 'echo hello | wc -c', 'git status')",
      },
    },
    required: ['command'],
  },
}

const JSON_TRANSFORM_BEFORE = {
  name: 'json_transform',
  description:
    'Parse, query, and transform JSON data. Supports parsing JSON strings, extracting nested values by dot-path, and basic transformations (keys, values, filter, map).',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'JSON string to process' },
      operation: {
        type: 'string',
        enum: ['parse', 'get', 'keys', 'values', 'length', 'stringify'],
        description: 'Operation to perform',
      },
      path: {
        type: 'string',
        description: "Dot-separated path for 'get' operation (e.g., 'data.items.0.name')",
      },
    },
    required: ['input', 'operation'],
  },
}

/** sha256 of every other native definition, in registry order, before PR 1. */
const OTHERS_BEFORE_SHA256 = '39ba39310f7c1c73f0fec493d88f5546dd72aa031620483dc382c6ffab3a76ea'

function normalizedDefinitions(): Array<{ name: string; description: string }> {
  const node = JSON.stringify(process.execPath)
  const exceljs = JSON.stringify(require.resolve('exceljs'))
  return new NativeToolRegistry(config, 'conv').listDefinitions().map(definition => ({
    ...definition,
    description: definition.description
      .split(node)
      .join('"<node>"')
      .split(exceljs)
      .join('"<exceljs>"'),
  }))
}

describe('manual invariance (P1-T11)', () => {
  it('the shell description and schema are byte-equal to the tree before PR 1', () => {
    const shell = normalizedDefinitions().find(d => d.name === 'shell_exec')
    expect(JSON.stringify(shell)).toBe(JSON.stringify(SHELL_BEFORE))
  })

  it('every native definition other than json_transform is unchanged, and git_read is absent without a probe', () => {
    const definitions = normalizedDefinitions()
    expect(definitions.map(d => d.name)).not.toContain('git_read')
    const others = definitions.filter(d => d.name !== 'json_transform')
    expect(createHash('sha256').update(JSON.stringify(others)).digest('hex')).toBe(
      OTHERS_BEFORE_SHA256
    )
  })

  it('json_transform is the one definition PR 1 changes', () => {
    const jsonTransform = normalizedDefinitions().find(d => d.name === 'json_transform')
    expect(jsonTransform).toBeDefined()
    expect(JSON.stringify(jsonTransform)).not.toBe(JSON.stringify(JSON_TRANSFORM_BEFORE))
    expect(jsonTransform!.description).not.toMatch(/filter|map/)
  })
})
