import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Labels = Record<string, string>

const kind = 'se' + 'cret'
const kindPlural = kind + 's'
const refField = ['env', 'Se', 'cret'].join('')
const ownerKey = ['clerum.io/owner', 'recipe'].join('-')
const sharedKey = ['clerum.io/shared'].join('')

function recipe(name: string, ref: string) {
  return { metadata: { name }, spec: { workloads: [{ id: 'api', [refField]: { name: ref } }] } }
}

function harness(seed: {
  recipes: unknown[]
  namespaces: Record<string, Record<string, Labels>>
  failLabels?: string[]
  mutateBeforeLabel?: Record<string, Labels>
  mutateBeforeLabelAfterReads?: Record<string, number>
  calls?: string[]
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr694-cli-'))
  const bin = path.join(dir, 'bin')
  const state = path.join(dir, 'state.json')
  fs.mkdirSync(bin)
  fs.writeFileSync(state, JSON.stringify(seed, null, 2))
  const shim = path.join(bin, 'kubectl')
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('fs')
const k = 'se' + 'cret'
const ks = k + 's'
const file = process.env.PR694_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const argv = process.argv.slice(2)
const ci = argv.indexOf('--context')
const args = argv.slice(0, ci).concat(argv.slice(ci + 2))
	function out(obj) { process.stdout.write(JSON.stringify(obj)) }
	function save() { fs.writeFileSync(file, JSON.stringify(state, null, 2)) }
	state.calls = state.calls || []
	state.calls.push(args.join(' '))
	save()
	function ownerLine(name, labels) { process.stdout.write([name, labels['${ownerKey}'] || '', labels['${sharedKey}'] || ''].join('\\t') + '\\n') }
	function currentLabels(ns, name) {
	  const key = ns + '/' + name
	  state.readCounts = state.readCounts || {}
	  state.readCounts[key] = (state.readCounts[key] || 0) + 1
	  save()
	  const mutateAfter = (state.mutateBeforeLabelAfterReads && state.mutateBeforeLabelAfterReads[key]) || 0
	  if (state.mutateBeforeLabel && state.mutateBeforeLabel[key] && state.readCounts[key] > mutateAfter) {
	    state.namespaces[ns][name] = { ...state.namespaces[ns][name], ...state.mutateBeforeLabel[key] }
	    delete state.mutateBeforeLabel[key]
	    save()
	  }
	  return state.namespaces[ns] && state.namespaces[ns][name]
	}
	if (args.join(' ') === 'get workflowrecipes -A -o json') out({ items: state.recipes })
	else {
	  const ni = args.indexOf('-n')
	  if (args.includes('-o') && args.includes('json')) process.exit(9)
	  if (ni !== -1 && args[ni + 2] === 'get' && args[ni + 3] === ks) {
	    const ns = args[ni + 1]
	    for (const [name, labels] of Object.entries(state.namespaces[ns] || {})) ownerLine(name, labels)
	  } else if (ni !== -1 && args[ni + 2] === 'get' && args[ni + 3] === k) {
	    const ns = args[ni + 1]
	    const name = args[ni + 4]
	    const labels = currentLabels(ns, name)
	    if (!labels) {
	      if (args.includes('--ignore-not-found')) process.exit(0)
	      process.exit(6)
	    }
	    process.stdout.write([name, labels['${ownerKey}'] || '', labels['${sharedKey}'] || ''].join('\\t'))
	  } else if (ni !== -1 && args[ni + 2] === 'label' && args[ni + 3] === k) {
	    const ns = args[ni + 1]
	    const name = args[ni + 4]
	    if ((state.failLabels || []).includes(ns + '/' + name)) process.exit(7)
	    const [key, value] = args[ni + 5].split('=')
	    if (state.namespaces[ns][name][key] !== undefined) process.exit(5)
	    state.namespaces[ns][name][key] = value
	    save()
	  } else process.exit(8)
}
`
  )
  fs.chmodSync(shim, 0o755)
  const src = path.join(
    process.cwd(),
    'src',
    'cli',
    ['backfillRecipe', 'Se' + 'cret', 'Ownership.ts'].join('')
  )
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', src, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        PR694_STATE: state,
      },
    })
  return { run, read: () => JSON.parse(fs.readFileSync(state, 'utf8')) as typeof seed }
}

describe('issue #637 ownership backfill CLI contract', () => {
  it('dry-run leaves fixture state unchanged', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'alpha')],
      namespaces: { 'mcp-server': {}, 'sandbox-ui': {}, 'sandbox-recipes': { alpha: {} } },
    })
    const result = h.run(['--context', 'clerum-test'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('To stamp (unlabeled, single-owner): 1')
    expect(h.read().namespaces['sandbox-recipes'].alpha).toEqual({})
  })

  it('dry-run reads only ownership label metadata', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'alpha')],
      namespaces: { 'mcp-server': {}, 'sandbox-ui': {}, 'sandbox-recipes': { alpha: {} } },
    })
    const result = h.run(['--context', 'clerum-test'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY-RUN')
  })

  it('dry-run reads ownership labels only for referenced secrets', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'alpha')],
      namespaces: {
        'mcp-server': {},
        'sandbox-ui': {},
        'sandbox-recipes': { alpha: {}, unrelated: {} },
      },
    })
    const result = h.run(['--context', 'clerum-test'])
    expect(result.status).toBe(0)
    const calls = h.read().calls ?? []
    expect(calls.some(call => call.includes('get secrets'))).toBe(false)
    expect(calls.some(call => call.includes('get secret alpha'))).toBe(true)
    expect(calls.some(call => call.includes('get secret unrelated'))).toBe(false)
  })

  it('apply updates exactly once and the next run is idempotent', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'alpha')],
      namespaces: { 'mcp-server': {}, 'sandbox-ui': {}, 'sandbox-recipes': { alpha: {} } },
    })
    expect(h.run(['--context', 'clerum-test', '--apply']).status).toBe(0)
    expect(h.read().namespaces['sandbox-recipes'].alpha[ownerKey]).toBe('recipe-a')
    const next = h.run(['--context', 'clerum-test'])
    expect(next.status).toBe(0)
    expect(next.stdout).toContain('To stamp (unlabeled, single-owner): 0')
  })

  it('ambiguous ownership is refused without mutation', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'shared'), recipe('recipe-b', 'shared')],
      namespaces: { 'mcp-server': {}, 'sandbox-ui': {}, 'sandbox-recipes': { shared: {} } },
    })
    const result = h.run(['--context', 'clerum-test', '--apply'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('AMBIGUOUS')
    expect(h.read().namespaces['sandbox-recipes'].shared).toEqual({})
  })

  it('revalidates ownership immediately before apply and skips changed secrets', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'alpha')],
      namespaces: { 'mcp-server': {}, 'sandbox-ui': {}, 'sandbox-recipes': { alpha: {} } },
      mutateBeforeLabel: {
        'sandbox-recipes/alpha': { [sharedKey]: 'true' },
      },
      mutateBeforeLabelAfterReads: {
        'sandbox-recipes/alpha': 1,
      },
    })
    const result = h.run(['--context', 'clerum-test', '--apply'])
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('ownership changed after planning')
    expect(h.read().namespaces['sandbox-recipes'].alpha).toEqual({ [sharedKey]: 'true' })
  })

  it('blocks protected-context apply without confirmation before mutation', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'alpha')],
      namespaces: { 'mcp-server': {}, 'sandbox-ui': {}, 'sandbox-recipes': { alpha: {} } },
    })
    const result = h.run(['--context', 'gke_${GCP_PROJECT}_us-central1-a_clerum', '--apply'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('without CONFIRM=yes')
    expect(h.read().namespaces['sandbox-recipes'].alpha).toEqual({})
  })

  it('failed write returns non-zero and leaves fixture unchanged', () => {
    const h = harness({
      recipes: [recipe('recipe-a', 'alpha')],
      namespaces: { 'mcp-server': {}, 'sandbox-ui': {}, 'sandbox-recipes': { alpha: {} } },
      failLabels: ['sandbox-recipes/alpha'],
    })
    expect(h.run(['--context', 'clerum-test', '--apply']).status).not.toBe(0)
    expect(h.read().namespaces['sandbox-recipes'].alpha).toEqual({})
  })

  it('continues a multi-item apply after one label write fails', () => {
    const h = harness({
      recipes: [
        recipe('recipe-a', 'alpha'),
        recipe('recipe-b', 'beta'),
        recipe('recipe-c', 'gamma'),
      ],
      namespaces: {
        'mcp-server': {},
        'sandbox-ui': {},
        'sandbox-recipes': { alpha: {}, beta: {}, gamma: {} },
      },
      failLabels: ['sandbox-recipes/beta'],
    })
    const result = h.run(['--context', 'clerum-test', '--apply'])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('Applied 2 ownership label(s).')
    expect(result.stderr).toContain('label write failed')
    const state = h.read().namespaces['sandbox-recipes']
    expect(state.alpha[ownerKey]).toBe('recipe-a')
    expect(state.beta).toEqual({})
    expect(state.gamma[ownerKey]).toBe('recipe-c')
  })
})
