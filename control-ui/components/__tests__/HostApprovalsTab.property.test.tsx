/**
 * The approval settings property suite (spec §7 A6 "Property suite", plan Task
 * 23). It renders the real agent page over the fake control-api, through the
 * page harness, and runs generated interleavings of the spec §7 A2 events
 * E1–E23 as fast-check commands. The oracle is the history: the safety
 * properties S1–S8 and the liveness properties L1–L5 (spec §7 A4) are checked
 * on the fake's log, on the stored Host as it changed, and on the rendered
 * page.
 *
 * **Scheduling.** The fake's `schedule` hook hands each Host-route point that
 * decides an ordering to `fc.scheduler()`: a read's arrival (it takes its
 * answer from the store then), a write's apply, and every delivery. A `Step`
 * command releases one of them inside `act`; the scheduler picks which. Every
 * other request (`/admin/llm-models`, routes the fake does not model) passes
 * at once. The protocols run on the virtual clock (test/fixtures/approvalClock),
 * which only `AdvanceClock` and the drain at the end move.
 *
 * **Who sent each request.** `saveTools` and `setManualNow` are wrapped,
 * unchanged, so that each call runs inside an `AsyncLocalStorage` context;
 * `fetch` reads the context and tags the fake's log entry. A request with no
 * tag is a load, or one of the page's older saves (Overview, Model,
 * guardrails); the pre-PR A tab's PUT (E23) is the suite's own, with its own
 * tag. The wrappers also record each save's and each switch's outcome. What
 * the page shows is read from the DOM; every toast is recorded as it appears.
 *
 * **When each property is checked.**
 * - After every step and press: S5 (the tab shows only its agent's data; a
 *   continuation writes nothing into it), L1 and S6 (a written group shows
 *   its write's values or a later load's, never an older load's), and, as a
 *   save or a switch settles, L2 (message and draft after an error), L4 (the
 *   outcome is shown in its tab), L5 (the tab loads again) and S4's "no
 *   switch result without a run".
 * - Also after every step, each approval toast both ways: it comes from a
 *   save or a switch that settled in that step, with that outcome's text and
 *   tone, and each outcome that owes a toast shows one. A success toast with
 *   no `saved` save behind it breaks S3; with no `saved` or `already` switch,
 *   S4. So does a success toast in other words, unless it is one of the
 *   page's own save toasts.
 * - At rest, once the scheduler is drained and the clock has run out: S1, S2,
 *   S3, S4, S7 and S8 on the history, L1 and L2 again, L3, and L4 (every
 *   switch run was shown, in its tab or by its toast).
 * - After a fixed example: that it reached the case it pins (`PINS`), as a
 *   harness check.
 * The properties a step breaks are thrown together, so a counterexample names
 * each one.
 *
 * **The oracle's own readers.** The ceiling and the channel switches come
 * from mcp-host's `readModeCeiling` and `readChannelSwitch`; the block, the
 * tools (true, false or absent), the policy, the approvers and the judge come
 * from readers in this file, not from the product's helpers. The one product
 * helper left is `looseningItems`, for S7 (see its import). The section's
 * "Unsaved changes" decides nothing: the suite keeps its own dirty flag from
 * the rows it set.
 *
 * **Runs (Ruling 53).** `APPROVAL_MODEL_RUNS` generated runs (default 75, see
 * Budget) follow the fixed `EXAMPLES`. `APPROVAL_MODEL_SEED` sets the seed, which is
 * logged; `APPROVAL_MODEL_PATH` with `APPROVAL_MODEL_REPLAY` replays a reported
 * failure (its `path` and its commands' `replayPath`);
 * `APPROVAL_MODEL_NO_SHRINK=1` reports the first failure unshrunk (mutant
 * runs); `APPROVAL_MODEL_DEBUG=1` prints each command and each release.
 *
 * **What is out of the model.**
 * - A 401, and a session change in this or another document (E17's last
 *   cases): both end the session, and a session change posts on a
 *   BroadcastChannel that other test files in other threads hear. Scenario
 *   tests cover them (hostApprovalSave.*.test.ts, T25).
 * - A hung `/detail` load, an older save's hung request, and a hung pre-PR A
 *   PUT: they time out on the real 30 s client timer, not the virtual clock.
 * - E24 (a reload while the switch runs) and E25 (two browser tabs).
 * - Ruling 52: every seeded block goes through the run's CRD, and the CRD
 *   never changes in a run, so no PUT stores less than it sends; the prune
 *   checks (§6.4 step 9, §6.3 step 5) never fire here.
 *
 * The agents are `alpha` and `beta`, names no other test file uses: the
 * Host-changed notice also crosses threads on its BroadcastChannel.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import fc from 'fast-check'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  readChannelSwitch,
  readModeCeiling,
} from '../../../mcp-host/src/core/approval/approvalMode'
import type { ApprovalConfig } from '../../../mcp-host/src/core/extensions/approvalTypes'
import {
  FIRST_SAVE_DIALOG_TITLE,
  FIRST_SAVE_POLICY_LABEL,
  LOOSENING_CANCEL_LABEL,
  LOOSENING_CONFIRM_LABEL,
  LOOSENING_DIALOG_TITLE,
} from '../../components/HostApprovalSection/constants'
import type { FirstSavePolicy, RowState } from '../../components/HostApprovalSection/types'
import { apiSend } from '../../lib/api'
// S7 only: spec A6 makes the loosening oracle (approvalLoosening.oracle.test.ts,
// checked against mcp-host's asks fixture) the check of the item list itself;
// this suite checks that every item a write loosens was in a confirmed dialog.
import { looseningItems } from '../../lib/approvalLoosening'
import {
  type OffSwitchOutcome,
  type ToolsSaveInput,
  type ToolsSaveOutcome,
  __setApprovalClockForTests,
  isSettingManual,
} from '../../lib/hostApprovalSave'
import {
  type VirtualClock,
  createVirtualClock,
  seededRandom,
} from '../../test/fixtures/approvalClock'
import {
  type HostPageHandle,
  pageMountDefaults,
  perToolSection,
  renderHostPage,
  resetApprovalTestState,
} from '../../test/fixtures/approvalPageHarness'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import {
  type FakeControlApi,
  type FakeControlApiOptions,
  type FakeHold,
  type FakeLogEntry,
  type HostObject,
  createFakeControlApi,
} from '../../test/fixtures/fakeControlApi'
import { buildGuardrailDetailScenario } from '../../test/fixtures/guardrailProducer'
import {
  type HostCrdApprovalVersion,
  defaultApprovalBlock,
  loadHostCrdApprovalSchema,
  pruneApprovalBlock,
} from '../../test/fixtures/hostCrdApproval'

// ── The two protocol entry points, wrapped so that their requests carry a tag ──

const tracking = vi.hoisted(() => ({
  save: null as
    | null
    | ((input: ToolsSaveInput, run: () => Promise<ToolsSaveOutcome>) => Promise<ToolsSaveOutcome>),
  manual: null as
    | null
    | ((host: string, run: () => Promise<OffSwitchOutcome>) => Promise<OffSwitchOutcome>),
}))

vi.mock('../../lib/hostApprovalSave', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/hostApprovalSave')>()
  return {
    ...actual,
    saveTools: (input: ToolsSaveInput) =>
      tracking.save ? tracking.save(input, () => actual.saveTools(input)) : actual.saveTools(input),
    setManualNow: (host: string, options?: { namespace?: string }) =>
      tracking.manual
        ? tracking.manual(host, () => actual.setManualNow(host, options))
        : actual.setManualNow(host, options),
  }
})

// ── Budget (Ruling 53) ──────────────────────────────────────────────────────

// N = 75, below the spec's 100 (Ruling 53: the largest N under 60 s inside the
// whole control-ui run). On an Apple M4 with Node 24 (9 workers), N = 100 took
// 54-78 s there, over 60 s in 7 of 9 runs, and 17-23 s alone; N = 75 took
// 41-48 s there in 4 runs. APPROVAL_MODEL_RUNS=100 runs the spec's N.
const NUM_RUNS = Number(process.env.APPROVAL_MODEL_RUNS ?? 75)
const MAX_COMMANDS = 60
/**
 * The per-test timeout, per run: about twice the slowest a run took inside the
 * whole control-ui run (0.68 s: 78.4 s / 116 runs). About 124 s at N = 75, and
 * it grows with APPROVAL_MODEL_RUNS.
 */
const TIMEOUT_MS_PER_RUN = 1_350

// ── Agents, and what marks each one's data (S5) ─────────────────────────────

type Agent = 'alpha' | 'beta'
const AGENTS: readonly Agent[] = ['alpha', 'beta']
const OTHER: Readonly<Record<Agent, Agent>> = { alpha: 'beta', beta: 'alpha' }
/** The native rows each agent's drafts and external writes touch: disjoint, so a row tells the agent. */
const NATIVE: Readonly<Record<Agent, readonly string[]>> = {
  alpha: ['shell_exec', 'http_request', 'json_transform', 'cron_manage'],
  beta: ['browser_open', 'clerum__generate_pdf', 'system_info', 'workflow_trigger'],
}
/** A custom row only an external writer sets. */
const PROBE: Readonly<Record<Agent, string>> = { alpha: 'alpha_probe', beta: 'beta_probe' }
/** Telegram approvers, shown in the read view. */
const APPROVERS: Readonly<Record<Agent, readonly string[]>> = {
  alpha: ['alpha-7001', 'alpha-7002'],
  beta: ['beta-8001', 'beta-8002'],
}

const APPROVALS_SLUG = 'approval-settings'
type TabSlug = 'approval-settings' | 'overview' | 'model' | 'advanced'
const TAB_LABEL: Readonly<Record<TabSlug, string>> = {
  'approval-settings': 'Approvals',
  overview: 'Overview',
  model: 'Models & creds',
  advanced: 'Advanced',
}
const HOST_ROUTE = /^\/api\/v1\/admin\/hosts\/([^/]+)(\/detail)?$/

// ── Recorded answers (CLAUDE.md push rule 5) ────────────────────────────────

type WireAnswer = { status: number; body: unknown }

function wire(path: string): WireAnswer {
  const { status, body } = JSON.parse(readFileSync(resolve(__dirname, path), 'utf8')) as WireAnswer
  return { status, body }
}

// control-api's production 500 (recorded on /detail; the same handler answers
// every Host route), its 403 envelope (recorded on a PUT), its 422, and the
// proxy's own 502 and 504.
const SERVER_500 = wire('../../../control-api/test/fixtures/wire/host-detail-500.wire.json')
const SERVER_403 = wire('../../../control-api/test/fixtures/wire/host-put-403.wire.json')
const SERVER_422 = wire('../../../control-api/test/fixtures/wire/host-put-422.wire.json')
const PROXY_502 = wire('../../test/fixtures/wire/proxy-502.wire.json')
const PROXY_504 = wire('../../test/fixtures/wire/proxy-504.wire.json')

// ── Copy the checks read (spec §6.3 step 7, §6.4, §6.5; written out) ────────

const TOOLS_SAVED_TOAST = 'Per-tool overrides saved.'
/**
 * The success toasts of the page's own saves that the model presses: Overview
 * and Model (app/hosts/[name]/page.tsx) and the guardrail removal
 * (components/HostGuardrailsSection). Every other success toast must be an
 * approval toast that an outcome owes.
 */
const PAGE_SAVE_TOASTS: ReadonlySet<string> = new Set([
  'Agent configuration saved.',
  'Model configuration saved.',
  'sample-hook removed from this agent.',
])
const MODE_BY_LABEL: Readonly<Record<string, 'manual' | 'auto' | 'allow_all'>> = {
  Manual: 'manual',
  Auto: 'auto',
  'Allow all': 'allow_all',
}
const POLICY_TEXT: Readonly<Record<'open' | 'cli_only' | 'designated_approvers', string>> = {
  open: 'Any channel user',
  cli_only: 'Nobody (Desktop only)',
  designated_approvers: 'Listed approvers only',
}
const CLUSTER_DEFAULT_TEXT = 'Set by the cluster default (not shown here).'
const INHERITING_TEXT = 'This agent has no approval settings of its own.'

// ── Types ───────────────────────────────────────────────────────────────────

type Owner = { kind: 'save' | 'switch' | 'legacy'; id: number }
type Tools = Record<string, boolean>
type OlderKind = 'overview' | 'model' | 'guardrails'

/** The section's base for S2: what it showed when it became dirty, and the log entry that held it. */
type BaseCapture = { tools: Tools; inherited: boolean; logLen: number; source: number | 'seed' }

/** What a press of Save (or Confirm, or Retry) hands the save it starts. */
type Press = {
  viewId: number
  draft: Tools
  base: BaseCapture | null
  /** The labels of the loosening dialog confirmed for this call; null when none was. */
  labels: string[] | null
  /**
   * The policy the suite chose in the first-save dialog it answered for this
   * save; absent when no such dialog showed. The oracle's first-save policy
   * is this, never the section's own input.
   */
  firstSavePolicy?: FirstSavePolicy
}

type View = {
  id: number
  instanceId: number
  agent: Agent
  base: BaseCapture | null
  /** The press whose dialog is open, for the Confirm that follows it. */
  dialog: Press | null
  groupWrites: { ceiling?: GroupWrite; tools?: GroupWrite }
  /** The log when the view opened, and whether it has shown a Host or a failed first load. */
  openedLogLen: number
  shown: boolean
  firstLoadFailed: boolean
  /** The switch's result the tab showed after the last step. */
  result: string
  /**
   * The oracle's own "dirty": the rows the admin set differ from the base, by
   * the oracle's reader, in the edit session the suite last opened.
   */
  dirty: boolean
}

type GroupWrite = { stored: HostObject; settleLogLen: number; settleStep: number }

/** A page instance: `mountStep` is the step it mounted in (requests sent before belong to another). */
type Instance = { id: number; agent: Agent; tab: TabSlug; viewId: number | null; mountStep: number }

type SaveRecord = {
  id: number
  agent: Agent
  input: ToolsSaveInput
  press: Press
  instanceId: number
  viewId: number
  startStep: number
  sectionDropped: boolean
  outcome?: ToolsSaveOutcome
  settleStep?: number
  settleLogLen?: number
  /** It settled (a re-asking `reconfirm` has not): the tab reported it. */
  reported?: boolean
  /** Whether it settled in the tab and section it ran in. */
  settledInView?: boolean
}

type SwitchRecord = {
  id: number
  agent: Agent
  instanceId: number
  startClock: number
  startStep: number
  outcome?: OffSwitchOutcome
  settleStep?: number
  settleLogLen?: number
  settleClock?: number
  shown: boolean
  /** An `AdvanceClock` command moved the clock while the run went on (L3 then promises nothing). */
  clockMoved: boolean
  /** Whether it settled in the instance and agent that ran it. */
  settledInInstance?: boolean
}

type StoreEvent = {
  agent: Agent
  kind: 'external' | 'bump' | 'request'
  entry?: FakeLogEntry
  owner?: Owner | null
  before: HostObject
  after: HostObject
  step: number
  logLen: number
}

type FaultKind =
  | 'drop'
  | 'applied-504'
  | 'applied-502'
  | 'unapplied-504'
  | 'hang'
  | '403'
  | '422'
  | '500'
  | '502'
  | '504'
  | '429'
type FaultTarget = 'put' | 'read' | 'load'

type Fault = {
  agent: Agent
  target: FaultTarget
  kind: FaultKind
  method: string
  path: string
  hold: FakeHold
  entrySeq?: number
  /** A write whose apply waits for `ApplyLate` (E22). */
  applyHeld: boolean
  appliedLate: boolean
}

type ToastSeen = { text: string; tone: string; step: number }

type Stats = { events: Record<string, number>; checks: Record<string, number> }

type World = {
  scheduler: fc.Scheduler
  fake: FakeControlApi
  clock: VirtualClock
  crd: HostCrdApprovalVersion
  page: HostPageHandle
  instance: Instance
  instanceSeq: number
  views: Map<number, View>
  viewSeq: number
  owners: Map<number, Owner | null>
  /** The step each logged request was sent in. */
  sentAt: Map<number, number>
  saves: SaveRecord[]
  switches: SwitchRecord[]
  legacyCount: number
  press: Press | null
  justSettled: Array<SaveRecord | SwitchRecord>
  seeds: Record<Agent, HostObject>
  observed: Record<Agent, HostObject>
  appliedSeen: Set<number>
  timeline: StoreEvent[]
  faults: Fault[]
  conflicts: Record<Agent, number>
  toasts: ToastSeen[]
  observer: MutationObserver
  /** Log seqs in the order their answers reached the client, and as a set. */
  deliveries: number[]
  delivered: Set<number>
  /** The properties broken in this step, each with what broke it. */
  violations: string[]
  /** The section's message after the last step, to tell one a continuation wrote. */
  lastMessage: string | null
  step: number
  renames: number
  stats: Stats
}

