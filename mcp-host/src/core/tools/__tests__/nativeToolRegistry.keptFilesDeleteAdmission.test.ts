// The kept-files delete is admitted by the tool loop only when its arguments
// pass the tool's schema and its approval card fits one message of the task's
// channel. The registry builds that check from the task's channel type, its
// approval policy and its configured secrets.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IncomingMessage } from '../../../server'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]
const DELETE = 'clerum__kept_files_delete'
const LIST = 'clerum__kept_files_list'
const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

// Channel limits and counting rules, written out as channel-reader sends the text.
const SLACK_MAX = 3000
const slackSize = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').length
const CONTROLS = 'Use the approval controls to continue or cancel.'
const CLI =
  'Request ID: 00000000-0000-0000-0000-000000000000. Please approve via CLI: POST /v1/runtime/approvals/approve'
const VALUES = ' — 1.2 MB (1,234,567 bytes), created 2026-11-10 09:12:45 UTC'
const MANY = (files: number, leading: number) =>
  `kept_files_card_too_long: the approval card for these ${files} files does not fit one message of this channel; nothing was deleted. Leading files of the list that fit one card: ${leading}. Call clerum__kept_files_delete again with only those, then again for the rest; the user approves each call.`
/** A short protected value whose marker is 68 characters: redaction lengthens it. */
const GROWING_ENTRY = {
  name: 'A_VERY_LONG_OPERATOR_SECRET_ENTRY_NAME_FOR_THE_PROBE_0001',
  value: 'q7Zx',
}

type CardFile = { kind: string; name: string }
type Entry = { name: string; value: string }

let hostBase: string
let root: string

beforeEach(() => {
  hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-delete-admission-')))
  const binding = resolveCallerRootBinding(new ScopedWorkspaceProvider(hostBase), {
    sender: 'admission-caller',
    channelType: 'slack',
  })
  if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
  root = binding.root
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  process.env[ACCESS_ENV] =
    `${header}.${Buffer.from(JSON.stringify({ scopes: ['gfs.read', 'gfs.write'] })).toString('base64url')}.sig`
})

afterEach(() => {
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
  fs.rmSync(hostBase, { recursive: true, force: true })
})

/** A chat registry as taskExecutor builds it for a task of `channelType`. */
function registry(
  channelType: IncomingMessage['channelType'],
  options: { approveInChannel?: boolean; entries?: Entry[] } = {}
): NativeToolRegistry {
  const entries = options.entries ?? []
  const sourceMessage: IncomingMessage = {
    content: 'delete my files',
    channelType,
    channelId: 'channel-1',
    sender: 'admission-caller',
    timestamp: '2026-11-17T10:00:00.000Z',
    messageId: 'message-1',
    hostRef: 'host-1',
  }
  return new NativeToolRegistry(
    config,
    'conv-admission',
    undefined,
    sourceMessage,
    undefined,
    undefined,
    null,
    { maxBytes: 52_428_800, secretEntriesProvider: () => entries },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { root, room: async () => Number.MAX_SAFE_INTEGER },
    { approveInChannel: options.approveInChannel ?? true, secretEntries: () => entries }
  )
}

const withValues = (files: CardFile[]) =>
  files.map((file, n) => ({
    createdAt: '2026-11-10T09:12:45.123Z',
    sizeBytes: 1_234_567,
    ...file,
    id: String(n).padStart(12, '0'),
  }))

/** What the tool loop's admission gets from the delete for these arguments. */
async function admission(reg: NativeToolRegistry, args: Record<string, unknown>) {
  const tool = reg.get(DELETE)
  expect(tool?.name()).toBe(DELETE)
  return await tool!.validateParams?.(args)
}

/** A card of ASCII names (no escape, no `& < >`), rendered by the written-out rule. */
function asciiCard(files: CardFile[], instruction: string): string {
  return [
    'Delete these files permanently:',
    ...files.map(file => `${file.kind}: "${file.name}"${VALUES}`),
    `Total files: ${files.length}`,
    instruction,
  ].join('\n')
}

function leadingFit(files: CardFile[], instruction: string): number {
  let count = files.length - 1
  while (count > 0 && slackSize(asciiCard(files.slice(0, count), instruction)) > SLACK_MAX) {
    count -= 1
  }
  return count
}

const longNames = (): CardFile[] =>
  Array.from({ length: 20 }, (_, n) => ({
    kind: 'upload',
    name: `${'x'.repeat(250)}${String(n).padStart(5, '0')}`,
  }))

