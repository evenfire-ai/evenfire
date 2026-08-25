import { describe, expect, it } from 'vitest'
import {
  boundedEnvBytesFromSource,
  staticExportedBytesFromSource,
} from './helpers/staticSourceAuthority.js'

const SYMBOL = 'GFS_UPLOAD_V2_MAX_PART_BYTES'
const OBJECT = 'config'
const PROPERTY = 'gfsUploadMaxPartBytes'
const ENV = 'CONTROL_API_GFS_UPLOAD_MAX_PART_BYTES'
const BOUNDED_CALL = `boundedIntegerFromEnv('${ENV}', 16 * 1024 * 1024, 16 * 1024 * 1024)`

function bounded(source: string) {
  return boundedEnvBytesFromSource(source, OBJECT, PROPERTY, ENV)
}

describe('bounded static source authority', () => {
  it.each([
    [`export const ${SYMBOL} = 16 * 1024 * 1024`, 16 * 1024 * 1024],
    [`export const ${SYMBOL} = 16 * 1_024 * 1_024`, 16 * 1024 * 1024],
    [`export const ${SYMBOL} = (16 * 1024) * 1024`, 16 * 1024 * 1024],
  ])('accepts a unique direct export', (source, expected) => {
    expect(staticExportedBytesFromSource(source, SYMBOL)).toBe(expected)
  })

  it.each([
    `const ${SYMBOL} = 16 * 1024 * 1024`,
    `const local = 16 * 1024 * 1024; export { local as ${SYMBOL} }`,
    `const ${SYMBOL} = 16 * 1024 * 1024; export { ${SYMBOL} }`,
    `export const ${SYMBOL} = 16 * 1024 * 1024; function shadow() { const ${SYMBOL} = 1 }`,
    `export const ${SYMBOL} = 16 * 1024 * 1024 + 1`,
    `export const ${SYMBOL} = 16 * 1024 * 1024 / 2`,
    `export const ${SYMBOL} = 16 * 1024 * OTHER`,
    `// export const ${SYMBOL} = 16 * 1024 * 1024`,
    `/* export const ${SYMBOL} = 16 * 1024 * 1024 */`,
    `export const ${SYMBOL} = 16 * 1024 * 1024 nonsense`,
  ])('rejects ambiguous or unsupported exported authority: %s', source => {
    expect(() => staticExportedBytesFromSource(source, SYMBOL)).toThrow()
  })

  it('ignores a commented safe export before the active authority', () => {
    const source = [
      `// export const ${SYMBOL} = 16 * 1024 * 1024`,
      `export const ${SYMBOL} = 17 * 1024 * 1024`,
    ].join('\n')
    expect(staticExportedBytesFromSource(source, SYMBOL)).toBe(17 * 1024 * 1024)
  })

  it.each([
    `export const ${OBJECT} = { ${PROPERTY}: ${BOUNDED_CALL} }`,
    `export const ${OBJECT} = { '${PROPERTY}': ${BOUNDED_CALL} }`,
    `export const ${OBJECT} = { ['${PROPERTY}']: ${BOUNDED_CALL} }`,
    `export const ${OBJECT} = { [('${PROPERTY}')]: ${BOUNDED_CALL} }`,
  ])('accepts one explicit object authority: %s', source => {
    expect(bounded(source)).toEqual({
      fallback: 16 * 1024 * 1024,
      ceiling: 16 * 1024 * 1024,
    })
  })

  it.each([
    `const ${PROPERTY} = ${BOUNDED_CALL}; export const ${OBJECT} = { ${PROPERTY} }`,
    `export const ${OBJECT} = { ...other, ${PROPERTY}: ${BOUNDED_CALL} }`,
    `export const ${OBJECT} = { [authorityName]: ${BOUNDED_CALL} }`,
    `export const ${OBJECT} = { ${PROPERTY}: ${BOUNDED_CALL}, ['${PROPERTY}']: ${BOUNDED_CALL} }`,
    `export const ${OBJECT} = { ${PROPERTY}: boundedIntegerFromEnv('OTHER', 1, 1) }`,
    `export const ${OBJECT} = { ${PROPERTY}: boundedIntegerFromEnv('${ENV}', 1) }`,
  ])('rejects unresolved, duplicate, shorthand, or malformed object authority: %s', source => {
    expect(() => bounded(source)).toThrow()
  })

  it('ignores comments and unrelated properties', () => {
    const source = `export const ${OBJECT} = {
      // ${PROPERTY}: boundedIntegerFromEnv('OTHER', 1, 1),
      ${PROPERTY}Extra: boundedIntegerFromEnv('OTHER', 1, 1),
      ['unrelated']: boundedIntegerFromEnv('OTHER', 1, 1),
      ${PROPERTY}: ${BOUNDED_CALL},
    }`
    expect(bounded(source)).toEqual({
      fallback: 16 * 1024 * 1024,
      ceiling: 16 * 1024 * 1024,
    })
  })

  it('rejects a commented authority without a live assignment', () => {
    expect(() =>
      bounded(`export const ${OBJECT} = {
        // ${PROPERTY}: ${BOUNDED_CALL},
      }`)
    ).toThrow(/exactly one active authority/)
  })
})