type Model = Record<string, never>

// ── Small helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Equality of JSON values; object key order is ignored, array order is not. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    )
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    )
  }
  return a === b
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function violation(property: string, message: string): Error {
  return new Error(`${property}: ${message}`)
}

/** Records a broken property; the step's checks all run, then `raise` throws them together. */
function flag(w: World, property: string, message: string): void {
  w.violations.push(`${property}: ${message}`)
}

function raise(w: World): void {
  if (w.violations.length === 0) return
  const list = w.violations.splice(0)
  throw new Error(
    `${list.length} propert${list.length === 1 ? 'y' : 'ies'} broken at step ${w.step}:\n${list.join('\n')}`
  )
}

function harnessError(message: string): Error {
  return new Error(`property suite harness: ${message}`)
}

function count(stats: Stats, kind: 'events' | 'checks', key: string, by = 1): void {
  stats[kind][key] = (stats[kind][key] ?? 0) + by
}

function agentOfPath(path: string): Agent | null {
  const match = HOST_ROUTE.exec(path)
  const name = match ? decodeURIComponent(match[1]) : null
  return name === 'alpha' || name === 'beta' ? name : null
}

function isDetailPath(path: string): boolean {
  return HOST_ROUTE.exec(path)?.[2] === '/detail'
}

/** The Host a logged read answered: a Host GET's body, or a `/detail` bundle's `host`. */
function hostOfRead(entry: FakeLogEntry): HostObject | undefined {
  if (entry.response?.status !== 200) return undefined
  const body = entry.response.body
  if (isDetailPath(entry.path)) return isRecord(body) ? (body.host as HostObject) : undefined
  return body as HostObject
}

// ── The oracle's readers (spec A6: independent of the code under test) ────
//
// None of these is the product's (lib/approvalEffective). The ceiling and the
// channel switches are mcp-host's own readers, imported by relative path as
// approvalEffective.parity.test.ts does; the block, the three-valued tools,
// the policy and the rest are local, written to mcp-host's semantics.

const CHANNEL_TYPES = ['telegram', 'email', 'slack', 'teams'] as const

/** The Host's own `spec.approval`, as mcp-host takes it: an object, or none (the agent inherits). */
function blockOf(host: unknown): Record<string, unknown> | undefined {
  const spec = isRecord(host) ? host.spec : undefined
  const block = isRecord(spec) ? spec.approval : undefined
  return isRecord(block) ? block : undefined
}

/** mcp-host reads the ceiling and the switches from the Host's own block only. */
function snapshotOf(block: Record<string, unknown> | undefined) {
  // The stored block, as it is: `ApprovalConfig` declares fields a stored
  // block may lack, and the two readers read every field as unknown.
  const config = block as unknown as ApprovalConfig | undefined
  return { effective: config, hostSpec: config }
}

/** The ceiling as mcp-host runs it (approvalMode.ts readModeCeiling). */
function ceilingOfBlock(
  block: Record<string, unknown> | undefined
): 'manual' | 'auto' | 'allow_all' {
  return readModeCeiling(snapshotOf(block))
}

function ceilingOf(host: unknown): 'manual' | 'auto' | 'allow_all' {
  return ceilingOfBlock(blockOf(host))
}

/**
 * `tools`, three-valued: an override is an explicit true or false; an absent,
 * null or undefined value is no override, and key order does not matter.
 * The model writes nothing else, so any other value is a harness error.
 */
function overridesOf(block: Record<string, unknown> | undefined): Tools {
  const tools = block?.tools
  const out: Tools = {}
  if (!isRecord(tools)) return out
  for (const [name, value] of Object.entries(tools)) {
    if (value === null || value === undefined) continue
    if (typeof value !== 'boolean') throw harnessError(`tools.${name} is ${JSON.stringify(value)}`)
    out[name] = value
  }
  return out
}

function effectiveTools(host: unknown): Tools {
  return overridesOf(blockOf(host))
}

/** Two override maps hold the same overrides. */
function sameTools(a: Tools, b: Tools): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) && b[key] === a[key])
  )
}

/**
 * `defaultPolicy` as mcp-host's readApproverPolicy (approverPolicy.ts) reads
 * it: absent, null, empty and `channel_users` are the open policy; an unknown
 * value refuses every channel approval.
 */
function policyOf(block: Record<string, unknown> | undefined): string {
  const policy = block?.defaultPolicy
  if (policy === undefined || policy === null || policy === '' || policy === 'channel_users') {
    return 'open'
  }
  if (policy === 'cli_only' || policy === 'designated_approvers') return policy
  return `unknown:${typeof policy === 'string' ? policy : JSON.stringify(policy)}`
}

/** A channel's switch (mcp-host readChannelSwitch), `enabled` (absent is on) and approvers (a set of exact strings). */
function channelOf(
  block: Record<string, unknown> | undefined,
  type: (typeof CHANNEL_TYPES)[number]
) {
  const channels = block?.channels
  const entry = isRecord(channels) ? channels[type] : undefined
  const approvers = isRecord(entry) && Array.isArray(entry.approvers) ? entry.approvers : []
  return {
    switch: readChannelSwitch(snapshotOf(block), type),
    enabled: isRecord(entry) && entry.enabled !== undefined ? entry.enabled : true,
    approvers: [...new Set(approvers.map(String))].sort(),
  }
}

/** The judge model: a trimmed string, or none (the code default). */
function judgeOf(block: Record<string, unknown> | undefined): string | null {
  const model = block?.shellClassifierModel
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null
}

/**
 * Every leaf of a spec, by dotted path: arrays and scalars are leaves, objects
 * are walked, and `approval` also has a leaf for its existence. An empty object
 * has no leaf: `tools: {}` and no `tools` read the same.
 */
function leaves(spec: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (value: unknown, path: string) => {
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key)
      return
    }
    out.set(path, JSON.stringify(value))
  }
  if (isRecord(spec)) {
    walk(spec, '')
    if (isRecord(spec.approval)) out.set('approval', '{block}')
  }
  return out
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter(key => before.get(key) !== after.get(key))
}

/** Leaves whose effective value differs between two blocks (spec decision 13), by the oracle's readers. */
function unstoredLeaves(
  sent: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined
): string[] {
  const out: string[] = []
  if (ceilingOfBlock(sent) !== ceilingOfBlock(stored)) out.push('modeCeiling')
  if (policyOf(sent) !== policyOf(stored)) out.push('defaultPolicy')
  if (judgeOf(sent) !== judgeOf(stored)) out.push('shellClassifierModel')
  for (const type of CHANNEL_TYPES) {
    if (!sameJson(channelOf(sent, type), channelOf(stored, type))) out.push(`channels.${type}`)
  }
  if (!sameTools(overridesOf(sent), overridesOf(stored))) out.push('tools')
  return out
}

/** The CRD prunes and defaults the block, as the apiserver does on write (Ruling 52). */
function throughCrd(
  block: Record<string, unknown>,
  crd: HostCrdApprovalVersion
): Record<string, unknown> {
  const schema = loadHostCrdApprovalSchema(crd)
  return defaultApprovalBlock(pruneApprovalBlock(block, schema), schema)
}

// ── DOM readers ─────────────────────────────────────────────────────────────

function tabRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.cu-host-approvals-tab')
}

/**
 * A button by its accessible name (its `aria-label`, or else its text). Read
 * with selectors, not role queries: the suite reads the page after every step.
 */
function button(scope: ParentNode, name: string | RegExp): HTMLButtonElement | null {
  for (const node of scope.querySelectorAll<HTMLButtonElement>('button')) {
    const label = node.getAttribute('aria-label') ?? (node.textContent ?? '').trim()
    if (typeof name === 'string' ? label === name : name.test(label)) return node
  }
  return null
}

/** An open dialog of `role` by its title (DialogShell's `aria-labelledby`). */
function dialogNamed(role: 'dialog' | 'alertdialog', title: string): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>(`[role="${role}"]`)) {
    const labelId = node.getAttribute('aria-labelledby')
    const label = labelId ? document.getElementById(labelId)?.textContent : null
    if ((label ?? '').trim() === title) return node
  }
  return null
}

function usable(element: HTMLElement | null): element is HTMLElement {
  return (
    element !== null &&
    !(element as HTMLButtonElement).disabled &&
    element.getAttribute('aria-disabled') !== 'true'
  )
}

/** The overrides the section's rows show, read or edit view: true is Required, false is Skip. */
function shownRows(section: HTMLElement): Tools {
  const rows: Tools = {}
  for (const row of section.querySelectorAll<HTMLElement>('[data-tool-row]')) {
    const name = row.dataset.toolRow ?? ''
    if (row.dataset.toolState === 'required') rows[name] = true
    else if (row.dataset.toolState === 'skip') rows[name] = false
  }
  return rows
}

function editing(section: HTMLElement): boolean {
  return button(section, 'Cancel') !== null
}

function sectionMessage(section: HTMLElement): HTMLElement | null {
  return section.querySelector<HTMLElement>('.cu-host-approval-section__message')
}

function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

function inheritingShown(root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll('.cu-host-approvals-tab__banner')).some(node =>
    (node.textContent ?? '').includes(INHERITING_TEXT)
  )
}

/** A read-view row's value, by its label, in the tab. */
function rowValue(root: HTMLElement, label: string): string | null {
  const term = Array.from(root.querySelectorAll('dt')).find(node => node.textContent === label)
  return (
    term?.nextElementSibling?.querySelector('.cu-host-approvals-tab__value')?.textContent ?? null
  )
}

// ── The world of one run ────────────────────────────────────────────────────

const requestOwner = new AsyncLocalStorage<Owner>()

type BlockSeed = {
  ceiling: 'manual' | 'auto' | 'allow_all' | null
  policy: 'channel_users' | 'cli_only' | 'designated_approvers' | null
  tools: Array<[number, boolean]>
  approvers: number
  probe: boolean | null
}

type Setup = {
  crd: HostCrdApprovalVersion
  start: Agent
  blocks: Record<Agent, BlockSeed | null>
  random: number
  /** A fixed example's name: what it must reach (`PINS`). Generated runs have none. */
  pin?: keyof typeof PINS
}

function blockFrom(agent: Agent, seed: BlockSeed): Record<string, unknown> {
  const tools: Record<string, boolean> = {}
  for (const [slot, value] of seed.tools) tools[NATIVE[agent][slot % NATIVE[agent].length]] = value
  if (seed.probe !== null) tools[PROBE[agent]] = seed.probe
  return {
    ...(seed.ceiling ? { modeCeiling: seed.ceiling } : {}),
    ...(seed.policy ? { defaultPolicy: seed.policy } : {}),
    channels: { telegram: { approvers: APPROVERS[agent].slice(0, 1 + (seed.approvers % 2)) } },
    tools,
  }
}

/** A seeded Host. A block goes through the run's CRD; a Host with none keeps none (Ruling 52). */
function seedHost(agent: Agent, seed: BlockSeed | null, crd: HostCrdApprovalVersion): HostObject {
  const spec: Record<string, unknown> = {}
  if (agent === 'alpha') {
    const [scenarioHost] = buildGuardrailDetailScenario('sample-hook', agent).hosts.items
    spec.guardrails = scenarioHost.spec?.guardrails
  }
  const block = seed === null ? undefined : blockFrom(agent, seed)
  if (isRecord(block)) spec.approval = throughCrd(block, crd)
  return materializeHostResource(
    {
      metadata: { name: agent },
      spec: {
        host: agent,
        contextRef: 'ctx-a',
        secretRef: `${agent}-llm`,
        channels: [],
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
      },
    },
    { spec }
  )
}

function emptyStats(): Stats {
  return { events: {}, checks: {} }
}

const totals = { runs: 0, ms: [] as number[], stats: emptyStats() }

function addStats(into: Stats, from: Stats): void {
  for (const kind of ['events', 'checks'] as const) {
    for (const [key, value] of Object.entries(from[kind])) count(into, kind, key, value)
  }
}

function scheduleHook(world: () => World): NonNullable<FakeControlApiOptions['schedule']> {
  return async (point, entry) => {
    const w = world()
    const agent = agentOfPath(entry.path)
    if (agent === null) return
    if (point === 'arrival' && entry.kind === 'write') return
    if (point === 'apply' && entry.kind === 'read') return
    await w.scheduler.schedule(
      Promise.resolve(),
      `${point} ${entry.method} ${entry.path.replace('/api/v1/admin/hosts/', '')} #${entry.seq}`
    )
    if (point === 'delivery') {
      w.deliveries.push(entry.seq)
      w.delivered.add(entry.seq)
    }
    // E6, timed: a status write lands just before a versioned PUT applies (L3).
    if (point === 'apply' && entry.versionSent !== undefined && w.conflicts[agent] > 0) {
      w.conflicts[agent] -= 1
      w.fake.bumpVersion(agent, 'status')
      count(w.stats, 'events', 'E6')
    }
  }
}

/**
 * Lets the work a release or a press started run to its end: macrotask turns
 * until two in a row leave the log, the scheduler, the toasts and the clock as
 * they were (at most 20). Every turn is inside the caller's `act`.
 */
async function flush(w: World): Promise<void> {
  let last = ''
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise(done => setImmediate(done))
    const now = `${w.fake.log.length}/${w.scheduler.count()}/${w.toasts.length}/${w.clock.pending()}`
    if (turn >= 1 && now === last) return
    last = now
  }
}

async function inAct(w: World, fn: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await fn()
    await flush(w)
  })
}

async function startWorld(scheduler: fc.Scheduler, setup: Setup): Promise<World> {
  cleanup()
  resetApprovalTestState()
  const clock = createVirtualClock()
  __setApprovalClockForTests(clock, seededRandom(setup.random))
  const seeds = {
    alpha: seedHost('alpha', setup.blocks.alpha, setup.crd),
    beta: seedHost('beta', setup.blocks.beta, setup.crd),
  }
  let world: World | undefined
  const fake = createFakeControlApi({
    hosts: { alpha: seeds.alpha, beta: seeds.beta },
    crd: setup.crd,
    versionRule: true,
    defaults: pageMountDefaults(),
    schedule: scheduleHook(() => world as World),
  })
  const owners = new Map<number, Owner | null>()
  const sentAt = new Map<number, number>()
  const tagged: FakeControlApi = {
    ...fake,
    fetch: (input, init) => {
      const owner = requestOwner.getStore() ?? null
      const before = fake.log.length
      const response = fake.fetch(input, init)
      if (fake.log.length > before) {
        const entry = fake.log[before]
        owners.set(entry.seq, owner)
        sentAt.set(entry.seq, world?.step ?? 0)
        // The fake gives an armed hold to the first matching request after it.
        const fault = world?.faults.find(
          item =>
            item.entrySeq === undefined && item.method === entry.method && item.path === entry.path
        )
        if (fault) fault.entrySeq = entry.seq
      }
      return response
    },
  }
  const toasts: ToastSeen[] = []
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || !node.classList.contains('cu-toast')) continue
        const tone = Array.from(node.classList)
          .find(name => name.startsWith('cu-toast--'))
          ?.slice('cu-toast--'.length)
        toasts.push({
          text: node.querySelector('.cu-toast__text')?.textContent ?? '',
          tone: tone ?? '',
          step: world?.step ?? 0,
        })
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  let page: HostPageHandle | undefined
  world = {
    scheduler,
    fake,
    clock,
    crd: setup.crd,
    page: undefined as unknown as HostPageHandle,
    instance: { id: 1, agent: setup.start, tab: APPROVALS_SLUG, viewId: null, mountStep: 0 },
    instanceSeq: 1,
    views: new Map(),
    viewSeq: 0,
    owners,
    sentAt,
    saves: [],
    switches: [],
    legacyCount: 0,
    press: null,
    justSettled: [],
    seeds: { alpha: clone(seeds.alpha), beta: clone(seeds.beta) },
    observed: { alpha: fake.stored('alpha'), beta: fake.stored('beta') },
    appliedSeen: new Set(),
    timeline: [],
    faults: [],
    conflicts: { alpha: 0, beta: 0 },
    toasts,
    observer,
    deliveries: [],
    delivered: new Set(),
    violations: [],
    lastMessage: null,
    step: 0,
    renames: 0,
    stats: emptyStats(),
  }
  openView(world)
  installTracking(world)
  const started = world
  // The page's mount reads that the fake does not schedule answer at once:
  // their continuations run inside this act.
  await inAct(started, () => {
    page = renderHostPage({ fake: tagged, name: setup.start, tab: APPROVALS_SLUG })
  })
  started.page = page as HostPageHandle
  return started
}

