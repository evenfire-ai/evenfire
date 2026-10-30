// The reference texts the delivered-package scan leaves to the payload check.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({
  failNextTempDir: false,
  hangDocx: false,
  docxBuilds: 0,
  /** Ends the build that hangs, as a failure. */
  release: undefined as (() => void) | undefined,
}))

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
    runGenerateDocx: (...args: Parameters<typeof actual.runGenerateDocx>) => {
      control.docxBuilds++
      if (!control.hangDocx) return actual.runGenerateDocx(...args)
      return new Promise<Awaited<ReturnType<typeof actual.runGenerateDocx>>>(resolve => {
        control.release = () => resolve({ success: false, error: 'released' })
      })
    },
  }
})

/** The docx reference, once a build in the background has written it. */
async function builtTexts(texts: (format: 'docx') => Promise<string[]>): Promise<string[]> {
  for (let tries = 0; tries < 200; tries++) {
    const found = await texts('docx')
    if (found.length > 0) return found
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return []
}

async function freshModule() {
  vi.resetModules()
  return import('../officeBoilerplate')
}

describe('boilerplateTexts', () => {
  beforeEach(() => {
    control.failNextTempDir = false
    control.hangDocx = false
    control.docxBuilds = 0
    control.release = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds no timestamp of the moment the reference was written', async () => {
    const { boilerplateTexts } = await freshModule()
    const texts = await boilerplateTexts('docx')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some(text => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text))).toBe(false)
  })

  it('tries a failed build again once REFERENCE_RETRY_MS has passed, not on every call', async () => {
    const { REFERENCE_RETRY_MS, boilerplateTexts } = await freshModule()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    control.failNextTempDir = true
    expect(await boilerplateTexts('docx')).toEqual([])
    expect(await boilerplateTexts('docx')).toEqual([])
    expect(control.docxBuilds).toBe(0)
    now.mockReturnValue(1_000_000 + REFERENCE_RETRY_MS)
    // The call that starts the retry checks without it; a later one has it.
    expect(await boilerplateTexts('docx')).toEqual([])
    expect(await builtTexts(boilerplateTexts)).not.toEqual([])
    expect(control.docxBuilds).toBe(1)
  })

  it('does not make a call wait for a build that retries a failed one', async () => {
    const { REFERENCE_RETRY_MS, boilerplateTexts } = await freshModule()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    control.failNextTempDir = true
    expect(await boilerplateTexts('docx')).toEqual([])
    now.mockReturnValue(1_000_000 + REFERENCE_RETRY_MS)
    control.hangDocx = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const texts = boilerplateTexts('docx').then(found => {
      settled = true
      return found
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(await texts).toEqual([])
  })

  it('does not wait past REFERENCE_WAIT_MS for a build that never ends', async () => {
    const { REFERENCE_WAIT_MS, boilerplateTexts } = await freshModule()
    control.hangDocx = true
    vi.useFakeTimers()
    const texts = boilerplateTexts('docx')
    await vi.advanceTimersByTimeAsync(REFERENCE_WAIT_MS)
    expect(await texts).toEqual([])
  })

  it('gives up a build that never ends, and builds again only once it has stopped', async () => {
    const { REFERENCE_BUILD_MS, REFERENCE_RETRY_MS, boilerplateTexts } = await freshModule()
    control.hangDocx = true
    vi.useFakeTimers()
    const first = boilerplateTexts('docx')
    await vi.advanceTimersByTimeAsync(REFERENCE_BUILD_MS)
    expect(await first).toEqual([])
    vi.useRealTimers()
    control.hangDocx = false
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + REFERENCE_BUILD_MS + REFERENCE_RETRY_MS)
    // The given-up build still runs, so no second one starts beside it.
    expect(await boilerplateTexts('docx')).toEqual([])
    expect(control.docxBuilds).toBe(1)
    control.release!()
    expect(await builtTexts(boilerplateTexts)).not.toEqual([])
    expect(control.docxBuilds).toBe(2)
  })
})
