import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..', '..', '..')

function productionSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '__tests__' || name === 'node_modules') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue
      out.push({ rel: relative(SRC, full), text: readFileSync(full, 'utf8') })
    }
  }
  walk(SRC)
  return out
}

describe('approval mode writer surfaces', () => {
  const sources = productionSources()

  it('calls setApprovalMode only from the route and the messaging command', () => {
    const callers = sources
      .filter(source => /\.setApprovalMode\s*\(/.test(source.text))
      .map(source => source.rel)
      .sort()
    expect(callers).toEqual(['agent/incomingAdmission.ts', 'agent/sessionApprovalMode.ts'])
  })

  it('sets GetOrCreateOptions.approvalMode only in prepareIncomingMessage', () => {
    const setters: string[] = []
    for (const source of sources) {
      const pattern = /\.getOrCreate(?:Detailed)?\s*\(/g
      for (const match of source.text.matchAll(pattern)) {
        const call = source.text.slice(match.index ?? 0, (match.index ?? 0) + 700)
        const setsOption = /approvalMode\s*:/.test(call) || /[{,]\s*approvalMode\s*[,}]/.test(call)
        if (setsOption) setters.push(source.rel)
      }
    }
    expect([...new Set(setters)].sort()).toEqual(['agent/incomingAdmission.ts'])
    const admission = sources.find(source => source.rel === 'agent/incomingAdmission.ts')
    expect(admission).toBeDefined()
    const fnAt = admission!.text.indexOf('function prepareIncomingMessage')
    expect(fnAt).toBeGreaterThanOrEqual(0)
    const callAt = admission!.text.indexOf('getOrCreateDetailed')
    expect(callAt).toBeGreaterThan(fnAt)
    const selection = sources.find(source => source.rel === 'agent/sessionModelSelection.ts')
    expect(selection?.text).not.toContain('approvalMode')
  })

  it('reads the ceiling from spec.approval, and from the env config only in dev mode', () => {
    const main = sources.find(source => source.rel === 'main.ts')
    expect(main).toBeDefined()
    expect(main!.text).toContain(
      'const hostSpec = config.devMode ? config.approvalConfig : host.spec.approval'
    )
    expect(main!.text).toContain(
      'agent.setApprovalConfig(approvalCfg, config.devMode ? config.approvalConfig : undefined)'
    )
    expect(main!.text).not.toMatch(/hostSpec\s*=\s*config\.approvalConfig\b/)
  })

  it('keeps the SQLite worker from computing the ceiling, the cap, or the effective mode', () => {
    const dispatcher = sources.find(source => source.rel === 'db/worker/dispatcher.ts')
    expect(dispatcher).toBeDefined()
    expect(dispatcher!.text).not.toMatch(
      /modeCeiling|channelCap|effectiveApprovalMode|classifierAvailable|readModeCeiling|readChannelCap/
    )
  })
})