function openView(w: World): void {
  if (w.instance.tab !== APPROVALS_SLUG) {
    w.instance.viewId = null
    return
  }
  w.viewSeq += 1
  w.views.set(w.viewSeq, {
    id: w.viewSeq,
    instanceId: w.instance.id,
    agent: w.instance.agent,
    base: null,
    dialog: null,
    groupWrites: {},
    openedLogLen: w.fake.log.length,
    shown: false,
    firstLoadFailed: false,
    result: '',
    dirty: false,
  })
  w.instance.viewId = w.viewSeq
}

function currentView(w: World): View | null {
  return w.instance.viewId === null ? null : (w.views.get(w.instance.viewId) ?? null)
}

function installTracking(w: World): void {
  tracking.save = (input, run) => {
    const press = w.press
    const view = press ? w.views.get(press.viewId) : undefined
    if (!press || !view) {
      // Not thrown: the section turns a throw of saveTools into an error
      // outcome. Flagged, it fails the step this save starts in.
      flag(w, 'harness', 'saveTools ran outside a press of Save, Confirm or Retry')
      return run()
    }
    const record: SaveRecord = {
      id: w.saves.length + 1,
      agent: view.agent,
      input: clone(input),
      press,
      instanceId: view.instanceId,
      viewId: view.id,
      startStep: w.step,
      sectionDropped: false,
    }
    w.saves.push(record)
    count(w.stats, 'events', 'E1')
    if (w.switches.some(item => item.agent === record.agent && !item.outcome)) {
      count(w.stats, 'events', 'E12')
    }
    return requestOwner.run({ kind: 'save', id: record.id }, run).then(outcome => {
      record.outcome = outcome
      record.settleStep = w.step
      record.settleLogLen = w.fake.log.length
      w.justSettled.push(record)
      return outcome
    })
  }
  tracking.manual = (host, run) => {
    const agent = host as Agent
    const record: SwitchRecord = {
      id: w.switches.length + 1,
      agent,
      instanceId: w.instance.id,
      startClock: w.clock.now(),
      startStep: w.step,
      shown: false,
      clockMoved: false,
    }
    w.switches.push(record)
    count(w.stats, 'events', 'E2')
    if (w.saves.some(save => save.agent === agent && !save.outcome)) count(w.stats, 'events', 'E12')
    return requestOwner.run({ kind: 'switch', id: record.id }, run).then(outcome => {
      record.outcome = outcome
      record.settleStep = w.step
      record.settleLogLen = w.fake.log.length
      record.settleClock = w.clock.now()
      w.justSettled.push(record)
      return outcome
    })
  }
}

async function stopWorld(w: World): Promise<void> {
  w.observer.disconnect()
  tracking.save = null
  tracking.manual = null
  cleanup()
  resetApprovalTestState()
  vi.unstubAllGlobals()
}

// ── History ─────────────────────────────────────────────────────────────────

/** Records every change of a stored Host since the last look, with the request that made it. */
function observeStores(w: World, cause: 'external' | 'other'): void {
  for (const agent of AGENTS) {
    const now = w.fake.stored(agent)
    const before = w.observed[agent]
    if (sameJson(now, before)) continue
    const applied = w.fake.log.filter(
      entry =>
        entry.kind === 'write' &&
        entry.applied &&
        !w.appliedSeen.has(entry.seq) &&
        agentOfPath(entry.path) === agent
    )
    if (applied.length > 1) throw harnessError(`two writes applied to ${agent} in one step`)
    for (const entry of applied) w.appliedSeen.add(entry.seq)
    const entry = applied[0]
    const kind = entry ? 'request' : cause === 'external' ? 'external' : 'bump'
    if (kind === 'bump' && !sameJson(now.spec, before.spec)) {
      throw harnessError(`${agent}'s spec changed with no request and no external write`)
    }
    w.timeline.push({
      agent,
      kind,
      entry,
      owner: entry ? (w.owners.get(entry.seq) ?? null) : undefined,
      before,
      after: now,
      step: w.step,
      logLen: w.fake.log.length,
    })
    w.observed[agent] = now
    if (entry && w.crd === 'v0.12.1') {
      const sent = isRecord(entry.body) ? (entry.body.spec as Record<string, unknown>) : undefined
      if (unstoredLeaves(blockOf({ spec: sent }), blockOf(now)).length > 0)
        count(w.stats, 'events', 'E7')
    }
  }
}

// ── Steps and the drain ─────────────────────────────────────────────────────

async function step(w: World): Promise<void> {
  w.step += 1
  if (w.scheduler.count() === 0) {
    await inAct(w, () => undefined)
  } else {
    await act(async () => {
      await w.scheduler.waitOne()
      await flush(w)
    })
    if (process.env.APPROVAL_MODEL_DEBUG) {
      const released = w.scheduler
        .report()
        .filter(item => item.status !== 'pending')
        .at(-1)
      console.info(`  [${w.step}] released ${released?.label ?? '?'}`)
    }
  }
  afterCommand(w)
}

async function advanceClock(w: World, ms: number): Promise<void> {
  w.step += 1
  await inAct(w, () => w.clock.advance(ms))
  afterCommand(w)
}

/** Releases every scheduled point and runs the clock until nothing is left to happen. */
async function drain(w: World): Promise<void> {
  for (let guard = 0; guard < 4000; guard += 1) {
    if (w.scheduler.count() > 0) {
      await step(w)
      continue
    }
    const [next] = w.clock.timers()
    if (next) {
      await advanceClock(w, Math.max(0, next.remaining))
      continue
    }
    await step(w)
    if (w.scheduler.count() === 0 && w.clock.pending() === 0) return
  }
  throw harnessError('the run did not come to rest')
}

// ── After every command and step: settle checks, S5, S6 ───────────────────

function afterCommand(w: World): void {
  observeStores(w, 'other')
  trackSection(w)
  trackView(w)
  const settled = w.justSettled.splice(0)
  // A save that settled in its tab in this same step explains the tab's toast
  // and the section's message; a continuation's checks leave those to it.
  const inViewSaves = settled.filter(
    (record): record is SaveRecord => 'input' in record && saveInView(w, record)
  )
  for (const record of settled) {
    if ('input' in record) settleSave(w, record, inViewSaves)
    else settleSwitch(w, record)
  }
  checkApprovalToasts(w, settled)
  checkSwitchResult(w, settled)
  checkS5(w)
  checkGroups(w, false)
  const section = perToolSection()
  const message = section ? sectionMessage(section) : null
  w.lastMessage = message ? (message.textContent ?? '') : null
  raise(w)
}

/**
 * S4 on the page: a switch result the tab shows comes from a run of the
 * switch, for this agent, that settled in this step.
 */
function checkSwitchResult(w: World, settled: Array<SaveRecord | SwitchRecord>): void {
  const view = currentView(w)
  const root = tabRoot()
  if (!view || !root || !onApprovals(w)) return
  const result = root.querySelector('.cu-host-approvals-tab__switch-result')?.textContent ?? ''
  if (result !== '' && result !== view.result) {
    const ran = settled.some(
      record =>
        !('input' in record) && record.agent === view.agent && record.instanceId === w.instance.id
    )
    if (!ran)
      flag(
        w,
        'S4',
        `the ${view.agent} tab shows a switch result no run of the switch settled: "${result.slice(0, 60)}"`
      )
  }
  view.result = result
}

function onApprovals(w: World): boolean {
  return w.instance.tab === APPROVALS_SLUG
}

/** A save in flight loses its section when the tab drops it (C13); it then reports to the root toast. */
function trackSection(w: World): void {
  if (!onApprovals(w) || perToolSection() !== null) return
  for (const save of w.saves) {
    if (save.outcome === undefined && save.instanceId === w.instance.id) save.sectionDropped = true
  }
}

/** E14: the view's first load failed (its banner shows, with nothing loaded). */
function trackView(w: World): void {
  const view = currentView(w)
  const root = tabRoot()
  if (!view || !root || !onApprovals(w)) return
  if (rowValue(root, 'Highest mode') !== null) view.shown = true
  const banner = root.querySelector('.cu-host-approvals-tab__error') !== null
  if (!view.shown && banner && !view.firstLoadFailed) {
    view.firstLoadFailed = true
    count(w.stats, 'events', 'E14')
  }
}

function toastsThisStep(w: World): ToastSeen[] {
  return w.toasts.filter(toast => toast.step === w.step)
}

/** Whether a save settles where it ran: its tab, its agent, the section it ran in (spec §6.5). */
function saveInView(w: World, save: SaveRecord): boolean {
  return (
    onApprovals(w) &&
    save.instanceId === w.instance.id &&
    w.instance.agent === save.agent &&
    !save.sectionDropped
  )
}

const DRAFT_KEPT: ReadonlySet<ToolsSaveOutcome['kind']> = new Set([
  'conflict',
  'created_elsewhere',
  'refused',
  'error',
  'gave_up',
  'not_stored',
])

function settleSave(w: World, save: SaveRecord, inViewSaves: readonly SaveRecord[]): void {
  save.reported = true
  save.settledInView = saveInView(w, save)
  const outcome = save.outcome as ToolsSaveOutcome
  const inView = saveInView(w, save)
  const view = currentView(w)
  const section = perToolSection()
  const reconfirmAsked =
    outcome.kind === 'reconfirm' &&
    inView &&
    dialogNamed('alertdialog', LOOSENING_DIALOG_TITLE) !== null
  if (reconfirmAsked) {
    // Not settled: the dialog asks again in the same edit session.
    save.reported = false
    count(w.stats, 'events', 'reconfirm')
    return
  }
  // S5 (spec §6.5 "After unmount"): a continuation writes nothing into the tab
  // and reports through the root toast, naming the agent.
  if (!inView) {
    // Its root toast is checked with every other toast of the step
    // (checkApprovalToasts).
    count(w.stats, 'checks', 'S5')
    const message = section ? sectionMessage(section) : null
    if (inViewSaves.length === 0 && message && (message.textContent ?? '') !== w.lastMessage) {
      flag(
        w,
        'S5',
        `save #${save.id} of ${save.agent} settled away from its tab and wrote a message into the ${w.instance.agent} section`
      )
    }
  } else if (outcome.kind === 'saved') {
    if (view) {
      if (view.groupWrites.ceiling) count(w.stats, 'events', 'E18')
      view.groupWrites.tools = groupWrite(w, outcome.stored as HostObject, save.settleLogLen)
    }
  } else {
    // L2: after an error, a message, and the draft while its edit session is open.
    count(w.stats, 'checks', 'L2')
    const message = section ? sectionMessage(section) : null
    if (!message) {
      flag(w, 'L2', `save #${save.id} ended with ${outcome.kind} and the section shows no message`)
    }
    if (DRAFT_KEPT.has(outcome.kind) && save.viewId === view?.id && section) {
      if (!editing(section) || !sameTools(shownRows(section), save.press.draft)) {
        flag(w, 'L2', `save #${save.id} ended with ${outcome.kind} and its draft is not on screen`)
      }
    }
  }
  checkL5(w, save.agent, save.settleLogLen as number, `save #${save.id} (${outcome.kind})`)
}

function settleSwitch(w: World, record: SwitchRecord): void {
  const outcome = record.outcome as OffSwitchOutcome
  const inInstance = switchInInstance(w, record)
  record.settledInInstance = inInstance
  const root = tabRoot()
  // L4: every outcome is shown, in the tab that ran it or as a root toast naming the agent.
  count(w.stats, 'checks', 'L4')
  if (inInstance) {
    const result = root?.querySelector('.cu-host-approvals-tab__switch-result')?.textContent ?? ''
    const expected = outcome.kind === 'failed' ? 'Manual was not saved.' : 'Manual is saved.'
    // Shown in the tab that ran it; a continuation is shown by its toast.
    record.shown = result.startsWith(expected)
    if (!record.shown) {
      flag(
        w,
        'L4',
        `switch #${record.id} ended ${outcome.kind} and its tab shows "${result.slice(0, 80)}"`
      )
    }
    if (outcome.kind !== 'failed') {
      const view = currentView(w)
      if (view) {
        if (view.groupWrites.tools) count(w.stats, 'events', 'E18')
        view.groupWrites.ceiling = groupWrite(w, outcome.stored as HostObject, record.settleLogLen)
      }
    }
  }
  checkL5(w, record.agent, record.settleLogLen as number, `switch #${record.id} (${outcome.kind})`)
}

function switchInInstance(w: World, record: SwitchRecord): boolean {
  return onApprovals(w) && record.instanceId === w.instance.id && w.instance.agent === record.agent
}

/** A toast the step must show: who owes it, its text, its tone, and the property it proves. */
type ToastDue = {
  owner: string
  matches: (text: string) => boolean
  tone: string
  /**
   * What a missing or mistoned toast breaks: L4 for a switch, S5 for a save's
   * continuation, S3 for a save's success in its tab.
   */
  property: string
  /** Called when the toast is found: a switch continuation is then shown (L4). */
  onShown?: () => void
}

/** The approval toasts (spec §6.3 step 7, §6.4 step 10, §6.5): every other toast is the page's. */
function isApprovalToast(text: string): boolean {
  return text.startsWith('Per-tool overrides') || text.startsWith('Manual ')
}

/** The toast each outcome that settled this step owes, by the copy of spec §6.3, §6.5 and Task 21c. */
function toastsDue(w: World, settled: ReadonlyArray<SaveRecord | SwitchRecord>): ToastDue[] {
  const due: ToastDue[] = []
  for (const record of settled) {
    if ('input' in record) {
      if (!record.reported) continue
      const outcome = record.outcome as ToolsSaveOutcome
      const owner = `save #${record.id} of ${record.agent} (${outcome.kind})`
      if (saveInView(w, record)) {
        // In its tab only a success toasts; the section shows the rest.
        if (outcome.kind === 'saved') {
          due.push({
            owner,
            matches: text => text === TOOLS_SAVED_TOAST,
            tone: 'success',
            property: 'S3',
          })
        }
        continue
      }
      const prefix = `Per-tool overrides for agent ${record.agent}`
      if (outcome.kind === 'saved') {
        const text = `Per-tool overrides saved for agent ${record.agent}.`
        due.push({ owner, matches: shown => shown === text, tone: 'success', property: 'S5' })
      } else if (outcome.kind === 'maybe') {
        const text = `${prefix}: The save may not have applied. Reload to check.`
        due.push({ owner, matches: shown => shown === text, tone: 'warning', property: 'S5' })
      } else if (outcome.kind === 'reconfirm') {
        const text = `${prefix}: The save was not sent`
        due.push({ owner, matches: shown => shown.startsWith(text), tone: 'error', property: 'S5' })
      } else if (outcome.kind === 'not_stored') {
        const text = `${prefix}: This cluster's Host schema is older`
        due.push({ owner, matches: shown => shown.startsWith(text), tone: 'error', property: 'S5' })
      } else {
        const text = `${prefix} were not saved. `
        due.push({ owner, matches: shown => shown.startsWith(text), tone: 'error', property: 'S5' })
      }
      continue
    }
    const outcome = record.outcome as OffSwitchOutcome
    const owner = `switch #${record.id} of ${record.agent} (${outcome.kind})`
    const applied = 'Running chats apply it at their next tool call.'
    if (switchInInstance(w, record)) {
      // In its tab the result shows the outcome; only a failure also toasts.
      if (outcome.kind === 'failed') {
        due.push({
          owner,
          matches: text => text.startsWith('Manual was not saved. '),
          tone: 'error',
          property: 'L4',
        })
      }
      continue
    }
    const onShown = () => {
      record.shown = true
    }
    if (outcome.kind === 'failed') {
      const text = `Manual was not saved for agent ${record.agent}. `
      due.push({
        owner,
        matches: shown =>
          shown.startsWith(text) && shown.includes('To set Manual by hand, run: kubectl'),
        tone: 'error',
        property: 'L4',
        onShown,
      })
    } else {
      const already = outcome.kind === 'already' ? ' It was already Manual.' : ''
      const text = `Manual is saved for agent ${record.agent}.${already} ${applied}`
      due.push({
        owner,
        matches: shown => shown === text,
        tone: 'success',
        property: 'L4',
        onShown,
      })
    }
  }
  return due
}

/**
 * Ruling 67(2): every approval toast this step shows comes from an outcome
 * that settled in it, with that outcome's text and tone, and every outcome
 * that owes a toast shows one. A success toast with no `saved` save (S3) or
 * no `saved` or `already` switch (S4) behind it is a false success, and so is
 * a success toast in any other words but the page's own save toasts.
 */
