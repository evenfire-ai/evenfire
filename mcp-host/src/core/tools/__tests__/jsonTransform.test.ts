import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protectedWorkspacePathMessage } from '../../../workspace/protectedPaths'
import type { ToolOutput } from '../../types'
import { JSON_TRANSFORM_MAX_FILE_BYTES, JsonTransformTool } from '../jsonTransform'

/** The tool before `file` and before `path` applied to every operation (8b3da2e2b), verbatim. */
class PreviousJsonTransform {
  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const input = params.input as string
    const operation = params.operation as string
    const dotPath = params.path as string | undefined
    let parsed: any
    try {
      parsed = JSON.parse(input)
    } catch (err) {
      return {
        content: `Error parsing JSON: ${(err as Error).message}`,
        duration_ms: 0,
        is_error: true,
      }
    }
    try {
      let result: any
      switch (operation) {
        case 'parse':
          result = parsed
          break
        case 'get':
          result = dotPath ? this.getByPath(parsed, dotPath) : parsed
          break
        case 'keys':
          result = Object.keys(parsed)
          break
        case 'values':
          result = Object.values(parsed)
          break
        case 'length':
          result = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length
          break
        case 'stringify':
          result = JSON.stringify(parsed, null, 2)
          break
        default:
          return { content: `Unknown operation: ${operation}`, duration_ms: 0, is_error: true }
      }
      return {
        content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        duration_ms: 0,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Transform error: ${(err as Error).message}`,
        duration_ms: 0,
        is_error: true,
      }
    }
  }
  private getByPath(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      if (current === undefined || current === null) return undefined
      return current[key]
    }, obj)
  }
}

const OPERATIONS = ['parse', 'get', 'keys', 'values', 'length', 'stringify'] as const
const strip = (o: ToolOutput) => ({ content: o.content, is_error: o.is_error })

describe('JsonTransformTool definition', () => {
  const tool = new JsonTransformTool('/workspace')

  it('the description no longer claims filter or map', () => {
    expect(tool.description()).toBe(
      'Parse, query and transform JSON from a string (input) or a workspace JSON file (file). ' +
        'get returns the value at a dot path; keys, values and length apply to that value ' +
        '(the root when path is empty).'
    )
    expect(tool.description()).not.toMatch(/filter|map/)
  })

  it('required is only operation, and the schema is a plain object schema', () => {
    const schema = tool.parametersSchema()
    expect(schema.required).toEqual(['operation'])
    expect(Object.keys(schema.properties as object)).toEqual(['input', 'file', 'operation', 'path'])
    expect(JSON.stringify(schema)).not.toMatch(/oneOf|anyOf|allOf/)
  })

  it('sanitizes every result and asks for no approval of its own', () => {
    expect(tool.requiresSanitization()).toBe(true)
    expect(tool.requiresApproval()).toBe(false)
  })

  it('a file call inherits file_read for approval overrides and guardrail rules', () => {
    expect(tool.approvalAlso({ file: 'a.json', operation: 'get' })).toEqual(['file_read'])
    expect(tool.fileReads({ file: 'a.json', operation: 'get' })).toEqual({ paths: ['a.json'] })
    expect(tool.approvalAlso({ input: '{}', operation: 'get' })).toEqual([])
    expect(tool.fileReads({ input: '{}', operation: 'get' })).toBeUndefined()
  })
})

describe('JsonTransformTool validateParams', () => {
  const tool = new JsonTransformTool('/workspace')
  const errors = (params: Record<string, unknown>) => tool.validateParams(params).errors

  it('wants exactly one of input and file', () => {
    expect(errors({ operation: 'get' })).toEqual(['Provide exactly one of input and file.'])
    expect(errors({ input: '{}', file: 'a.json', operation: 'get' })).toEqual([
      'Provide exactly one of input and file.',
    ])
    expect(errors({ input: 5, operation: 'get' })).toEqual([
      'Provide exactly one of input and file.',
    ])
    expect(errors({ file: ['a.json'], operation: 'get' })).toEqual([
      'Provide exactly one of input and file.',
    ])
    expect(tool.validateParams({ input: '{}', operation: 'get' })).toEqual({
      is_valid: true,
      errors: [],
    })
    expect(tool.validateParams({ file: 'a.json', operation: 'get' })).toEqual({
      is_valid: true,
      errors: [],
    })
  })

  it('treats an explicit null as an absent field', () => {
    expect(tool.validateParams({ input: '{}', file: null, operation: 'get', path: null })).toEqual({
      is_valid: true,
      errors: [],
    })
    expect(tool.validateParams({ input: null, file: 'a.json', operation: 'get' })).toEqual({
      is_valid: true,
      errors: [],
    })
    expect(errors({ input: null, file: null, operation: 'get' })).toEqual([
      'Provide exactly one of input and file.',
    ])
  })

  it('checks the operation and the path type', () => {
    expect(errors({ input: '{}', operation: 'filter' })).toEqual([
      'operation must be one of parse, get, keys, values, length, stringify.',
    ])
    expect(errors({ input: '{}', operation: 'get', path: 3 })).toEqual(['path must be a string.'])
  })

  it('execute refuses a call that skipped validation', async () => {
    expect(strip(await tool.execute({ operation: 'get' }))).toEqual({
      content: 'Provide exactly one of input and file.',
      is_error: true,
    })
  })
})

describe('JsonTransformTool with input', () => {
  const tool = new JsonTransformTool()
  const previous = new PreviousJsonTransform()
  const corpus = [
    '{"a":{"b":[1,2,{"c":"x"}]},"n":null,"s":"str"}',
    '[3,"two",{"k":1}]',
    '"abc"',
    '42',
    'true',
    'null',
    '{}',
    '[]',
    '{bad json',
  ]

  it('no path is byte-identical to the old tool for every operation', async () => {
    let compared = 0
    for (const input of corpus) {
      for (const operation of OPERATIONS) {
        for (const params of [
          { input, operation },
          { input, operation, path: '' },
          { input, operation, path: null },
          { input, operation, file: null },
        ]) {
          const now = strip(await tool.execute(params))
          const before = strip(await previous.execute(params))
          expect(now, `${operation} ${input} ${JSON.stringify(params.path)}`).toEqual(before)
          compared++
        }
      }
    }
    expect(compared).toBe(corpus.length * OPERATIONS.length * 4)
  })

  it('no path keeps the literal outputs for scalar and null inputs', async () => {
    expect(strip(await tool.execute({ input: '5', operation: 'keys' }))).toEqual({
      content: '[]',
      is_error: false,
    })
    expect(strip(await tool.execute({ input: '"ab"', operation: 'values' }))).toEqual({
      content: '[\n  "a",\n  "b"\n]',
      is_error: false,
    })
    expect(strip(await tool.execute({ input: 'null', operation: 'keys' }))).toEqual({
      content: 'Transform error: Cannot convert undefined or null to object',
      is_error: true,
    })
  })

  it('get with a path that exists is unchanged', async () => {
    const input = '{"data":{"items":[{"name":"first"}]}}'
    for (const path of ['data.items.0.name', 'data.items', 'data']) {
      expect(strip(await tool.execute({ input, operation: 'get', path }))).toEqual(
        strip(await previous.execute({ input, operation: 'get', path }))
      )
    }
  })

  it('keys, values and length apply to the value at path', async () => {
    const input = '{"a":{"x":1,"y":[true,false]},"list":[1,2,3]}'
    expect(strip(await tool.execute({ input, operation: 'keys', path: 'a' }))).toEqual({
      content: '[\n  "x",\n  "y"\n]',
      is_error: false,
    })
    expect(strip(await tool.execute({ input, operation: 'values', path: 'a.y' }))).toEqual({
      content: '[\n  true,\n  false\n]',
      is_error: false,
    })
    expect(strip(await tool.execute({ input, operation: 'length', path: 'list' }))).toEqual({
      content: '3',
      is_error: false,
    })
    expect(strip(await tool.execute({ input, operation: 'length', path: 'a' }))).toEqual({
      content: '2',
      is_error: false,
    })
    expect(strip(await tool.execute({ input, operation: 'parse', path: 'a.x' }))).toEqual({
      content: '1',
      is_error: false,
    })
    expect(strip(await tool.execute({ input, operation: 'stringify', path: 'a' }))).toEqual({
      content: '{\n  "x": 1,\n  "y": [\n    true,\n    false\n  ]\n}',
      is_error: false,
    })
  })

  it('a missing path is null for get and an error naming the path for keys, values and length', async () => {
    const input = '{"a":{"x":1}}'
    expect(strip(await tool.execute({ input, operation: 'get', path: 'a.missing' }))).toEqual({
      content: 'null',
      is_error: false,
    })
    for (const operation of ['keys', 'values', 'length']) {
      expect(strip(await tool.execute({ input, operation, path: 'a.missing' }))).toEqual({
        content: 'Transform error: no value at path a.missing',
        is_error: true,
      })
    }
  })

  it('keys and values need an object or array at the path', async () => {
    expect(strip(await tool.execute({ input: '{"a":1}', operation: 'keys', path: 'a' }))).toEqual({
      content: 'Transform error: keys needs an object or array at path',
      is_error: true,
    })
    expect(
      strip(await tool.execute({ input: '{"a":null}', operation: 'values', path: 'a' }))
    ).toEqual({
      content: 'Transform error: values needs an object or array at path',
      is_error: true,
    })
  })

  it('a path never reaches a prototype member', async () => {
    for (const path of ['constructor', '__proto__', 'a.toString', 'a.hasOwnProperty']) {
      expect(strip(await tool.execute({ input: '{"a":{}}', operation: 'get', path }))).toEqual({
        content: 'null',
        is_error: false,
      })
    }
  })
})

describe('JsonTransformTool with file', () => {
  let root: string
  const SECRET_NEEDLE = 'NEEDLE_FILE_BYTES_7f3a'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'json-transform-'))
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'a.json'), '{"items":[{"name":"first"},{"name":"second"}]}')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads a workspace JSON file and applies the operation at path', async () => {
    const tool = new JsonTransformTool(root)
    expect(
      strip(await tool.execute({ file: 'data/a.json', operation: 'get', path: 'items.1.name' }))
    ).toEqual({ content: 'second', is_error: false })
    expect(
      strip(await tool.execute({ file: 'data/a.json', operation: 'length', path: 'items' }))
    ).toEqual({ content: '2', is_error: false })
  })

  it('a file with no root is refused', async () => {
    const tool = new JsonTransformTool()
    expect(strip(await tool.execute({ file: 'data/a.json', operation: 'get' }))).toEqual({
      content: 'Error: file input is not available on this Host.',
      is_error: true,
    })
  })

  it('invalid JSON in a file returns the fixed text and no file bytes', async () => {
    writeFileSync(join(root, 'data', 'bad.json'), `{"k": ${SECRET_NEEDLE}`)
    const tool = new JsonTransformTool(root)
    const result = await tool.execute({ file: 'data/bad.json', operation: 'parse' })
    expect(strip(result)).toEqual({ content: 'Error: the file is not valid JSON.', is_error: true })
    // Control: the same bytes as input do echo through the parser message.
    const asInput = await tool.execute({ input: `{"k": ${SECRET_NEEDLE}`, operation: 'parse' })
    expect(asInput.content).toContain(SECRET_NEEDLE.slice(0, 6))
  })

  it('a protected platform path is refused as file_read refuses it', async () => {
    const tool = new JsonTransformTool(root)
    for (const file of ['state.db', '.clerum-state/session.json']) {
      expect(strip(await tool.execute({ file, operation: 'parse' }))).toEqual({
        content: protectedWorkspacePathMessage(file),
        is_error: true,
      })
    }
  })

  it('absolute paths, traversal and links that leave the root are refused', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'json-transform-outside-'))
    try {
      writeFileSync(join(outside, 'secret.json'), `{"s":"${SECRET_NEEDLE}"}`)
      symlinkSync(join(outside, 'secret.json'), join(root, 'data', 'link.json'))
      const tool = new JsonTransformTool(root)
      const cases: Array<[string, string]> = [
        [join(outside, 'secret.json'), 'Error: Absolute paths not allowed'],
        ['../secret.json', 'Error: Directory traversal (..) not allowed'],
        ['data/link.json', 'Error: Path resolves outside workspace (symlink)'],
      ]
      for (const [file, content] of cases) {
        const result = await tool.execute({ file, operation: 'parse' })
        expect(strip(result), file).toEqual({ content, is_error: true })
        expect(result.content).not.toContain(SECRET_NEEDLE)
      }
      // Control: a link that stays inside the root is read.
      symlinkSync(join(root, 'data', 'a.json'), join(root, 'data', 'inside.json'))
      expect(
        strip(await tool.execute({ file: 'data/inside.json', operation: 'length', path: 'items' }))
      ).toEqual({ content: '2', is_error: false })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a FIFO is refused at once instead of waiting for a writer', async () => {
    const fifo = join(root, 'data', 'pipe.json')
    execFileSync('mkfifo', [fifo])
    const tool = new JsonTransformTool(root)
    const started = Date.now()
    expect(strip(await tool.execute({ file: 'data/pipe.json', operation: 'parse' }))).toEqual({
      content: 'Error: not a file',
      is_error: true,
    })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a directory, a missing file and a file over 5 MiB are refused with fixed text', async () => {
    const tool = new JsonTransformTool(root)
    expect(strip(await tool.execute({ file: 'data', operation: 'parse' }))).toEqual({
      content: 'Error: not a file',
      is_error: true,
    })
    expect(strip(await tool.execute({ file: 'data/none.json', operation: 'parse' }))).toEqual({
      content: 'Error: file not found.',
      is_error: true,
    })
    const big = join(root, 'data', 'big.json')
    writeFileSync(big, '[]')
    truncateSync(big, JSON_TRANSFORM_MAX_FILE_BYTES + 1)
    expect(strip(await tool.execute({ file: 'data/big.json', operation: 'parse' }))).toEqual({
      content: 'Error: the file is larger than 5 MiB.',
      is_error: true,
    })
    // Control: exactly at the limit is read (and is not valid JSON here).
    truncateSync(big, JSON_TRANSFORM_MAX_FILE_BYTES)
    expect(strip(await tool.execute({ file: 'data/big.json', operation: 'parse' }))).toEqual({
      content: 'Error: the file is not valid JSON.',
      is_error: true,
    })
  })
})