/** 20 files whose Slack card is 2960 under the controls and 3020 under the CLI instruction. */
function controlsFitCliDoesNot(): CardFile[] {
  const files = Array.from({ length: 20 }, (_, n) => ({
    kind: 'upload',
    name: `-${String(n).padStart(2, '0')}`,
  }))
  let deficit = SLACK_MAX - 40 - slackSize(asciiCard(files, CONTROLS))
  for (const file of files) {
    const grow = Math.min(deficit, 255 - file.name.length)
    file.name = `${'n'.repeat(grow)}${file.name}`
    deficit -= grow
  }
  expect(slackSize(asciiCard(files, CONTROLS))).toBe(2960)
  expect(slackSize(asciiCard(files, CLI))).toBe(3020)
  return files
}

describe('the kept-files delete at admission', () => {
  it('A1 schema-checks the delete before the approval, on a budgeted channel and on rpc', async () => {
    const one = { kind: 'upload', name: 'a.pdf' }
    const invalid: Array<Record<string, unknown>> = [
      {
        files: withValues(
          Array.from({ length: 21 }, (_, n) => ({ kind: 'upload', name: `${n}.pdf` }))
        ),
      },
      { files: withValues([{ kind: 'upload', name: 'n'.repeat(256) }]) },
      { files: withValues([{ kind: 'shared', name: 'a.pdf' }]) },
      { files: withValues([one]).map(({ sizeBytes: _omitted, ...rest }) => rest) },
    ]
    for (const channelType of ['slack', 'rpc'] as const) {
      const reg = registry(channelType)
      for (const args of invalid) {
        const result = await admission(reg, args)
        expect(result?.is_valid).toBe(false)
        expect(result?.errors).toHaveLength(1)
        expect(result!.errors[0]).toMatch(/^Invalid arguments: /)
      }
      // Witness: a schema-valid call of one file is admitted.
      expect(await admission(reg, { files: withValues([one]) })).toEqual({
        is_valid: true,
        errors: [],
      })
    }
  })

  it('A2 leaves every other internal tool schema-checked only when it runs', async () => {
    const reg = registry('slack')
    const list = reg.get(LIST)!
    expect(list.name()).toBe(LIST)
    expect(await list.validateParams?.({ nameContains: '' })).toEqual({
      is_valid: true,
      errors: [],
    })
    // Witness: the same arguments are refused when the tool runs.
    const ran = await list.execute({ nameContains: '' })
    expect(ran.is_error).toBe(true)
    expect(ran.content).toMatch(/^Error: Invalid arguments: /)
  })

  it('A3 measures the card in the task channel: Slack refuses what rpc admits', async () => {
    const files = longNames()
    const args = { files: withValues(files) }
    expect(await admission(registry('slack'), args)).toEqual({
      is_valid: false,
      errors: [MANY(20, leadingFit(files, CONTROLS))],
    })
    expect(await admission(registry('rpc'), args)).toEqual({ is_valid: true, errors: [] })
  })

  it('A4 measures the names as redacted with the configured secrets', async () => {
    const files: CardFile[] = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${GROWING_ENTRY.value.repeat(10)}${'x'.repeat(200)}${String(n).padStart(2, '0')}`,
    }))
    const redacted = files.map(file => ({
      ...file,
      name: file.name.split(GROWING_ENTRY.value).join(`[REDACTED:${GROWING_ENTRY.name}]`),
    }))
    const args = { files: withValues(files) }
    const plain = leadingFit(files, CONTROLS)
    const grown = leadingFit(redacted, CONTROLS)
    expect(grown).toBeGreaterThan(0)
    expect(grown).toBeLessThan(plain)
    expect(await admission(registry('slack'), args)).toEqual({
      is_valid: false,
      errors: [MANY(20, plain)],
    })
    expect(await admission(registry('slack', { entries: [GROWING_ENTRY] }), args)).toEqual({
      is_valid: false,
      errors: [MANY(20, grown)],
    })
  })

  it('A5 measures the CLI instruction when the channel users cannot approve', async () => {
    const files = controlsFitCliDoesNot()
    const args = { files: withValues(files) }
    expect(await admission(registry('slack', { approveInChannel: true }), args)).toEqual({
      is_valid: true,
      errors: [],
    })
    expect(await admission(registry('slack', { approveInChannel: false }), args)).toEqual({
      is_valid: false,
      errors: [MANY(20, leadingFit(files, CLI))],
    })
  })
})