function checkApprovalToasts(w: World, settled: ReadonlyArray<SaveRecord | SwitchRecord>): void {
  const shown = toastsThisStep(w).filter(toast => isApprovalToast(toast.text))
  const unmatched = [...shown]
  for (const expected of toastsDue(w, settled)) {
    const index = unmatched.findIndex(
      toast => expected.matches(toast.text) && toast.tone === expected.tone
    )
    if (index >= 0) {
      unmatched.splice(index, 1)
      expected.onShown?.()
      count(w.stats, 'checks', 'toasts')
      continue
    }
    const near = unmatched.find(toast => expected.matches(toast.text))
    flag(
      w,
      expected.property,
      near
        ? `${expected.owner}: its toast has tone ${near.tone}, not ${expected.tone}`
        : `${expected.owner}: no ${expected.tone} toast says so`
    )
  }
  for (const toast of unmatched) {
    const manual = toast.text.startsWith('Manual ')
    const property = toast.tone === 'success' ? (manual ? 'S4' : 'S3') : manual ? 'L4' : 'S5'
    flag(
      w,
      property,
      `a ${toast.tone} toast no outcome of this step owes: "${toast.text.slice(0, 120)}"`
    )
  }
  // Ruling 67(2) holds every success toast to an outcome, whatever its words:
  // one in other words is a false success unless it is one of the page's own.
  const switchOnly = settled.length > 0 && settled.every(record => !('input' in record))
  for (const toast of toastsThisStep(w)) {
    if (toast.tone !== 'success' || isApprovalToast(toast.text)) continue
    if (PAGE_SAVE_TOASTS.has(toast.text)) continue
    flag(
      w,
      switchOnly ? 'S4' : 'S3',
      `a success toast that is neither an approval toast nor the page's own: "${toast.text.slice(0, 120)}"`
    )
  }
}

/**
 * A settled group write, with the log length when it settled: before the
 * Host-changed notice it fires sends the load that follows it.
 */
function groupWrite(w: World, stored: HostObject, settleLogLen: number | undefined): GroupWrite {
  if (settleLogLen === undefined) throw harnessError('a group write with no settle point')
  return { stored: clone(stored), settleLogLen, settleStep: w.step }
}

/** L5: a settled approval write loads the agent's mounted Approvals tab again. */
function checkL5(w: World, agent: Agent, settleLogLen: number, what: string): void {
  if (!onApprovals(w) || w.instance.agent !== agent) return
  count(w.stats, 'checks', 'L5')
  const reloaded = w.fake.log.some(
    entry =>
      entry.seq > settleLogLen &&
      entry.kind === 'read' &&
      entry.path === `/api/v1/admin/hosts/${agent}/detail`
  )
  if (!reloaded) flag(w, 'L5', `${what} settled and the ${agent} tab did not load again`)
}

/** The tools a Skip list names: in the Manual description, or in the switch's message. */
function skipListed(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/tools set to Skip \(([^)]*)\)/g)) {
    for (const part of match[1].split(/[;,]/)) {
      const name = part.trim()
      if (/^[a-z][a-z0-9_]*$/.test(name) && name !== 'none') names.push(name)
    }
  }
  return names
}

/** S5: the tab shows only the agent it is for. */
function checkS5(w: World): void {
  const root = tabRoot()
  if (!root || !onApprovals(w)) return
  const agent = w.instance.agent
  const other = OTHER[agent]
  const own = new Set([...NATIVE[agent], PROBE[agent]])
  const text = root.textContent ?? ''
  const section = perToolSection()
  const foreign = [...(section ? Object.keys(shownRows(section)) : []), ...skipListed(text)].filter(
    name => !own.has(name)
  )
  foreign.push(
    ...[PROBE[other], ...APPROVERS[other], `host ${other} `].filter(marker => text.includes(marker))
  )
  if (foreign.length > 0)
    flag(w, 'S5', `the ${agent} tab shows ${[...new Set(foreign)].join(', ')}`)
  // Non-vacuous: the other agent's data can still reach this tab. A save or
  // switch of it is in flight, or a load of it that this instance sent (a
  // kept page that showed it) has not answered. A remount starts a new
  // instance, so its loads count no more.
  const pendingLoad = w.fake.log.some(
    entry =>
      entry.path === `/api/v1/admin/hosts/${other}/detail` &&
      sentStep(w, entry) >= w.instance.mountStep &&
      !w.delivered.has(entry.seq)
  )
  if (currentView(w) && (pendingLoad || inFlight(w, other))) count(w.stats, 'checks', 'S5')
}

type GroupValues = { block: boolean; tools: Tools | null; policy: string } | { ceiling: string }

function toolsGroupOf(host: unknown): { block: boolean; tools: Tools; policy: string } {
  const block = blockOf(host)
  if (block === undefined) return { block: false, tools: {}, policy: CLUSTER_DEFAULT_TEXT }
  const policy = policyOf(block)
  return {
    block: true,
    tools: overridesOf(block),
    policy: policy.startsWith('unknown:')
      ? policy
      : POLICY_TEXT[policy as keyof typeof POLICY_TEXT],
  }
}

/** What the tab shows of a group now, or null when it shows nothing of it. */
function shownGroup(group: 'tools' | 'ceiling'): GroupValues | null {
  const root = tabRoot()
  if (!root) return null
  const mode = rowValue(root, 'Highest mode')
  if (mode === null) return null
  if (group === 'ceiling') return { ceiling: MODE_BY_LABEL[mode] ?? mode }
  const section = perToolSection()
  const policyValue = rowValue(root, 'Policy') ?? ''
  const policy = policyValue.startsWith('Unknown policy') ? 'unknown' : policyValue
  const readView = section !== null && !editing(section) && button(section, 'Edit') !== null
  return {
    block: !inheritingShown(root),
    tools: readView ? shownRows(section) : null,
    policy,
  }
}

function sameGroup(shown: GroupValues, source: unknown, group: 'tools' | 'ceiling'): boolean {
  if (group === 'ceiling') return 'ceiling' in shown && shown.ceiling === ceilingOf(source)
  if (!('block' in shown)) return false
  const expected = toolsGroupOf(source)
  const policy = expected.policy.startsWith('unknown:') ? 'unknown' : expected.policy
  return (
    shown.block === expected.block &&
    shown.policy === policy &&
    (shown.tools === null || sameTools(shown.tools, expected.tools))
  )
}

/** The loads of `agent` sent after (`after`) or up to (`!after`) log length `logLen` that answered. */
function loads(w: World, agent: Agent, logLen: number, after: boolean): HostObject[] {
  return w.fake.log
    .filter(
      entry =>
        (after ? entry.seq > logLen : entry.seq <= logLen) &&
        entry.delivered &&
        entry.path === `/api/v1/admin/hosts/${agent}/detail`
    )
    .map(hostOfRead)
    .filter((host): host is HostObject => host !== undefined)
}

/**
 * L1 and S6, for each group the tab has a successful write of (spec §6.5):
 * - L1: from the step the write settled, the group shows what the write
 *   stored, or what a load sent after it answered, even when that load
 *   failed (`atRest` also counts the refresh-failed case at rest);
 * - S6: it never shows the values of a load sent before the write settled
 *   (the write's own re-read is the write's value, not a load).
 */
function checkGroups(w: World, atRest: boolean): void {
  const view = currentView(w)
  if (!view || !onApprovals(w)) return
  for (const group of ['ceiling', 'tools'] as const) {
    const write = view.groupWrites[group]
    if (!write) continue
    const shown = shownGroup(group)
    if (shown === null) continue
    const later = loads(w, view.agent, write.settleLogLen, true)
    const allowed = [write.stored, ...later]
    const older = loads(w, view.agent, write.settleLogLen, false).filter(
      host => !allowed.some(source => sameGroup(groupOf(host, group), source, group))
    )
    if (later.length === 0) count(w.stats, 'checks', atRest ? 'L1' : 'L1step')
    if (older.length > 0) count(w.stats, 'checks', 'S6')
    if (allowed.some(source => sameGroup(shown, source, group))) continue
    flag(
      w,
      'L1',
      `the ${group} group shows ${JSON.stringify(shown)}: not what its write stored at step ${write.settleStep}, nor a later load`
    )
    if (older.some(host => sameGroup(shown, host, group))) {
      flag(
        w,
        'S6',
        `the ${group} group shows the values of a load sent before its write settled at step ${write.settleStep}`
      )
    }
  }
}

/** A Host's values for a group, as the tab shows them. */
function groupOf(host: unknown, group: 'tools' | 'ceiling'): GroupValues {
  return group === 'ceiling' ? { ceiling: ceilingOf(host) } : toolsGroupOf(host)
}

// ── The checks at rest ──────────────────────────────────────────────────────

function savePuts(w: World, save: SaveRecord): FakeLogEntry[] {
  return w.fake.log.filter(entry => {
    const owner = w.owners.get(entry.seq)
    return entry.kind === 'write' && owner?.kind === 'save' && owner.id === save.id
  })
}

function ownedReads(w: World, owner: Owner): FakeLogEntry[] {
  return w.fake.log.filter(entry => {
    const tag = w.owners.get(entry.seq)
    return entry.kind === 'read' && tag?.kind === owner.kind && tag.id === owner.id
  })
}

function applyEvent(w: World, entry: FakeLogEntry): StoreEvent | undefined {
  return w.timeline.find(event => event.entry?.seq === entry.seq)
}

function sentSpec(entry: FakeLogEntry): Record<string, unknown> {
  return (entry.body as { spec: Record<string, unknown> }).spec
}

/** The keys a Control UI approval write owns (spec §6.4 step 5, §6.3). */
function ownedKeys(w: World, owner: Owner): Set<string> {
  if (owner.kind === 'switch') return new Set(['approval.modeCeiling'])
  const save = w.saves[owner.id - 1]
  const base = save.press.base?.tools ?? {}
  const draft = save.press.draft
  const keys = new Set<string>()
  for (const name of new Set([...Object.keys(base), ...Object.keys(draft)])) {
    if (base[name] !== draft[name]) keys.add(`approval.tools.${name}`)
  }
  if (save.press.firstSavePolicy !== undefined) {
    keys.add('approval')
    keys.add('approval.defaultPolicy')
  }
  return keys
}

/**
 * S1: no lost update. An accepted Control UI approval write changes only the
 * keys it owns (ownedKeys); every other key keeps the value the store held,
 * which is the last value another writer (or the CRD's default) gave it.
 */
function checkS1(w: World): void {
  for (const agent of AGENTS) {
    // Keys another writer set since the seed: where a stale write would show.
    const setByOthers = new Set<string>()
    for (const event of w.timeline.filter(item => item.agent === agent)) {
      const before = leaves(event.before.spec)
      const after = leaves(event.after.spec)
      const changed = changedKeys(before, after)
      const cui =
        event.kind === 'request' && (event.owner?.kind === 'save' || event.owner?.kind === 'switch')
      if (!cui) {
        for (const key of changed) setByOthers.add(key)
        continue
      }
      const owned = ownedKeys(w, event.owner as Owner)
      // Non-vacuous: keys another writer set that this write does not own.
      count(w.stats, 'checks', 'S1', [...setByOthers].filter(key => !owned.has(key)).length)
      for (const key of changed) {
        if (owned.has(key)) continue
        flag(
          w,
          'S1',
          `${event.owner?.kind} #${event.owner?.id} changed ${agent}'s ${key}, which it does not own: ${before.get(key)} → ${after.get(key)}`
        )
      }
    }
  }
}

/** S2: a per-tool write lands only on its base, or on its draft. */
function checkS2(w: World): void {
  for (const save of w.saves) {
    const base = save.press.base
    if (!base) throw harnessError(`save #${save.id} has no base`)
    // Non-vacuous: `tools` moved off the base between the base and the save's end.
    const moved = w.timeline.some(
      event =>
        event.agent === save.agent &&
        event.logLen > base.logLen &&
        event.step <= (save.settleStep ?? w.step) &&
        !sameTools(effectiveTools(event.after), base.tools)
    )
    if (moved) count(w.stats, 'checks', 'S2')
    for (const put of savePuts(w, save)) {
      const event = applyEvent(w, put)
      if (!event) continue
      const tools = effectiveTools(event.before)
      if (!sameTools(tools, base.tools) && !sameTools(tools, save.press.draft)) {
        flag(
          w,
          'S2',
          `save #${save.id}'s PUT #${put.seq} landed on tools ${JSON.stringify(tools)}, neither its base ${JSON.stringify(base.tools)} nor its draft ${JSON.stringify(save.press.draft)}`
        )
      }
    }
  }
}

/** S3: no false success, no false failure. */
function checkS3(w: World): void {
  for (const save of w.saves) {
    const outcome = save.outcome
    if (!outcome) throw harnessError(`save #${save.id} never ended`)
    const applied = savePuts(w, save)
      .map(put => ({ put, event: applyEvent(w, put) }))
      .filter((item): item is { put: FakeLogEntry; event: StoreEvent } => item.event !== undefined)
    for (const { put, event } of applied) {
      const unstored = unstoredLeaves(blockOf({ spec: sentSpec(put) }), blockOf(event.after))
      if (outcome.kind === 'saved' && unstored.length > 0) {
        flag(
          w,
          'S3',
          `save #${save.id} reported saved, but PUT #${put.seq} did not store ${unstored.join(', ')}`
        )
      }
    }
    if (outcome.kind === 'saved') {
      count(w.stats, 'checks', 'S3')
      const stored = outcome.stored
      if (!sameTools(effectiveTools(stored), save.press.draft)) {
        flag(
          w,
          'S3',
          `save #${save.id} reported saved on tools ${JSON.stringify(effectiveTools(stored))}, not its draft ${JSON.stringify(save.press.draft)}`
        )
      }
      const policy = save.press.firstSavePolicy
      if (
        policy !== undefined &&
        !sameJson(policyOf(blockOf(stored)), policyOf({ defaultPolicy: policy }))
      ) {
        flag(w, 'S3', `first save #${save.id} reported saved without its policy ${policy}`)
      }
      const evidence = [
        ...savePuts(w, save).map(put => put.response?.body),
        ...ownedReads(w, { kind: 'save', id: save.id }).map(read => read.response?.body),
      ]
      if (!evidence.some(body => isRecord(body) && sameJson(body.spec, stored.spec))) {
        flag(w, 'S3', `save #${save.id} reported saved from a Host no request of it answered`)
      }
    }
    // No false failure: live for every save with an applied PUT (a wrong
    // prune check could report any of them not stored). `not_stored` needs
    // an applied PUT of the save that did lose a leaf; Ruling 52 keeps every
    // PUT whole here, so it never shows.
    if (applied.length > 0) count(w.stats, 'checks', 'S3noFalseFailure')
    if (outcome.kind === 'not_stored') {
      const lost = applied.some(
        ({ put, event }) =>
          unstoredLeaves(blockOf({ spec: sentSpec(put) }), blockOf(event.after)).length > 0
      )
      if (!lost) {
        flag(
          w,
          'S3',
          `save #${save.id} reported not stored, but its write stored every leaf it sent`
        )
      }
    }
  }
}

/** S4: the off switch's report, and no Control UI write but the switch sets the ceiling. */
function checkS4(w: World): void {
  for (const record of w.switches) {
    const outcome = record.outcome
    if (!outcome) throw harnessError(`switch #${record.id} never ended`)
    if (outcome.kind === 'failed') continue
    count(w.stats, 'checks', 'S4')
    const owner: Owner = { kind: 'switch', id: record.id }
    const reads = ownedReads(w, owner).filter(read => {
      const host = hostOfRead(read)
      return host !== undefined && sameJson(host.spec, outcome.stored.spec)
    })
    const writes = w.timeline.filter(
      event => event.owner?.kind === 'switch' && event.owner.id === record.id
    )
    const readSaw = reads.some(read => ceilingOf(hostOfRead(read)) === 'manual')
    const wrote = writes.some(event => ceilingOf(event.after) === 'manual')
    if (outcome.kind === 'already' && (!readSaw || writes.length > 0)) {
      flag(
        w,
        'S4',
        `switch #${record.id} reported Already Manual with no read of its own that saw Manual`
      )
    }
    if (!readSaw && !wrote) {
      flag(
        w,
        'S4',
        `switch #${record.id} reported Manual with no read or write of its own that holds it`
      )
    }
    if (ceilingOf(outcome.stored) !== 'manual') {
      flag(
        w,
        'S4',
        `switch #${record.id} reported Manual from a Host whose ceiling is ${ceilingOf(outcome.stored)}`
      )
    }
  }
  for (const event of w.timeline) {
    if (event.kind !== 'request') continue
    // R23: control-api accepts a version-less PUT only when it leaves
    // `spec.approval` as stored (the version rule, spec §6.8).
    if (
      event.owner?.kind === 'legacy' &&
      !sameJson(event.before.spec.approval, event.after.spec.approval)
    ) {
      flag(
        w,
        'S4',
        `the pre-PR A PUT #${event.entry?.seq} was accepted and changed ${event.agent}'s approval block`
      )
    }
    const before = ceilingOf(event.before)
    const after = ceilingOf(event.after)
    if (event.owner?.kind === 'switch') {
      if (after !== 'manual') flag(w, 'S4', `switch PUT #${event.entry?.seq} stored ${after}`)
      continue
    }
    const afterSwitch = w.switches.some(
      record =>
        record.agent === event.agent &&
        record.outcome &&
        record.outcome.kind !== 'failed' &&
        (record.settleStep ?? Infinity) <= event.step
    )
    if (afterSwitch) count(w.stats, 'checks', 'S4')
    if (before !== after) {
      flag(
        w,
        'S4',
        `${event.owner?.kind ?? 'an older save'}'s PUT #${event.entry?.seq} moved ${event.agent}'s ceiling ${before} → ${after}`
      )
    }
  }
}

