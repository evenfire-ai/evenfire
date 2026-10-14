// The reference texts the delivered-package scan leaves to the payload check.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ failNextTempDir: false, hangDocx: false }))

vi.mock('fs', async original => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    mkdtempSync: (prefix: string) => {
      if (control.failNextTempDir) {
        control.failNextTempDir = false
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      }
      return actual.mkdtempSync(prefix)
    },
  }
})

vi.mock('../docxGenerator', async original => {
  const actual = await original<typeof import('../docxGenerator')>()
  return {
    ...actual,
    runGenerateDocx: (...args: Parameters<typeof actual.runGenerateDocx>) =>
      control.hangDocx ? new Promise(() => {}) : actual.runGenerateDocx(...args),
  }
})

async function freshModule() {
  vi.resetModules()
  return import('../officeBoilerplate')
}

describe('boilerplateTexts', () => {
  beforeEach(() => {
    control.failNextTempDir = false
    control.hangDocx = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds no timestamp of the moment the reference was written', async () => {
    const { boilerplateTexts } = await freshModule()
    const texts = await boilerplateTexts('docx')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some(text => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text))).toBe(false)
  })

  it('tries a failed build again on the next call', async () => {
    const { boilerplateTexts } = await freshModule()
    control.failNextTempDir = true
    expect(await boilerplateTexts('xlsx')).toEqual([])
    expect((await boilerplateTexts('xlsx')).length).toBeGreaterThan(0)
  })

  it('does not wait past REFERENCE_WAIT_MS for a build that never ends', async () => {
    const { REFERENCE_WAIT_MS, boilerplateTexts } = await freshModule()
    control.hangDocx = true
    vi.useFakeTimers()
    const texts = boilerplateTexts('docx')
    await vi.advanceTimersByTimeAsync(REFERENCE_WAIT_MS)
    expect(await texts).toEqual([])
  })
})