/** R23: the pre-PR A PUTs that would have changed the approval block, and were refused. */
function countLegacyRefusals(w: World): void {
  for (const entry of w.fake.log) {
    if (w.owners.get(entry.seq)?.kind !== 'legacy' || !entry.arrived) continue
    const body = entry.response?.body
    if (isRecord(body) && body.reason === 'approval_requires_version') {
      count(w.stats, 'checks', 'S4')
      count(w.stats, 'events', 'E23refused')
    }
  }
}

/** S7: every loosening item of a logged per-tool write was in a dialog confirmed for that save. */
function checkS7(w: World): void {
  for (const save of w.saves) {
    const firstSave = save.press.firstSavePolicy !== undefined
    const reads = ownedReads(w, { kind: 'save', id: save.id })
    for (const put of savePuts(w, save)) {
      const read = reads.find(
        entry => hostOfRead(entry)?.metadata.resourceVersion === put.versionSent
      )
      if (!read) throw harnessError(`save #${save.id}'s PUT #${put.seq} has no read of its version`)
      const fresh = blockOf(hostOfRead(read))
      const items = looseningItems({
        before: firstSave ? undefined : fresh,
        after: blockOf({ spec: sentSpec(put) }) ?? {},
        ceiling: ceilingOfBlock(fresh),
        firstSave,
      })
      if (items.length > 0) count(w.stats, 'checks', 'S7')
      const labels = new Set(save.press.labels ?? [])
      for (const item of items) {
        const label = item.path.startsWith('tools.') ? item.path.slice('tools.'.length) : 'Policy'
        if (!labels.has(label)) {
          flag(
            w,
            'S7',
            `save #${save.id}'s PUT #${put.seq} loosens ${item.path} (${item.rule}), which no dialog confirmed for it listed`
          )
        }
      }
    }
  }
}

/** S8: an older save always sends a version and never replaces another approval block. */
function checkS8(w: World): void {
  for (const entry of w.fake.log) {
    if (entry.kind !== 'write' || w.owners.get(entry.seq) !== null) continue
    if (agentOfPath(entry.path) === null) continue
    if (entry.versionSent === undefined) {
      flag(w, 'S8', `older save PUT #${entry.seq} carries no version`)
    }
    const event = applyEvent(w, entry)
    // Non-vacuous: the approval block changed after the state the save's form version names.
    const agent = agentOfPath(entry.path)
    const events = w.timeline.filter(item => item.agent === agent && item.logLen <= entry.seq)
    const formState = events.findLastIndex(
      item => item.after.metadata.resourceVersion === entry.versionSent
    )
    if (
      events
        .slice(formState + 1)
        .some(item => !sameJson(item.before.spec.approval, item.after.spec.approval))
    ) {
      count(w.stats, 'checks', 'S8')
    }
    if (event && !sameJson(sentSpec(entry).approval, event.before.spec.approval)) {
      flag(
        w,
        'S8',
        `older save PUT #${entry.seq} was accepted with an approval block other than the stored one`
      )
    }
  }
}

/**
 * L2 at rest: once every load has settled, an edit the admin left off its
 * base (by the oracle's reader, not the section's own "Unsaved changes") can
 * be saved.
 */
function checkL2(w: World): void {
  const section = perToolSection()
  const view = currentView(w)
  if (!section || !view?.dirty || !onApprovals(w) || !editing(section) || dialogOpen()) return
  count(w.stats, 'checks', 'L2')
  if (!usable(button(section, 'Save'))) {
    flag(w, 'L2', 'every load has settled and Save is still disabled')
  }
}

/**
 * How L3 sees a switch run: its conflicts (writes answered 409), and every
 * other request. An other is a request the switch never received (hung,
 * dropped or timed out: not delivered, Ruling 68) or any answer but 200 or a
 * write's 409. L3 holds the run only when it met one to six conflicts and
 * nothing else, and no `AdvanceClock` command moved the clock during it.
 */
function l3Run(
  w: World,
  record: SwitchRecord
): { conflicts: FakeLogEntry[]; others: FakeLogEntry[]; held: boolean } {
  const requests = w.fake.log.filter(entry => {
    const tag = w.owners.get(entry.seq)
    return tag?.kind === 'switch' && tag.id === record.id
  })
  const conflicts = requests.filter(
    entry => entry.kind === 'write' && entry.response?.status === 409
  )
  const others = requests.filter(
    entry =>
      !entry.delivered ||
      !(
        entry.response?.status === 200 ||
        (entry.kind === 'write' && entry.response?.status === 409)
      )
  )
  const held =
    conflicts.length > 0 && conflicts.length <= 6 && others.length === 0 && !record.clockMoved
  return { conflicts, others, held }
}

/**
 * L3: the switch succeeds through up to six conflicts inside its 20 s budget.
 * The spec promises that only after consecutive conflicts, so L3 holds only a
 * run whose every request was delivered and answered 200, or 409 for a
 * write (l3Run). Without a moved clock, a held run's time is its backoff
 * waits alone: the drain runs the clock only to the next timer, and only when
 * no request of the run is still to be answered.
 */
function checkL3(w: World): void {
  for (const record of w.switches) {
    const outcome = record.outcome
    if (!outcome) continue
    const { conflicts, held } = l3Run(w, record)
    if (!held) continue
    const elapsed = (record.settleClock ?? 0) - record.startClock
    count(w.stats, 'checks', 'L3')
    if (outcome.kind === 'failed') {
      flag(
        w,
        'L3',
        `switch #${record.id} failed after ${conflicts.length} conflicts, ${elapsed} ms into its 20 s budget`
      )
    }
  }
}

/**
 * E16's cases: the older saves' PUTs of `agent` with an approval write and a
 * load that answered between the save's read and its PUT.
 */
function olderSavesBetween(w: World, agent: Agent): FakeLogEntry[] {
  return w.fake.log.filter(put => {
    if (put.kind !== 'write' || w.owners.get(put.seq) !== null || agentOfPath(put.path) !== agent) {
      return false
    }
    const read = [...w.fake.log]
      .reverse()
      .find(
        entry =>
          entry.seq < put.seq &&
          entry.kind === 'read' &&
          entry.path === put.path &&
          w.owners.get(entry.seq) === null
      )
    if (!read) return false
    const approvalWrite = w.timeline.some(
      event =>
        event.agent === agent &&
        event.logLen >= read.seq &&
        event.logLen <= put.seq &&
        !sameJson(event.before.spec.approval, event.after.spec.approval)
    )
    const load = w.fake.log.some(
      entry =>
        entry.path === `/api/v1/admin/hosts/${agent}/detail` &&
        entry.seq > read.seq &&
        entry.seq < put.seq &&
        entry.delivered
    )
    return approvalWrite && load
  })
}

/** Events read off the history once the run is at rest: E10, E16, E17. */
function countHistoryEvents(w: World): void {
  const order = new Map(w.deliveries.map((seq, index) => [seq, index]))
  for (const agent of AGENTS) {
    const loads = w.fake.log.filter(
      entry => entry.path === `/api/v1/admin/hosts/${agent}/detail` && order.has(entry.seq)
    )
    // E10: within one tab view, a load sent in a later step answered first.
    // (A mount, and a Retry, send the tab's load and the page's in one step.)
    for (const later of loads) {
      const view = [...w.views.values()]
        .filter(item => item.agent === agent && item.openedLogLen < later.seq)
        .at(-1)
      if (!view) continue
      const overtaken = loads.some(
        earlier =>
          earlier.seq < later.seq &&
          earlier.seq > view.openedLogLen &&
          w.sentAt.get(earlier.seq) !== w.sentAt.get(later.seq) &&
          (order.get(earlier.seq) as number) > (order.get(later.seq) as number)
      )
      if (overtaken) count(w.stats, 'events', 'E10')
    }
    // E16: an older save's PUT, with an approval write and a load landing between its read and it.
    count(w.stats, 'events', 'E16', olderSavesBetween(w, agent).length)
  }
  // E17: a protocol's read before its PUT failed (network, 5xx, 403, 429, or its timeout).
  for (const entry of w.fake.log) {
    const owner = w.owners.get(entry.seq)
    if (entry.kind !== 'read' || (owner?.kind !== 'save' && owner?.kind !== 'switch')) continue
    if (entry.response?.status !== 200 || !entry.delivered) count(w.stats, 'events', 'E17')
  }
}

function checkAtRest(w: World): void {
  countHistoryEvents(w)
  // L4 at rest: every run's outcome was shown, in its tab or by its toast.
  for (const record of w.switches) {
    count(w.stats, 'checks', 'L4rest')
    if (!record.shown) flag(w, 'L4', `switch #${record.id} ended and was never shown`)
  }
  checkS1(w)
  checkS2(w)
  checkS3(w)
  checkS4(w)
  countLegacyRefusals(w)
  checkS7(w)
  checkS8(w)
  checkGroups(w, true)
  checkL2(w)
  checkL3(w)
  raise(w)
}

// ── Commands ────────────────────────────────────────────────────────────────

abstract class Command implements fc.AsyncCommand<Model, World> {
  check(): boolean {
    return true
  }
  abstract perform(w: World): Promise<void>
  async run(_model: Model, w: World): Promise<void> {
    if (process.env.APPROVAL_MODEL_DEBUG) console.info(`[${w.step}] ${this.toString()}`)
    await this.perform(w)
  }
  abstract toString(): string
}

/** Releases `times` scheduled points, one per step. */
class Step extends Command {
  constructor(readonly times: number) {
    super()
  }
  async perform(w: World) {
    for (let index = 0; index < this.times; index += 1) await step(w)
  }
  toString() {
    return `Step(${this.times})`
  }
}

/** Releases points until the next save or switch ends (at most `max`): the admin waits for it. */
class UntilSettled extends Command {
  constructor(readonly max: number) {
    super()
  }
  async perform(w: World) {
    const ended = () =>
      w.saves.filter(save => save.outcome).length + w.switches.filter(item => item.outcome).length
    const before = ended()
    await stepUntil(w, () => ended() > before, this.max)
  }
  toString() {
    return `UntilSettled(${this.max})`
  }
}

/** Moves the virtual clock: request timeouts, the switch's backoff and its 20 s budget. */
class AdvanceClock extends Command {
  constructor(readonly ms: number) {
    super()
  }
  async perform(w: World) {
    // The drain moves the clock only to the next timer; this command can jump
    // past a run's budget, so L3 holds no run this command moved.
    for (const record of w.switches) if (!record.outcome) record.clockMoved = true
    await advanceClock(w, this.ms)
  }
  toString() {
    return `AdvanceClock(${this.ms})`
  }
}

async function interact(w: World, fn: () => void): Promise<void> {
  w.step += 1
  await inAct(w, fn)
  afterCommand(w)
}

/** Releases scheduled points until `ready` holds, at most `max`: the admin waits for the page. */
async function stepUntil(w: World, ready: () => boolean, max: number): Promise<boolean> {
  for (let index = 0; index < max && !ready(); index += 1) {
    if (w.scheduler.count() === 0) break
    await step(w)
  }
  return ready()
}

/** Goes to the Approvals tab of the agent shown, remounting the page as the shipped build does. */
async function ensureApprovals(w: World): Promise<void> {
  if (!onApprovals(w)) await remount(w, w.instance.agent, APPROVALS_SLUG)
}

/** The section, ready for an edit: loaded, in either view, with no dialog open. */
function editable(): HTMLElement | null {
  const section = perToolSection()
  if (!section || dialogOpen()) return null
  return editing(section) || button(section, 'Edit') !== null ? section : null
}

/**
 * Edit if needed, then the rows. S2's base is what the rows showed when the
 * session turned dirty, by the oracle's own reader: §6.4's section takes new
 * data as its base while clean, so the base freezes at the first change that
 * leaves the draft off it.
 */
async function editRows(w: World, changes: ReadonlyArray<[number, RowState]>): Promise<void> {
  const view = currentView(w)
  const section = editable()
  if (!view || !section) return
  const edit = button(section, 'Edit')
  if (edit) {
    await interact(w, () => fireEvent.click(edit))
    view.dirty = false
  }
  for (const [slot, state] of changes) {
    const current = perToolSection()
    if (!current || !editing(current) || dialogOpen()) return
    const name = NATIVE[view.agent][slot % NATIVE[view.agent].length]
    const select = current.querySelector<HTMLSelectElement>(`#approval-${name}`)
    if (!select || select.disabled) return
    const capture = {
      tools: shownRows(current),
      inherited: inheritingShown(tabRoot() as HTMLElement),
      logLen: w.fake.log.length,
    }
    const base = view.dirty && view.base ? view.base.tools : capture.tools
    await interact(w, () => fireEvent.change(select, { target: { value: state } }))
    const after = perToolSection()
    if (!after) return
    const dirtyNow = !sameTools(shownRows(after), base)
    if (!view.dirty && dirtyNow) {
      view.base = { ...capture, source: baseSource(w, view.agent, capture) }
    }
    view.dirty = dirtyNow
  }
}

/** The logged answer the section's base came from (spec A6: S2's base is a logged read or write response). */
function baseSource(
  w: World,
  agent: Agent,
  capture: { tools: Tools; inherited: boolean }
): number | 'seed' {
  const matches = (host: unknown) =>
    (blockOf(host) === undefined) === capture.inherited &&
    sameTools(effectiveTools(host), capture.tools)
  for (let index = w.fake.log.length - 1; index >= 0; index -= 1) {
    const entry = w.fake.log[index]
    if (agentOfPath(entry.path) !== agent || !entry.delivered || entry.response?.status !== 200) {
      continue
    }
    const host = entry.kind === 'read' ? hostOfRead(entry) : (entry.response.body as HostObject)
    if (host && matches(host)) return entry.seq
  }
  if (matches(w.seeds[agent])) return 'seed'
  throw harnessError(
    `the ${agent} section's base ${JSON.stringify(capture)} matches no logged answer`
  )
}

/** Handles the first-save dialog a press opened: picks the policy and saves. */
async function answerFirstSave(w: World, press: Press, policy: FirstSavePolicy): Promise<void> {
  const dialog = dialogNamed('dialog', FIRST_SAVE_DIALOG_TITLE)
  if (!dialog) return
  fireEvent.change(within(dialog).getByLabelText(FIRST_SAVE_POLICY_LABEL), {
    target: { value: policy },
  })
  const save = button(dialog, 'Save')
  if (!save) throw harnessError('the first-save dialog has no Save')
  // The answer stays on the press: a loosening dialog that follows confirms it.
  press.firstSavePolicy = policy
  w.press = press
  try {
    await interact(w, () => fireEvent.click(save))
  } finally {
    w.press = null
  }
}

function rememberDialog(w: World, press: Press): void {
  const view = w.views.get(press.viewId)
  if (view && dialogNamed('alertdialog', LOOSENING_DIALOG_TITLE)) {
    view.dialog = press
  }
}

/** Save, once or twice in one tick (E11), then the first-save dialog's policy. */
async function pressSave(w: World, policy: FirstSavePolicy, double: boolean): Promise<void> {
  const view = currentView(w)
  const section = perToolSection()
  if (!view || !section || dialogOpen()) return
  const save = button(section, 'Save')
  if (!usable(save)) return
  const press: Press = {
    viewId: view.id,
    draft: shownRows(section),
    base: view.base,
    labels: null,
  }
  if (double) count(w.stats, 'events', 'E11')
  const before = w.saves.length
  w.press = press
  try {
    await interact(w, () => {
      fireEvent.click(save)
      if (double) fireEvent.click(save)
    })
  } finally {
    w.press = null
  }
  if (w.saves.length - before > 1) throw violation('C2', 'one press of Save started two saves')
  await answerFirstSave(w, press, policy)
  rememberDialog(w, press)
}

/** The loosening dialog's Save: the labels it lists are the ones this save confirms (S7). */
async function confirmDialog(w: World): Promise<void> {
  const view = currentView(w)
  const dialog = dialogNamed('alertdialog', LOOSENING_DIALOG_TITLE)
  if (!view || !dialog || !view.dialog) return
  const labels = Array.from(dialog.querySelectorAll<HTMLElement>('[data-loosening-item]')).map(
    node => node.dataset.looseningItem ?? ''
  )
  const confirm = button(dialog, LOOSENING_CONFIRM_LABEL)
  if (!confirm) throw harnessError('the loosening dialog has no confirm button')
  w.press = { ...view.dialog, labels }
  try {
    await interact(w, () => fireEvent.click(confirm))
  } finally {
    w.press = null
  }
}

/** E1 (the edit before it). */
class EditTools extends Command {
  constructor(readonly changes: Array<[number, RowState]>) {
    super()
  }
  async perform(w: World) {
    await editRows(w, this.changes)
  }
  toString() {
    return `EditTools(${JSON.stringify(this.changes)})`
  }
}

/** E1 / E11: Save, once or twice in one tick. */
class PressSave extends Command {
  constructor(
    readonly policy: FirstSavePolicy,
    readonly double: boolean
  ) {
    super()
  }
  async perform(w: World) {
    await pressSave(w, this.policy, this.double)
  }
  toString() {
    return `PressSave(${this.policy}, ${this.double})`
  }
}

/**
 * E1 whole: to the Approvals tab, wait for the section, edit, wait for Save,
 * press it, answer the first-save dialog, and confirm a loosening dialog now
 * or leave it open for a later `ConfirmDialog` (E20).
 */
class SaveDraft extends Command {
  constructor(
    readonly changes: Array<[number, RowState]>,
    readonly policy: FirstSavePolicy,
    readonly confirmNow: boolean,
    readonly double: boolean
  ) {
    super()
  }
  async perform(w: World) {
    await ensureApprovals(w)
    if (!(await stepUntil(w, () => editable() !== null, 12))) return
    await editRows(w, this.changes)
    const saveReady = () => {
      const section = perToolSection()
      return section !== null && !dialogOpen() && usable(button(section, 'Save'))
    }
    if (!(await stepUntil(w, saveReady, 8))) return
    await pressSave(w, this.policy, this.double)
    if (this.confirmNow) await confirmDialog(w)
  }
  toString() {
    return `SaveDraft(${JSON.stringify(this.changes)}, ${this.policy}, ${this.confirmNow}, ${this.double})`
  }
}

/** The loosening dialog's Save. */
class ConfirmDialog extends Command {
  async perform(w: World) {
    await confirmDialog(w)
  }
  toString() {
    return 'ConfirmDialog'
  }
}

class BackOut extends Command {
  async perform(w: World) {
    const loosening = dialogNamed('alertdialog', LOOSENING_DIALOG_TITLE)
    const first = dialogNamed('dialog', FIRST_SAVE_DIALOG_TITLE)
    const back = loosening
      ? button(loosening, LOOSENING_CANCEL_LABEL)
      : first
        ? button(first, 'Cancel')
        : null
    if (back) await interact(w, () => fireEvent.click(back))
  }
  toString() {
    return 'BackOut'
  }
}

/** E3. */
class PressCancel extends Command {
  async perform(w: World) {
    const section = perToolSection()
    if (!section || dialogOpen()) return
    const cancel = button(section, 'Cancel')
    if (!usable(cancel)) return
    count(w.stats, 'events', 'E3')
    await interact(w, () => fireEvent.click(cancel))
  }
  toString() {
    return 'PressCancel'
  }
}

/** The tab's load Retry, or the section's Retry after an error (a new save). */
class PressRetry extends Command {
  constructor(readonly policy: FirstSavePolicy) {
    super()
  }
  async perform(w: World) {
    const view = currentView(w)
    const root = tabRoot()
    if (!view || !root || dialogOpen()) return
    const banner = root.querySelector<HTMLElement>('.cu-host-approvals-tab__error')
    const loadRetry = banner ? button(banner, 'Retry') : null
    if (usable(loadRetry)) {
      await interact(w, () => fireEvent.click(loadRetry))
      return
    }
    const section = perToolSection()
    const message = section ? sectionMessage(section) : null
    const saveRetry = message ? button(message, 'Retry') : null
    if (!section || !usable(saveRetry)) return
    const press: Press = {
      viewId: view.id,
      draft: shownRows(section),
      base: view.base,
      labels: null,
    }
    w.press = press
    try {
      await interact(w, () => fireEvent.click(saveRetry))
    } finally {
      w.press = null
    }
    await answerFirstSave(w, press, this.policy)
    rememberDialog(w, press)
  }
  toString() {
    return `PressRetry(${this.policy})`
  }
}

/** E2 / E19: Set to Manual now, once or twice in one tick; it needs no loaded data. */
class SetToManual extends Command {
  constructor(readonly double: boolean) {
    super()
  }
  async perform(w: World) {
    await ensureApprovals(w)
    const root = tabRoot()
    if (!root) return
    const press = button(root, /^(Set to Manual now|Setting Manual…)$/)
    if (!press) return
    if (isSettingManual(w.instance.agent) || this.double) count(w.stats, 'events', 'E19')
    const before = w.switches.length
    await interact(w, () => {
      fireEvent.click(press)
      if (this.double) fireEvent.click(press)
    })
    if (w.switches.length - before > 1) {
      throw violation('C2', 'one press of Set to Manual now started two runs')
    }
  }
  toString() {
    return `SetToManual(${this.double})`
  }
}

/** L3: the next `times` versioned PUTs of the agent shown meet a conflict, then Set to Manual now. */
class SwitchThroughConflicts extends Command {
  constructor(readonly times: number) {
    super()
  }
  async perform(w: World) {
    await ensureApprovals(w)
    w.conflicts[w.instance.agent] = this.times
    await new SetToManual(false).perform(w)
  }
  toString() {
    return `SwitchThroughConflicts(${this.times})`
  }
}

type ExternalChange =
  | { kind: 'tools'; slot: number; value: boolean | null }
  | { kind: 'ceiling'; value: 'manual' | 'auto' | 'allow_all' | null }
  | { kind: 'policy'; value: 'channel_users' | 'cli_only' | 'designated_approvers' | null }
  | { kind: 'approvers'; take: number }
  | { kind: 'channelSwitch'; value: boolean }
  | { kind: 'judge'; value: string | null }
  | { kind: 'create' }
  | { kind: 'remove' }
  | { kind: 'spec' }

function setLeaf(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null) delete target[key]
  else target[key] = value
}

/** E4, E4x, E5, E15, E21: another writer (an admin, kubectl, a manifest apply). */
class External extends Command {
  constructor(
    readonly agent: Agent,
    readonly change: ExternalChange
  ) {
    super()
  }
  async perform(w: World) {
    const { agent, change } = this
    const before = w.fake.stored(agent)
    const hadBlock = isRecord(before.spec.approval)
    let intended: Record<string, unknown> = {}
    w.fake.writeExternal(agent, spec => {
      mutate(spec)
      intended = clone(spec)
    })
    function mutate(spec: Record<string, unknown>): void {
      if (change.kind === 'spec') {
        spec.contextRef = `ctx-${w.timeline.length + 1}`
        return
      }
      if (change.kind === 'remove') {
        delete spec.approval
        return
      }
      const block = isRecord(spec.approval) ? spec.approval : {}
      spec.approval = block
      if (change.kind === 'create') {
        block.channels = { telegram: { approvers: [APPROVERS[agent][0]] } }
        return
      }
      if (change.kind === 'tools') {
        const tools = isRecord(block.tools) ? block.tools : {}
        const names = [...NATIVE[agent], PROBE[agent]]
        setLeaf(tools, names[change.slot % names.length], change.value)
        block.tools = tools
      } else if (change.kind === 'ceiling') {
        setLeaf(block, 'modeCeiling', change.value)
      } else if (change.kind === 'policy') {
        setLeaf(block, 'defaultPolicy', change.value)
      } else if (change.kind === 'approvers') {
        block.channels = {
          ...(isRecord(block.channels) ? block.channels : {}),
          telegram: { approvers: APPROVERS[agent].slice(0, 1 + (change.take % 2)) },
        }
      } else if (change.kind === 'channelSwitch') {
        const channels = isRecord(block.channels) ? block.channels : {}
        channels.slack = {
          ...(isRecord(channels.slack) ? channels.slack : {}),
          allowModeChange: change.value,
        }
        block.channels = channels
      } else {
        setLeaf(block, 'shellClassifierModel', change.value)
      }
    }
    w.step += 1
    observeStores(w, 'external')
    // E7: the CRD pruned a leaf the writer set.
    const sent = blockOf({ spec: intended })
    if (sent && !sameJson(pruneApprovalBlock(sent, loadHostCrdApprovalSchema(w.crd)), sent)) {
      count(w.stats, 'events', 'E7')
    }
    const after = w.fake.stored(agent)
    const hasBlock = isRecord(after.spec.approval)
    const tools = !sameTools(effectiveTools(before), effectiveTools(after))
    if (hadBlock !== hasBlock) {
      count(w.stats, 'events', 'blockCreatedOrRemoved')
      // E15 proper: an edit on this agent is under way, its base taken from
      // the block as it was (a first save, or one whose block disappears).
      const editing = [...w.views.values()].some(
        view => view.agent === agent && view.base !== null && view.base.inherited !== hasBlock
      )
      if (editing || w.saves.some(save => save.agent === agent && !save.outcome)) {
        count(w.stats, 'events', 'E15')
      }
    }
    if (tools) count(w.stats, 'events', 'E4')
    if (!sameJson(blockOf(before), blockOf(after)) && !tools) count(w.stats, 'events', 'E4x')
    if (change.kind === 'spec') count(w.stats, 'events', 'E5')
    const raised = ceilingOf(after) !== 'manual' && ceilingOf(before) === 'manual'
    if (
      raised &&
      w.switches.some(
        record => record.agent === agent && record.outcome && record.outcome.kind !== 'failed'
      )
    ) {
      count(w.stats, 'events', 'E21')
    }
    // E20: between a per-tool dialog (open, or confirmed and saving) and the write.
    if (
      ceilingOf(before) !== ceilingOf(after) &&
      (dialogNamed('alertdialog', LOOSENING_DIALOG_TITLE) !== null ||
        w.saves.some(save => save.agent === agent && !save.outcome))
    ) {
      count(w.stats, 'events', 'E20')
    }
    await interact(w, () => undefined)
  }
  toString() {
    return `External(${this.agent}, ${JSON.stringify(this.change)})`
  }
}

/** E6: a status write, a wake annotation, or another writer's post-write patch. */
class Bump extends Command {
  constructor(
    readonly agent: Agent,
    readonly kind: 'status' | 'annotation' | 'post-write'
  ) {
    super()
  }
  async perform(w: World) {
    w.fake.bumpVersion(this.agent, this.kind)
    count(w.stats, 'events', 'E6')
    await interact(w, () => undefined)
  }
  toString() {
    return `Bump(${this.agent}, ${this.kind})`
  }
}

/** E6, timed: the next `times` versioned PUTs of the agent each meet a status write just before they apply. */
class ArmConflicts extends Command {
  constructor(
    readonly agent: Agent,
    readonly times: number
  ) {
    super()
  }
  async perform(w: World) {
    w.conflicts[this.agent] = this.times
  }
  toString() {
    return `ArmConflicts(${this.agent}, ${this.times})`
  }
}

const FAULT_ROUTE: Readonly<Record<FaultTarget, { method: string; suffix: string }>> = {
  put: { method: 'PUT', suffix: '' },
  read: { method: 'GET', suffix: '' },
  load: { method: 'GET', suffix: '/detail' },
}

/** E13, E14, E17: the next request of a kind gets a fault. */
class ArmFault extends Command {
  constructor(
    readonly agent: Agent,
    readonly target: FaultTarget,
    readonly kind: FaultKind
  ) {
    super()
  }
  async perform(w: World) {
    const { method, suffix } = FAULT_ROUTE[this.target]
    const path = `/api/v1/admin/hosts/${this.agent}${suffix}`
    // One armed hold per route: the fake refuses two that match one request.
    if (
      w.faults.some(
        fault => fault.method === method && fault.path === path && fault.entrySeq === undefined
      )
    )
      return
    const fault: Fault = {
      agent: this.agent,
      target: this.target,
      kind: this.kind,
      method,
      path,
      hold: w.fake.hold({ method, path }),
      applyHeld: false,
      appliedLate: false,
    }
    w.faults.push(fault)
    void fault.hold.arrived
      .then(() => strike(w, fault))
      .catch((error: unknown) => {
        // Raised by the next step's checks, which name it, rather than lost
        // as an unhandled rejection.
        flag(w, 'harness', String(error))
      })
  }
  toString() {
    return `ArmFault(${this.agent}, ${this.target}, ${this.kind})`
  }
}

/** The fault, when its request arrives. A hang only on a protocol's request, which its own clock ends. */
function strike(w: World, fault: Fault): void {
  const entry = w.fake.log.find(item => item.seq === fault.entrySeq)
  if (!entry) throw harnessError(`a hold on ${fault.method} ${fault.path} struck no logged request`)
  const owner = w.owners.get(entry.seq)
  const protocol = owner?.kind === 'save' || owner?.kind === 'switch'
  const { hold } = fault
  switch (fault.kind) {
    case 'drop':
      hold.dropResponse()
      break
    case 'applied-504':
    case 'applied-502':
      hold.applyNow()
      if (fault.kind === 'applied-504') hold.respondWith(PROXY_504.status, PROXY_504.body)
      else hold.respondWith(PROXY_502.status, PROXY_502.body)
      break
    case 'unapplied-504':
      fault.applyHeld = entry.kind === 'write'
      hold.respondWith(PROXY_504.status, PROXY_504.body)
      break
    case 'hang':
      if (protocol) {
        fault.applyHeld = entry.kind === 'write'
        hold.hang()
      } else {
        hold.dropResponse()
      }
      break
    case '403':
      hold.respondWith(SERVER_403.status, SERVER_403.body)
      break
    case '422':
      hold.respondWith(SERVER_422.status, SERVER_422.body)
      break
    case '500':
      hold.respondWith(SERVER_500.status, SERVER_500.body)
      break
    case '502':
      hold.respondWith(PROXY_502.status, PROXY_502.body)
      break
    case '504':
      hold.respondWith(PROXY_504.status, PROXY_504.body)
      break
    case '429':
      // No producer answers 429 on these routes (no rate limiter is mounted):
      // the status alone, with no body, as the client reads one.
      hold.respondWith(429, undefined)
      break
  }
  if (entry.kind === 'write') {
    // E13 is a PUT with no answer or a 5xx; a 403 or 422 is a refusal.
    const refusal = fault.kind === '403' || fault.kind === '422'
    count(w.stats, 'events', refusal ? 'putRefusal' : 'E13')
  } else if (isDetailPath(entry.path)) {
    count(w.stats, 'events', 'loadFault')
  }
}

/** E22: control-api applies a write the browser gave up on. */
class ApplyLate extends Command {
  async perform(w: World) {
    const fault = w.faults.find(item => item.applyHeld && !item.appliedLate)
    if (!fault) return
    fault.appliedLate = true
    const entry = w.fake.log.find(item => item.seq === fault.entrySeq)
    if (entry && !entry.applied) count(w.stats, 'events', 'E22')
    fault.hold.applyNow()
    await interact(w, () => undefined)
  }
  toString() {
    return 'ApplyLate'
  }
}

function inFlight(w: World, agent?: Agent): boolean {
  return (
    w.saves.some(save => !save.outcome && (agent === undefined || save.agent === agent)) ||
    w.switches.some(record => !record.outcome && (agent === undefined || record.agent === agent))
  )
}

/** The step a logged request was sent in: the tagged `fetch` records it for every request. */
function sentStep(w: World, entry: FakeLogEntry): number {
  const step = w.sentAt.get(entry.seq)
  if (step === undefined) throw harnessError(`request #${entry.seq} was logged with no send step`)
  return step
}

async function remount(w: World, agent: Agent, tab: TabSlug): Promise<void> {
  if (onApprovals(w)) count(w.stats, 'events', 'E8')
  if (inFlight(w)) count(w.stats, 'events', 'E9')
  await interact(w, () => {
    const link = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      node => (node.textContent ?? '').trim() === TAB_LABEL[tab]
    )
    if (link && agent === w.instance.agent) fireEvent.click(link)
    w.page.remount({ name: agent, tab })
    w.instanceSeq += 1
    w.instance = { id: w.instanceSeq, agent, tab, viewId: null, mountStep: w.step }
    openView(w)
  })
}

/** E8: a header tab (the shipped build remounts the page). */
class Navigate extends Command {
  constructor(readonly tab: TabSlug) {
    super()
  }
  async perform(w: World) {
    await remount(w, w.instance.agent, this.tab)
  }
  toString() {
    return `Navigate(${this.tab})`
  }
}

/** E9: another agent; remounted as the shipped build does, or kept (harness only). */
class SwitchAgent extends Command {
  constructor(readonly kept: boolean) {
    super()
  }
  async perform(w: World) {
    const next = OTHER[w.instance.agent]
    if (!this.kept) {
      await remount(w, next, w.instance.tab)
      return
    }
    if (inFlight(w)) count(w.stats, 'events', 'E9')
    await interact(w, () => {
      w.page.rerenderKept({ name: next })
      w.instance.agent = next
      openView(w)
    })
  }
  toString() {
    return `SwitchAgent(${this.kept ? 'kept' : 'remount'})`
  }
}

/** E16: an Overview, Model or guardrails save: to its tab, wait for its control, press. */
class OlderSave extends Command {
  constructor(readonly kind: OlderKind) {
    super()
  }
  async perform(w: World) {
    const tab: TabSlug =
      this.kind === 'overview' ? 'overview' : this.kind === 'model' ? 'model' : 'advanced'
    if (w.instance.tab !== tab) await remount(w, w.instance.agent, tab)
    const agent = w.instance.agent
    if (this.kind === 'overview') {
      const edit = () => button(document, 'Edit agent name')
      if (!(await stepUntil(w, () => usable(edit()), 12))) return
      await interact(w, () => fireEvent.click(edit() as HTMLElement))
      const input = document.getElementById('host-display-name')
      if (!input) return
      w.renames += 1
      await interact(w, () =>
        fireEvent.change(input, { target: { value: `${agent} renamed ${w.renames}` } })
      )
      const save = button(document, 'Save agent name')
      if (!usable(save)) return
      await interact(w, () => fireEvent.click(save))
    } else if (this.kind === 'model') {
      const edit = () => button(document, 'Edit')
      if (!(await stepUntil(w, () => usable(edit()), 12))) return
      await interact(w, () => fireEvent.click(edit() as HTMLElement))
      const dialog = dialogNamed('dialog', 'Edit model & credentials')
      const save = dialog ? button(dialog, 'Save') : null
      if (!usable(save)) return
      await interact(w, () => fireEvent.click(save))
    } else {
      const actions = () => button(document, 'Actions for sample-hook')
      if (!(await stepUntil(w, () => usable(actions()), 12))) return
      await interact(w, () => fireEvent.click(actions() as HTMLElement))
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        node => (node.textContent ?? '').trim() === 'Remove from Pre-call'
      )
      if (!item) return
      await interact(w, () => fireEvent.click(item))
      const remove = button(document, 'Remove')
      if (!usable(remove)) return
      await interact(w, () => fireEvent.click(remove))
    }
    count(w.stats, 'events', 'olderSavePress')
  }
  toString() {
    return `OlderSave(${this.kind})`
  }
}

/** E8 / E19: the same agent and tab in a new page instance (a remount). */
class Remount extends Command {
  async perform(w: World) {
    await remount(w, w.instance.agent, w.instance.tab)
  }
  toString() {
    return 'Remount'
  }
}

/** E23: a tab still on pre-PR A code PUTs its stale read's block with new tools and no version. */
class LegacyPut extends Command {
  constructor(
    readonly agent: Agent,
    readonly pick: number,
    readonly tools: Array<[number, boolean]>
  ) {
    super()
  }
  async perform(w: World) {
    const reads = w.fake.log
      .filter(entry => entry.kind === 'read' && agentOfPath(entry.path) === this.agent)
      .map(hostOfRead)
      .filter((host): host is HostObject => host !== undefined)
    const source = reads.length > 0 ? reads[this.pick % reads.length] : w.seeds[this.agent]
    const spec = clone(source.spec)
    const tools: Record<string, boolean> = {}
    for (const [slot, value] of this.tools)
      tools[NATIVE[this.agent][slot % NATIVE[this.agent].length]] = value
    spec.approval = { ...(isRecord(spec.approval) ? spec.approval : {}), tools }
    w.legacyCount += 1
    count(w.stats, 'events', 'E23')
    const id = w.legacyCount
    await interact(w, () => {
      void requestOwner.run({ kind: 'legacy', id }, () =>
        apiSend('PUT', `/api/v1/admin/hosts/${this.agent}`, { spec }).catch(() => {
          // The pre-PR A tab's own outcome is not under test: the fake's log
          // keeps control-api's answer, which S4 and the version rule read.
          return undefined
        })
      )
    })
  }
  toString() {
    return `LegacyPut(${this.agent}, ${this.pick}, ${JSON.stringify(this.tools)})`
  }
}

// ── Arbitraries ─────────────────────────────────────────────────────────────

const agentArb = fc.constantFrom<Agent>('alpha', 'beta')
const policyArb = fc.constantFrom<FirstSavePolicy>('channel_users', 'cli_only')
const rowStateArb = fc.constantFrom<RowState>('default', 'required', 'skip')

const externalChangeArb: fc.Arbitrary<ExternalChange> = fc.oneof(
  fc.record({
    kind: fc.constant('tools' as const),
    slot: fc.nat(4),
    value: fc.constantFrom(true, false, null),
  }),
  fc.record({
    kind: fc.constant('ceiling' as const),
    value: fc.constantFrom('manual' as const, 'auto' as const, 'allow_all' as const, null),
  }),
  fc.record({
    kind: fc.constant('policy' as const),
    value: fc.constantFrom(
      'channel_users' as const,
      'cli_only' as const,
      'designated_approvers' as const,
      null
    ),
  }),
  fc.record({ kind: fc.constant('approvers' as const), take: fc.nat(1) }),
  fc.record({ kind: fc.constant('channelSwitch' as const), value: fc.boolean() }),
  fc.record({
    kind: fc.constant('judge' as const),
    value: fc.constantFrom('gpt-5.5', 'gpt-4.1-mini', null),
  }),
  fc.constant({ kind: 'create' as const }),
  fc.constant({ kind: 'remove' as const }),
  fc.constant({ kind: 'spec' as const })
)

const faultArb = fc.oneof(
  fc.tuple(
    agentArb,
    fc.constant<FaultTarget>('put'),
    fc.constantFrom<FaultKind>(
      'drop',
      'applied-504',
      'applied-502',
      'unapplied-504',
      'hang',
      '403',
      '422'
    )
  ),
  fc.tuple(
    agentArb,
    fc.constant<FaultTarget>('read'),
    fc.constantFrom<FaultKind>('drop', '500', '502', '504', '403', '429', 'hang')
  ),
  fc.tuple(
    agentArb,
    fc.constant<FaultTarget>('load'),
    fc.constantFrom<FaultKind>('drop', '500', '502', '504')
  )
)

const stepArb = fc.integer({ min: 1, max: 3 }).map(times => new Step(times))
const changesArb = fc.array(fc.tuple(fc.nat(3), rowStateArb), { minLength: 1, maxLength: 3 })
const saveDraftArb = fc
  .tuple(
    changesArb,
    policyArb,
    fc.constantFrom(true, true, true, false),
    fc.constantFrom(false, false, false, true)
  )
  .map(
    ([changes, policy, confirmNow, double]) => new SaveDraft(changes, policy, confirmNow, double)
  )
const externalArb = fc
  .tuple(agentArb, externalChangeArb)
  .map(([agent, change]) => new External(agent, change))
const faultCommandArb = faultArb.map(([agent, target, kind]) => new ArmFault(agent, target, kind))

/** Weighted by repetition (fc.commands picks each entry alike). */
const commandArbs: Array<fc.Arbitrary<fc.AsyncCommand<Model, World>>> = [
  stepArb,
  stepArb,
  stepArb,
  stepArb,
  stepArb,
  stepArb,
  fc.integer({ min: 4, max: 8 }).map(times => new Step(times)),
  fc.integer({ min: 4, max: 8 }).map(times => new Step(times)),
  fc.constant(new UntilSettled(16)),
  saveDraftArb,
  saveDraftArb,
  saveDraftArb,
  changesArb.map(changes => new EditTools(changes)),
  fc
    .tuple(policyArb, fc.constantFrom(false, false, true))
    .map(([policy, double]) => new PressSave(policy, double)),
  fc.constant(new ConfirmDialog()),
  fc.constant(new BackOut()),
  fc.constant(new PressCancel()),
  fc.constant(new PressCancel()),
  policyArb.map(policy => new PressRetry(policy)),
  fc.boolean().map(double => new SetToManual(double)),
  fc.boolean().map(double => new SetToManual(double)),
  externalArb,
  externalArb,
  externalArb,
  fc
    .tuple(
      agentArb,
      fc.constantFrom('status' as const, 'annotation' as const, 'post-write' as const)
    )
    .map(([agent, kind]) => new Bump(agent, kind)),
  fc
    .tuple(agentArb, fc.constantFrom(1, 2, 6))
    .map(([agent, times]) => new ArmConflicts(agent, times)),
  faultCommandArb,
  faultCommandArb,
  fc.constant(new ApplyLate()),
  fc.constant(new ApplyLate()),
  fc.constantFrom(4, 6, 7).map(times => new SwitchThroughConflicts(times)),
  fc.constantFrom(500, 3_000, 9_000, 21_000).map(ms => new AdvanceClock(ms)),
  fc
    .constantFrom<TabSlug>(
      'approval-settings',
      'approval-settings',
      'overview',
      'model',
      'advanced'
    )
    .map(tab => new Navigate(tab)),
  fc.boolean().map(kept => new SwitchAgent(kept)),
  fc.constant(new Remount()),
  fc.constantFrom<OlderKind>('overview', 'model', 'guardrails').map(kind => new OlderSave(kind)),
  fc
    .tuple(agentArb, fc.nat(20), fc.array(fc.tuple(fc.nat(3), fc.boolean()), { maxLength: 2 }))
    .map(([agent, pick, tools]) => new LegacyPut(agent, pick, tools)),
]

const blockSeedArb: fc.Arbitrary<BlockSeed> = fc.record({
  ceiling: fc.constantFrom('manual' as const, 'auto' as const, 'allow_all' as const, null),
  policy: fc.constantFrom(
    'channel_users' as const,
    'cli_only' as const,
    'designated_approvers' as const,
    null
  ),
  tools: fc.array(fc.tuple(fc.nat(3), fc.boolean()), { maxLength: 3 }),
  approvers: fc.nat(1),
  probe: fc.constantFrom(true, false, null),
})

const setupArb: fc.Arbitrary<Setup> = fc.record({
  crd: fc.constantFrom<HostCrdApprovalVersion>('current', 'current', 'current', 'v0.12.1'),
  start: agentArb,
  blocks: fc.record({
    alpha: fc.option(blockSeedArb, { freq: 4, nil: null }),
    beta: fc.option(blockSeedArb, { freq: 2, nil: null }),
  }),
  random: fc.nat(),
})

// ── The property ────────────────────────────────────────────────────────────

// ── What each fixed example must reach (Ruling 67(5), M9) ─────────────────

function savesOf(w: World, kind: ToolsSaveOutcome['kind']): SaveRecord[] {
  return w.saves.filter(save => save.outcome?.kind === kind)
}

function writesOf(w: World, owner: Owner): FakeLogEntry[] {
  return w.fake.log.filter(entry => {
    const tag = w.owners.get(entry.seq)
    return entry.kind === 'write' && tag?.kind === owner.kind && tag.id === owner.id
  })
}

/** The deliveries of `agent`'s `/detail` loads, in the order they reached the client. */
function loadDeliveries(w: World, agent: Agent): FakeLogEntry[] {
  const path = `/api/v1/admin/hosts/${agent}/detail`
  return w.deliveries
    .map(seq => w.fake.log.find(entry => entry.seq === seq))
    .filter((entry): entry is FakeLogEntry => entry?.path === path)
}

/**
 * Each fixed example's case, checked at rest: null when the run reached it,
 * else what it missed. A scenario that stops reaching its case fails as a
 * harness error, not as a quiet pass.
 */
const PINS = {
  noticeLoadAfterWrite: (w: World) => {
    const settled = savesOf(w, 'saved')[0]?.settleLogLen
    const late =
      settled !== undefined &&
      loadDeliveries(w, 'alpha').some(
        entry => entry.seq > settled && blockOf(hostOfRead(entry)) === undefined
      )
    return late ? null : 'no load sent after the save answered with the block removed'
  },
  twoSavesOneStep: (w: World) => {
    const [a, b] = w.saves
    const ok =
      a?.settleStep !== undefined &&
      a.settleStep === b?.settleStep &&
      a.settledInView !== b.settledInView
    return ok ? null : 'no continuation and in-tab save settled in one step'
  },
  olderLoadAfterWrite: (w: World) => {
    const save = savesOf(w, 'saved')[0]
    const settled = save?.settleLogLen
    const write = save ? writesOf(w, { kind: 'save', id: save.id }).at(-1) : undefined
    // The save's last PUT must have answered: a load counts only after it.
    const writeDelivered = write ? w.deliveries.indexOf(write.seq) : -1
    const older =
      settled !== undefined &&
      writeDelivered >= 0 &&
      loadDeliveries(w, 'alpha').some(
        entry => entry.seq <= settled && w.deliveries.indexOf(entry.seq) > writeDelivered
      )
    const switches = w.switches.filter(item => item.outcome && item.outcome.kind !== 'failed')
    return older && switches.length === 2
      ? null
      : 'no load sent before the save answered after it, or not two switches'
  },
  conflictBeforeWrite: (w: World) => {
    const save = savesOf(w, 'conflict')[0]
    return save && writesOf(w, { kind: 'save', id: save.id }).length === 0
      ? null
      : 'no save stopped on its base with no PUT'
  },
  unappliedProxy504: (w: World) => {
    const save = savesOf(w, 'maybe')[0]
    const put = save ? writesOf(w, { kind: 'save', id: save.id })[0] : undefined
    return put && put.response?.status === 504 && !put.applied
      ? null
      : 'no unapplied 504 PUT ended "may not have applied"'
  },
  keptContinuation: (w: World) => {
    const save = savesOf(w, 'saved')[0]
    return save && save.agent === 'alpha' && save.settledInView === false
      ? null
      : "alpha's save did not settle away from its tab"
  },
  reconfirmAtWrite: (w: World) => {
    const reasked = w.saves.some(save => save.outcome?.kind === 'reconfirm' && !save.reported)
    const confirmed = savesOf(w, 'saved').some(save => save.press.labels?.includes('shell_exec'))
    return reasked && confirmed ? null : 'the save did not re-ask and then write shell_exec'
  },
  lateApply: (w: World) => {
    const save = savesOf(w, 'maybe')[0]
    const put = save ? writesOf(w, { kind: 'save', id: save.id })[0] : undefined
    return put?.applied && !put.delivered ? null : 'no abandoned PUT was applied later'
  },
  step4SuccessNoApply: (w: World) => {
    const save = savesOf(w, 'saved')[0]
    const puts = save ? writesOf(w, { kind: 'save', id: save.id }) : []
    const reread = save?.outcome?.kind === 'saved' && save.outcome.via === 'reread'
    return reread && puts.length > 0 && puts.every(put => put.response?.status === 409)
      ? null
      : "no save ended saved from a read with only 409'd PUTs"
  },
  outsideRaiseAfterSwitch: (w: World) => {
    const settled = w.switches.find(item => item.outcome?.kind === 'saved')?.settleStep
    const raised =
      settled !== undefined &&
      w.timeline.some(
        event =>
          event.kind === 'external' && event.step > settled && ceilingOf(event.after) !== 'manual'
      )
    return raised ? null : 'no outside raise after the switch saved Manual'
  },
  refreshFailed: (w: World) => {
    const settled = savesOf(w, 'saved')[0]?.settleLogLen
    const failed =
      settled !== undefined &&
      w.fake.log.some(
        entry =>
          entry.path === '/api/v1/admin/hosts/alpha/detail' &&
          entry.seq > settled &&
          entry.response?.status === 500
      )
    return failed ? null : 'the save did not settle with its refresh failing'
  },
  sixConflicts: (w: World) => {
    const record = w.switches[0]
    // L3 must hold this run (l3Run): six conflicts and nothing else.
    const run = record ? l3Run(w, record) : undefined
    return record?.outcome?.kind === 'saved' && run?.held && run.conflicts.length === 6
      ? null
      : 'the switch did not save Manual through six conflicts that L3 holds'
  },
  switchContinuation: (w: World) => {
    const record = w.switches[0]
    return record?.outcome && record.settledInInstance === false && record.shown
      ? null
      : 'the switch did not settle away from its tab with its toast'
  },
  olderSaveRefused: (w: World) => {
    const put = w.fake.log.find(entry => entry.kind === 'write' && w.owners.get(entry.seq) === null)
    return put?.response?.status === 409 && olderSavesBetween(w, 'alpha').includes(put)
      ? null
      : 'no older save was refused after an approval write and a load'
  },
  firstSavePolicy: (w: World) => {
    const save = savesOf(w, 'saved')[0]
    const stored = save?.outcome?.kind === 'saved' ? save.outcome.stored : undefined
    return save?.press.firstSavePolicy === 'cli_only' && policyOf(blockOf(stored)) === 'cli_only'
      ? null
      : 'no first save stored "Nobody (Desktop only)"'
  },
  continuationToasts: (w: World) => {
    const save = savesOf(w, 'maybe')[0]
    const record = w.switches.find(item => item.outcome?.kind === 'failed')
    return save?.settledInView === false && record?.settledInInstance === false && record.shown
      ? null
      : 'no save and no switch ended away from their tab with their toasts'
  },
  hungReadSkipsL3: (w: World) => {
    const record = w.switches[0]
    if (!record?.outcome) return 'the switch did not end'
    const run = l3Run(w, record)
    // A read of this run that a hang struck, and that never reached the switch.
    const hungRead = run.others.some(
      entry =>
        entry.kind === 'read' &&
        !entry.delivered &&
        w.faults.some(fault => fault.kind === 'hang' && fault.entrySeq === entry.seq)
    )
    return hungRead && run.conflicts.length > 0 && !record.clockMoved && !run.held
      ? null
      : 'the switch did not meet conflicts and a hung read, with L3 skipping it for the read'
  },
} satisfies Record<string, (w: World) => string | null>

function checkPin(w: World, pin: keyof typeof PINS | undefined): void {
  if (pin === undefined) return
  const missed = PINS[pin](w)
  if (missed !== null) flag(w, 'harness', `example ${pin} did not reach its case: ${missed}`)
}

// ── Fixed examples ──────────────────────────────────────────────────────────

/**
 * The scheduler of a fixed example: each release takes the next point the
 * script names (by label), when that point is waiting, and otherwise the
 * oldest waiting point. With no script it is first in, first out, so an
 * example runs the same way every time. A script that no longer matches the
 * requests the page sends still runs to the end on FIFO, and then fails the
 * run as a harness error (`checkScriptFollowed`): its example would no
 * longer reach the interleaving it pins.
 */
function scriptedScheduler(script: readonly string[] = []): fc.Scheduler {
  type Task = { id: number; label: string; status: 'pending' | 'resolved'; release: () => void }
  const tasks: Task[] = []
  const released: Task[] = []
  /** Scripted points released out of their turn (by FIFO before the script reached them). */
  const passedOver: string[] = []
  let cursor = 0
  const scheduler = {
    schedule<T>(task: Promise<T>, label = ''): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        tasks.push({
          id: tasks.length + 1,
          label,
          status: 'pending',
          release: () => void task.then(resolve, reject),
        })
      })
    },
    count: () => tasks.filter(task => task.status === 'pending').length,
    async waitOne(): Promise<void> {
      const waiting = tasks.filter(task => task.status === 'pending')
      if (waiting.length === 0) throw new Error('No task scheduled')
      // A scripted point FIFO already released is passed over, and reported.
      while (cursor < script.length && released.some(task => task.label === script[cursor])) {
        passedOver.push(script[cursor])
        cursor += 1
      }
      const scripted = waiting.find(task => task.label === script[cursor])
      if (scripted) cursor += 1
      const next = scripted ?? waiting[0]
      next.status = 'resolved'
      released.push(next)
      next.release()
    },
    report: () =>
      [...released, ...tasks.filter(task => task.status === 'pending')].map(task => ({
        status: task.status,
        schedulingType: 'promise' as const,
        taskId: task.id,
        label: task.label,
      })),
    /** The script's points it did not release in their turn: none when the example ran as written. */
    unfollowed: () => [...passedOver, ...script.slice(cursor)],
    toString: () => `scriptedScheduler(${JSON.stringify(script)})`,
    [fc.cloneMethod]: () => scriptedScheduler(script),
  }
  return scheduler as unknown as fc.Scheduler
}

/**
 * An example whose script no longer matches the requests the page sends would
 * pass without reaching its interleaving: that is a harness failure.
 */
function checkScriptFollowed(w: World): void {
  const unfollowed = (w.scheduler as { unfollowed?: () => string[] }).unfollowed?.() ?? []
  if (unfollowed.length > 0) {
    flag(w, 'harness', `the example's script was not followed: ${unfollowed.join(', ')}`)
  }
}

type Example = [fc.Scheduler, Setup, Array<fc.AsyncCommand<Model, World>>]

const OPEN_BLOCK: BlockSeed = {
  ceiling: 'allow_all',
  policy: null,
  tools: [],
  approvers: 0,
  probe: null,
}

/**
 * Scenarios run before the generated runs, each on a scripted (or FIFO)
 * scheduler. The first two are the regressions of two suite bugs that
 * generated runs found. The others pin interleavings that generated runs
 * reach only rarely; each property's mutant fails one of them.
 */
const EXAMPLES: Example[] = [
  // A suite bug a generated run found (seed 101, under an earlier version of
  // this file): the load a save's Host-changed notice sends is a load after the write,
  // though it is sent in the step the write settles in. Another writer then
  // removes the block before that load arrives, and the tab shows no block.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: OPEN_BLOCK, beta: null },
      random: 1,
      pin: 'noticeLoadAfterWrite',
    },
    [
      new SaveDraft([[2, 'required']], 'channel_users', true, false),
      new UntilSettled(16),
      new External('alpha', { kind: 'remove' }),
      new Step(8),
    ],
  ],
  // A suite bug a generated run found (seed 303, under an earlier version of
  // this file): a continuation and a save in its own tab settle in one step (both reads
  // time out together); the section's message is the second save's.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: null, beta: null },
      random: 2,
      pin: 'twoSavesOneStep',
    },
    [
      new ArmFault('alpha', 'read', 'hang'),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
      new Navigate('approval-settings'),
      new ArmFault('alpha', 'read', 'hang'),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
      new AdvanceClock(10_000),
    ],
  ],
  // S6 at the page level. A switch settles, and the load its notice sends
  // reads the Host before a per-tool save's PUT applies; the save settles,
  // its own notice's load fails (500), then that older load answers; a
  // second switch settles. The tools group keeps the save's values.
  [
    scriptedScheduler([
      'apply PUT alpha #5',
      'delivery PUT alpha #5',
      'arrival GET alpha/detail #7',
      'arrival GET alpha #6',
      'delivery GET alpha #6',
      'apply PUT alpha #8',
      'delivery PUT alpha #8',
      'delivery GET alpha/detail #7',
    ]),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'auto' }, beta: null },
      random: 3,
      pin: 'olderLoadAfterWrite',
    },
    [
      new Step(4),
      new SetToManual(false),
      new Step(2),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
      new Step(6),
      new ArmFault('alpha', 'load', '500'),
      new Step(2),
      new Step(2),
      new SetToManual(false),
    ],
  ],
  // S2: another writer changes `tools` after the section became dirty and
  // before its save reads the Host; the save stops (step 4), with no PUT.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: OPEN_BLOCK, beta: null },
      random: 4,
      pin: 'conflictBeforeWrite',
    },
    [
      new Step(4),
      new EditTools([[2, 'required']]),
      new External('alpha', { kind: 'tools', slot: 0, value: false }),
      new PressSave('cli_only', false),
    ],
  ],
  // S3: the PUT is answered by the proxy's 504 and not applied; the re-read
  // (step 13) does not hold the draft, so the save is not reported saved.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: OPEN_BLOCK, beta: null },
      random: 5,
      pin: 'unappliedProxy504',
    },
    [
      new Step(4),
      new ArmFault('alpha', 'put', 'unapplied-504'),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
    ],
  ],
  // S5: a kept page moves to beta while alpha's save runs; alpha's outcome
  // goes to the root toast, naming alpha, and nothing of it into beta's tab.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: OPEN_BLOCK, beta: OPEN_BLOCK },
      random: 6,
      pin: 'keptContinuation',
    },
    [
      new Step(4),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
      new SwitchAgent(true),
      new Step(12),
    ],
  ],
  // E20 and S7: while the loosening dialog is open, another writer raises the
  // ceiling, so shell_exec's Required → Default loosens at the write; the
  // save asks again (step 6) and writes only after that second dialog.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'manual', tools: [[0, true]] }, beta: null },
      random: 7,
      pin: 'reconfirmAtWrite',
    },
    [
      new Step(4),
      new SaveDraft(
        [
          [0, 'default'],
          [3, 'skip'],
        ],
        'cli_only',
        false,
        false
      ),
      new External('alpha', { kind: 'ceiling', value: 'auto' }),
      new ConfirmDialog(),
      new Step(2),
      new ConfirmDialog(),
    ],
  ],
  // E13 and E22: the PUT hangs, its 10 s timer ends it, the re-read finds the
  // draft not stored ("may not have applied"); control-api applies the PUT
  // later, and its version still matches.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: OPEN_BLOCK, beta: null },
      random: 8,
      pin: 'lateApply',
    },
    [
      new Step(4),
      new ArmFault('alpha', 'put', 'hang'),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
      new Step(2),
      new AdvanceClock(10_000),
      new Step(2),
      new ApplyLate(),
    ],
  ],
  // S3 on the success paths of §6.4 steps 4 and 13: the save's PUT meets a
  // 409, because another writer raised the ceiling and then stored the
  // draft's tools; the next read holds the draft, so the save is saved. Its
  // own PUT never applied, and the ceiling it copied is not stored. On this
  // path checkS3 holds the save to the leaves it owns, as steps 4 and 13 do;
  // a PUT of the save that applied is held to every leaf it sent.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'auto' }, beta: null },
      random: 9,
      pin: 'step4SuccessNoApply',
    },
    [
      new Step(4),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
      new Step(2),
      new External('alpha', { kind: 'ceiling', value: 'allow_all' }),
      new External('alpha', { kind: 'tools', slot: 2, value: true }),
      new Step(4),
    ],
  ],
  // E21 and S4: after the switch reports Manual, a writer outside the
  // Control UI raises the ceiling again.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'auto' }, beta: null },
      random: 10,
      pin: 'outsideRaiseAfterSwitch',
    },
    [
      new Step(4),
      new SetToManual(false),
      new UntilSettled(16),
      new External('alpha', { kind: 'ceiling', value: 'allow_all' }),
    ],
  ],
  // L1 at rest: a save settles and the load its notice sends fails (500); the
  // tools group keeps what the save stored.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: OPEN_BLOCK, beta: null },
      random: 11,
      pin: 'refreshFailed',
    },
    [
      new Step(4),
      new ArmFault('alpha', 'load', '500'),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
    ],
  ],
  // L3: six status writes in a row each land just before the switch's PUT,
  // and the switch still saves Manual inside its 20 s budget.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'auto' }, beta: null },
      random: 12,
      pin: 'sixConflicts',
    },
    [new Step(4), new SwitchThroughConflicts(6)],
  ],
  // L4: the page moves to Overview while the switch runs; its outcome goes to
  // the root toast, naming the agent.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'auto' }, beta: null },
      random: 13,
      pin: 'switchContinuation',
    },
    [new Step(4), new SetToManual(false), new Navigate('overview'), new Step(10)],
  ],
  // E16 and S8: an Overview save sends its read; another writer lowers the
  // ceiling; the Approvals tab mounts and its load lands; then the save's
  // read answers, and its PUT, which carries the form's older version, is
  // refused (409).
  [
    scriptedScheduler([
      'arrival GET alpha #5',
      'arrival GET alpha/detail #6',
      'delivery GET alpha/detail #6',
      'delivery GET alpha #5',
    ]),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'auto' }, beta: null },
      random: 14,
      pin: 'olderSaveRefused',
    },
    [
      new OlderSave('overview'),
      new External('alpha', { kind: 'ceiling', value: 'manual' }),
      new Navigate('approval-settings'),
      new Step(10),
    ],
  ],
  // S3 on a first save: the admin chooses "Nobody (Desktop only)" in the
  // first-save dialog; the save stores that policy with the draft.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: null, beta: null },
      random: 15,
      pin: 'firstSavePolicy',
    },
    [new Step(4), new SaveDraft([[2, 'required']], 'cli_only', true, false)],
  ],
  // Continuations' root toasts (Ruling 67(2)): a save whose PUT hangs is left
  // for Overview and ends "may not have applied"; then a switch whose read
  // gets control-api's 403 is left the same way and fails. Each toast names
  // the agent, with its outcome's words and tone.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: OPEN_BLOCK, beta: null },
      random: 16,
      pin: 'continuationToasts',
    },
    [
      new Step(4),
      new ArmFault('alpha', 'put', 'hang'),
      new SaveDraft([[2, 'required']], 'cli_only', true, false),
      new Step(2),
      new Navigate('overview'),
      new AdvanceClock(10_000),
      new Step(4),
      new Navigate('approval-settings'),
      new ArmFault('alpha', 'read', '403'),
      new SetToManual(false),
      new Navigate('overview'),
      new Step(4),
    ],
  ],
  // L3 (Ruling 68, the review's probe): two of the switch's reads hang and
  // time out on its 8 s read timer while it meets conflicts, and its budget
  // runs out. The time went to the hung reads, not to conflicts, so L3 does
  // not hold the run. Example 12's jitter seed, as in the probe.
  [
    scriptedScheduler(),
    {
      crd: 'current',
      start: 'alpha',
      blocks: { alpha: { ...OPEN_BLOCK, ceiling: 'auto' }, beta: null },
      random: 12,
      pin: 'hungReadSkipsL3',
    },
    [
      new Step(4),
      new ArmFault('alpha', 'read', 'hang'),
      new SwitchThroughConflicts(6),
      new ArmFault('alpha', 'read', 'hang'),
    ],
  ],
]

const SEED = Number(process.env.APPROVAL_MODEL_SEED ?? Date.now() % 2_147_483_647)

describe('approval settings — property suite (spec §7 A4, A6)', () => {
  beforeEach(() => resetApprovalTestState())
  afterEach(() => {
    tracking.save = null
    tracking.manual = null
    resetApprovalTestState()
    vi.unstubAllGlobals()
  })
  afterAll(() => {
    const sorted = [...totals.ms].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    console.info(
      `approval property suite: seed=${SEED} runs=${totals.runs} median=${median}ms ` +
        `max=${sorted.at(-1) ?? 0}ms total=${sorted.reduce((sum, ms) => sum + ms, 0)}ms\n` +
        `events ${JSON.stringify(totals.stats.events)}\nchecks ${JSON.stringify(totals.stats.checks)}`
    )
  })

  it(
    'keeps S1–S8 and L1–L5 for generated interleavings of E1–E23',
    async () => {
      console.info(`approval property suite: seed=${SEED} numRuns=${NUM_RUNS}`)
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          setupArb,
          fc.commands(commandArbs, {
            maxCommands: MAX_COMMANDS,
            size: 'max',
            // With APPROVAL_MODEL_PATH, replays a shrunk failure's commands.
            ...(process.env.APPROVAL_MODEL_REPLAY
              ? { replayPath: process.env.APPROVAL_MODEL_REPLAY }
              : {}),
          }),
          async (scheduler, setup, commands) => {
            const started = Date.now()
            const world = await startWorld(scheduler, setup)
            try {
              await fc.asyncModelRun(() => ({ model: {}, real: world }), commands)
              await drain(world)
              checkScriptFollowed(world)
              checkPin(world, setup.pin)
              checkAtRest(world)
              totals.runs += 1
              totals.ms.push(Date.now() - started)
              addStats(totals.stats, world.stats)
            } finally {
              await stopWorld(world)
            }
          }
        ),
        {
          // fast-check counts the examples, which run first, in numRuns.
          numRuns: NUM_RUNS + EXAMPLES.length,
          seed: SEED,
          examples: EXAMPLES,
          // For mutant runs: report the first counterexample without shrinking it.
          endOnFailure: process.env.APPROVAL_MODEL_NO_SHRINK === '1',
          // Replays one run of a reported failure (its seed and path).
          ...(process.env.APPROVAL_MODEL_PATH ? { path: process.env.APPROVAL_MODEL_PATH } : {}),
        }
      )
      expect(totals.runs).toBeGreaterThan(0)
    },
    (NUM_RUNS + EXAMPLES.length) * TIMEOUT_MS_PER_RUN
  )
})
