import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatStore } from '../../src/chatStore'
import { isPathInside } from '../../src/devIsolation'
import { assertSafeFilesystemSegment } from '../../src/pathSafety'
import { type ChatAuthorityScope } from '../../src/types'
import { SIDEBAR_SESSION_PREVIEW_LIMIT as SIDEBAR_PREVIEW } from '../../ui/src/constants/navigation'
import { assertAllowedKubeContext } from './global-setup'
import { createFixture } from './helpers/chatCacheFixture.mjs'
import {
  type HostSnapshot,
  readHostSnapshot,
  waitForStatelessReady,
  waitForStatelessSuspended,
} from './helpers/hostSnapshot'
import {
  EXTERNAL_REST_API_BASE_URL,
  MAIN_ENTRY,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  launchDesktopApp,
  login,
  validateMainEntry,
} from './qa-recorder-helpers'

// E2E_GUARDIAN_IPC_FLOW: server reads are preconditions through Desktop IPC;
// the measured journey clicks real rows and observes the visible transcript.
// Inputs: CHAT_OPEN_AB_BEFORE_MAIN, CHAT_OPEN_AB_AFTER_MAIN, CHAT_OPEN_AB_KUBE_CONTEXT,
// CHAT_OPEN_AB_OUTPUT_JSON, CHAT_OPEN_AB_PHASE. Run only with playwright.chat-open-ab.config.ts.
// Phase OL (cached opens, large-cache relaunch) needs the stateless Host to stay up for the
// whole phase; phase W needs it to suspend within minutes. They run as two invocations so the
// HCC idle cadence can differ between them.
// O measures each chat's first open after launch (open_cached_ms, read from disk) apart from
// its reopen in the same session (open_memo_ms), which the AFTER build serves from memory.
type Build = 'before' | 'after'
type Chat = { id: string; count: number; lastText: string }
type Catalog = {
  host: string
  size: number
  eligible: number
  K: number
  chats: Chat[]
  latestActivity: string[]
}
type Sample = {
  round: number
  build: Build
  host: string
  metric: string
  ms: number
  pass?: number
  chatId?: string
  observed_at_install?: boolean
  observer_installed_ms?: number
  /** The "Loading conversation" skeleton was visible between the click and the measurement. */
  blank?: boolean
  /** What the observer saw just before the click and on its first callbacks after it. */
  trace?: OpenObservation[]
  /** Relaunch metrics: observed before the test's first pointer event in the window. */
  before_first_click?: boolean
}
/** Runs a measured window; the Host snapshot loop of the round is paused while it runs. */
type Timed = <T>(work: () => Promise<T>) => Promise<T>
const untimed: Timed = work => work()
type OpenObservation = {
  ms: number
  lists: number
  bubbles: number
  skeleton: boolean
  dedicated: boolean
}
const HOSTS = ['chatllm', 'chatllm-stateless'] as const
// The Desktop remembers the last 8 transcripts it showed (`transcriptMemo`); reopens stay within it.
const REMEMBERED_CHATS = 8
const MESSAGES = '[data-testid="user-message"], [data-testid="agent-response"]'
// Rendered by ChatThread while an active chat has no messages and is loading (both builds).
const LOADING_SKELETON = '[aria-label="Loading conversation"]'
const TRACE_LIMIT = 8
const LIMIT_WINDOW_MS = 65_000
const RATE_LIMITED = /\b429\b|Too Many Requests/g
// Relaunch rounds per build in L and W.
const RELAUNCH_ROUNDS = 3
// A live Desktop from an earlier A/B run would hold the Keychain item this run needs.
const AB_PROCESS = /Evenfire Issue1091Ab/
const rows = (host: string) =>
  `[data-testid="latest-session-row"][data-agent-ref=${JSON.stringify(host)}]`
const row = (host: string, id: string) => `${rows(host)}[data-chat-id=${JSON.stringify(id)}]`
const agentRow = (host: string, id: string) =>
  `[data-testid="agent-chat-row"][data-agent-ref=${JSON.stringify(host)}][data-chat-id=${JSON.stringify(id)}]`
const quantiles = (values: number[]) => {
  if (!values.length || values.some(value => !Number.isFinite(value)))
    throw new Error('Missing or invalid timing samples.')
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    n: sorted.length,
  }
}
function required(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) throw new Error(`${name} is required for the Desktop A/B benchmark.`)
  return value
}
function isolatedPath(runDir: string, target: string): string {
  if (!isPathInside(runDir, target))
    throw new Error(`Cache target must be inside the isolated run directory: ${target}`)
  let ancestor = target
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target))
  if (!isPathInside(fs.realpathSync(runDir), resolved))
    throw new Error(`Cache target escapes isolation through a symlink: ${target}`)
  return target
}
// Each open sends about 8 REST requests, several of them counted by control-api's 120/min
// per-session limit; spacing opens keeps a launch under that limit. The wait is outside the timing.
const OPEN_PACE_MS = 4_000
let lastOpenAt = 0
async function openChat(
  page: Page,
  host: string,
  label: string,
  chat: Chat,
  timed: Timed
): Promise<{ ms: number; blank: boolean; trace: OpenObservation[] }> {
  // A deadline, not a fixed sleep: wait only for what is left of the pace since the last open.
  const pace = lastOpenAt + OPEN_PACE_MS - Date.now()
  if (pace > 0) await new Promise(resolve => setTimeout(resolve, pace))
  lastOpenAt = Date.now()
  await page
    .getByRole('navigation', { name: 'Chat breadcrumb', exact: true })
    .getByRole('button', { name: 'Chat', exact: true })
    .click()
  // Switch Hosts from the Chat page: the Agents page refreshes the access catalog and the
  // team directory on every visit, which exhausts the per-minute API limits at this pace.
  const switchAgent = page.getByRole('button', { name: /^Switch chat agent$/ })
  await expect(switchAgent).toBeVisible()
  if (!(await switchAgent.getByText(label, { exact: true }).isVisible())) {
    await switchAgent.click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  await expect(switchAgent).toContainText(label)
  await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible()
  const more = page.getByRole('button', { name: 'Show more', exact: true })
  const loadMore = page.getByRole('button', { name: 'Load more', exact: true })
  const target = page.locator(agentRow(host, chat.id))
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true
        if (await more.isVisible()) await more.click()
        else if ((await loadMore.isVisible()) && (await loadMore.isEnabled()))
          await loadMore.click()
        return target.isVisible()
      },
      {
        timeout: 30_000,
        message: `The selected Host must expose server chat ${chat.id} through its session list.`,
      }
    )
    .toBe(true)
  return timed(() =>
    page.evaluate(
      ({ selector, chat, messages, skeleton, traceLimit }) =>
        new Promise<{ ms: number; blank: boolean; trace: OpenObservation[] }>((resolve, reject) => {
          const button = document.querySelector<HTMLButtonElement>(`${selector} button`)
          if (!button || button.disabled)
            throw new Error(`Chat row has no enabled open button: ${selector}`)
          let blank = false
          const trace: OpenObservation[] = []
          // Before the click the Chat breadcrumb shows the Host's chat list with no active chat, which
          // already has zero bubbles; only the loading skeleton marks a chat that was opened empty.
          const observe = (ms: number) => {
            const transcripts = document.querySelectorAll('[data-testid="message-list"]')
            const observation = {
              ms,
              lists: transcripts.length,
              bubbles: transcripts[0]?.querySelectorAll(messages).length ?? 0,
              skeleton: document.querySelector(skeleton) !== null,
              dedicated: transcripts[0]?.classList.contains('chat-thread-dedicated') ?? false,
            }
            if (trace.length < traceLimit) trace.push(observation)
            return observation
          }
          observe(-1)
          // The sidebar previews only the latest sessions, so the active-row witness is checked outside the timing.
          let scheduled = false
          const finish = () => {
            scheduled = false
            const transcripts = document.querySelectorAll('[data-testid="message-list"]')
            if (transcripts.length > 1) {
              observer.disconnect()
              clearTimeout(deadline)
              reject(new Error(`Expected one transcript, found ${transcripts.length}.`))
              return
            }
            const transcript = transcripts[0]
            const bubbles = transcript?.querySelectorAll(messages)
            if (observe(performance.now() - started).skeleton) blank = true
            if (
              bubbles?.length === chat.count &&
              bubbles[chat.count - 1]?.textContent?.includes(chat.lastText) &&
              transcript &&
              transcript.getBoundingClientRect().height > 0
            ) {
              observer.disconnect()
              clearTimeout(deadline)
              resolve({ ms: performance.now() - started, blank, trace })
            }
          }
          // One check per animation frame: a mutation only schedules it, so layout is read once
          // per frame instead of once per mutation. Callbacks run after the click below sets `started`.
          const observer = new MutationObserver(() => {
            if (scheduled) return
            scheduled = true
            requestAnimationFrame(finish)
          })
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          })
          const deadline = setTimeout(() => {
            observer.disconnect()
            reject(new Error(`Transcript did not match server chat ${chat.id}`))
          }, 120_000)
          const started = performance.now()
          button.click()
          finish()
        }),
      {
        selector: agentRow(host, chat.id),
        chat,
        messages: MESSAGES,
        skeleton: LOADING_SKELETON,
        traceLimit: TRACE_LIMIT,
      }
    )
  )
}
async function relaunchPaint(
  page: Page,
  targets: Array<{ host: string; metric: string; selector: string; chat?: Chat }>
) {
  return page.evaluate(
    ({ targets, messages }) =>
      new Promise<
        Array<{
          host: string
          metric: string
          ms: number
          observed_at_install: boolean
          observer_installed_ms: number
          before_first_click: boolean
        }>
      >((resolve, reject) => {
        const navigation = performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined
        if (!navigation) throw new Error('Window navigation timing is unavailable.')
        const installed = performance.now()
        const observed = new Map<string, { at: number; initial: boolean; beforeClick: boolean }>()
        let initial = true
        // Witness for metrics that must be observed before the test clicks anything.
        let clicked = false
        document.addEventListener(
          'pointerdown',
          () => {
            clicked = true
          },
          { capture: true, once: true }
        )
        let scheduled = false
        const visible = (element: Element) =>
          element.getBoundingClientRect().height > 0 &&
          getComputedStyle(element).visibility !== 'hidden'
        const finish = () => {
          scheduled = false
          const transcripts = document.querySelectorAll('[data-testid="message-list"]')
          if (transcripts.length > 1) {
            observer.disconnect()
            clearTimeout(deadline)
            reject(new Error(`Expected one transcript, found ${transcripts.length}.`))
            return
          }
          const transcript = transcripts[0]
          for (const target of targets) {
            const ready =
              Array.from(document.querySelectorAll(target.selector)).some(visible) &&
              (!target.chat ||
                (transcript &&
                  visible(transcript) &&
                  transcript.querySelectorAll(messages).length === target.chat.count &&
                  transcript
                    .querySelectorAll(messages)
                    [target.chat.count - 1]?.textContent?.includes(target.chat.lastText)))
            if (ready && !observed.has(target.metric)) {
              observed.set(target.metric, {
                at: performance.now(),
                initial,
                beforeClick: !clicked,
              })
              // The test's clicks wait on this, so the witness is not decided by frame timing.
              ;(window as { __abRelaunchObserved?: string[] }).__abRelaunchObserved = [
                ...observed.keys(),
              ]
            }
          }
          if (observed.size === targets.length && navigation.loadEventEnd > 0) {
            observer.disconnect()
            clearTimeout(deadline)
            resolve(
              targets.map(target => {
                const result = observed.get(target.metric)!
                return {
                  host: target.host,
                  metric: target.metric,
                  ms: Math.max(0, result.at - navigation.loadEventEnd),
                  observed_at_install: result.initial,
                  observer_installed_ms: installed - navigation.loadEventEnd,
                  before_first_click: result.beforeClick,
                }
              })
            )
          }
          initial = false
        }
        // One check per animation frame, as in openChat.
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          requestAnimationFrame(finish)
        })
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        })
        const deadline = setTimeout(() => {
          observer.disconnect()
          reject(new Error('Relaunch did not expose the required rows/transcript.'))
        }, 120_000)
        window.addEventListener('load', () => requestAnimationFrame(finish), { once: true })
        finish()
      }),
    { targets, messages: MESSAGES }
  )
}

if (
  process.env.DESKTOP_CHAT_OPEN_AB_CONFIG ===
  path.join(__dirname, 'playwright.chat-open-ab.config.ts')
) {
  test('compare two Desktop builds: cached chat open, large-cache relaunch and stateless wake', async ({}, testInfo) => {
    if (process.env.EVENFIRE_RENDERER_URL?.trim())
      throw new Error(
        "Unset EVENFIRE_RENDERER_URL: the A/B run must use each build's bundled renderer."
      )
    const entries = {
      before: required('CHAT_OPEN_AB_BEFORE_MAIN'),
      after: required('CHAT_OPEN_AB_AFTER_MAIN'),
    }
    for (const entry of Object.values(entries)) validateMainEntry(entry)
    if (
      path.resolve(entries.after) !== MAIN_ENTRY ||
      path.dirname(entries.before) === path.dirname(entries.after)
    )
      throw new Error(
        'AFTER must be this worktree build; BEFORE must be a different worktree build.'
      )
    const context = required('CHAT_OPEN_AB_KUBE_CONTEXT')
    if (context !== context.trim() || context.startsWith('-'))
      throw new Error('CHAT_OPEN_AB_KUBE_CONTEXT must be the literal Kubernetes context.')
    // The shared global setup is disabled for this config; apply its context guard before any kubectl call.
    assertAllowedKubeContext(context, 'CHAT_OPEN_AB_KUBE_CONTEXT')
    const output = required('CHAT_OPEN_AB_OUTPUT_JSON')
    if (!path.isAbsolute(output) || path.extname(output) !== '.json')
      throw new Error('CHAT_OPEN_AB_OUTPUT_JSON must be an absolute JSON path.')
    const phase = required('CHAT_OPEN_AB_PHASE')
    if (phase !== 'OL' && phase !== 'W') throw new Error('CHAT_OPEN_AB_PHASE must be OL or W.')
    const builds = Object.fromEntries(
      Object.entries(entries).map(([build, entry]) => {
        const git = (...args: string[]) =>
          execFileSync('git', ['-C', path.resolve(path.dirname(entry), '../..'), ...args], {
            encoding: 'utf8',
          }).trim()
        // A build must be exactly its commit: a clean tree, and dist/main.js built after the commit.
        const dirty = git('status', '--porcelain')
        if (dirty) throw new Error(`precondition: the ${build} worktree has uncommitted changes.`)
        const committedAt = Number(git('log', '-1', '--format=%ct')) * 1000
        const builtAt = fs.statSync(entry).mtimeMs
        if (!(builtAt > committedAt))
          throw new Error(`precondition: the ${build} build is older than its HEAD commit.`)
        return [build, { entry, sha: git('rev-parse', 'HEAD'), committedAt, builtAt }]
      })
    )
    const samples: Sample[] = []
    const rounds: Array<{
      id: number
      scenario: string
      build: Build
      loadavg: number[]
      cache: { before: unknown; after?: unknown }
      snapshots: HostSnapshot[]
      invalidated: boolean
    }> = []
    const report = {
      phase,
      builds,
      node: process.version,
      machine: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        model: os.cpus()[0]!.model,
      },
      startedAt: new Date().toISOString(),
      catalogs: [] as Catalog[],
      fixtureRoot: '',
      rounds,
      samples,
      cells: {} as Record<string, ReturnType<typeof quantiles>>,
      gates: [] as Array<Record<string, string | number | boolean>>,
      // Reported, not gated: another branch profile shares the machine (plan addendum A9.2).
      loadSpread: [] as Array<Record<string, string | number | boolean>>,
      // L rounds that found the stateless Host suspended and woke it first.
      statelessWakes: [] as Array<{ build: Build; iteration: number; at: string }>,
      complete: false,
    }
    let app: ElectronApplication | undefined
    let page: Page
    // The agent switcher shows display names; the app falls back to the ref when none is set.
    let hostLabels: Record<string, string> = {}
    const runDir = testInfo.outputPath('electron-isolation')
    let closedAt = 0
    const close = async () => {
      if (app) {
        await app.close()
        app = undefined
        closedAt = Date.now()
      }
    }
    // One app identity per run, so Electron creates its own `<appName> Safe Storage` Keychain item
    // instead of reading one an earlier run left behind. BEFORE and AFTER share it and the user data.
    const isolationTarget = `issue-1091-ab-${Date.now().toString(36)}`
    const electronPath = fs.realpathSync(require('electron') as unknown as string)
    let launches = 0
    let mainLog = ''
    // The current launch's main-process output, kept in memory so a round reads all of it.
    let mainOutput: string[] = []
    let launchedBuild: Build | undefined
    // A first window that never opens is usually a Keychain prompt nobody answers. Record what the
    // process was doing and whether macOS shows a prompt; never answer or bypass it.
    const diagnoseFirstWindow = (starting: ElectronApplication): string => {
      const samplePath = testInfo.outputPath(`sample-${launches}.txt`)
      // A failed sample is reported in the diagnosis; it must not replace the timeout.
      let sampleNote = `sample in ${samplePath}`
      try {
        execFileSync('sample', [String(starting.process().pid), '5', '-file', samplePath])
      } catch (error) {
        sampleNote = `sample failed (${String((error as Error)?.message ?? error)})`
      }
      const agent = spawnSync('pgrep', ['-x', 'SecurityAgent'])
      if (agent.status !== 0 && agent.status !== 1)
        throw new Error(`pgrep SecurityAgent failed with status ${agent.status}.`)
      return agent.status === 0
        ? `KEYCHAIN_PROMPT_PENDING: SecurityAgent is running; ${sampleNote}`
        : `FIRST_WINDOW_TIMEOUT: no SecurityAgent process; ${sampleNote}`
    }
    // A closed build's background requests can exhaust control-api's per-minute
    // limits; the next build's session restore then fails. Start each launch in
    // a fresh window, outside every timed section.
    const awaitQuietWindow = async () => {
      await close()
      const quiet = closedAt + LIMIT_WINDOW_MS - Date.now()
      if (quiet > 0) await new Promise(resolve => setTimeout(resolve, quiet))
    }
    const launch = async (build: Build) => {
      await awaitQuietWindow()
      const live = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
        .split('\n')
        .filter(line => AB_PROCESS.test(line))
        .map(line => line.trim().split(/\s+/)[0])
      if (live.length)
        throw new Error(`precondition: an A/B Desktop is still running (pids ${live.join(', ')}).`)
      // Keep each main process's output so a lost session can be explained after the run.
      mainLog = testInfo.outputPath(`main-${++launches}-${build}.log`)
      const log = fs.createWriteStream(mainLog, { mode: 0o600 })
      const output: string[] = []
      mainOutput = output
      let starting: ElectronApplication | undefined
      try {
        const launched = await launchDesktopApp(testInfo, isolationTarget, entries[build], {
          executablePath: electronPath,
          beforeFirstWindow: started => {
            starting = started
            for (const stream of [started.process().stdout, started.process().stderr])
              stream?.on('data', (chunk: Buffer) => {
                output.push(chunk.toString('utf8'))
                log.write(chunk)
              })
          },
        })
        app = launched.app
        page = launched.page
      } catch (error) {
        // The starting process is closed even when the diagnosis itself throws.
        try {
          if (starting && /firstWindow: Timeout/.test(String((error as Error)?.message)))
            throw new Error(diagnoseFirstWindow(starting), { cause: error })
          throw error
        } finally {
          await starting?.close()
        }
      }
      launchedBuild = build
      // Public process identities only: the pinned Electron, this build's code and the run's profile.
      const runtime = await app.evaluate(({ app: electronApp }) => ({
        executablePath: process.execPath,
        appPath: electronApp.getAppPath(),
        userData: electronApp.getPath('userData'),
      }))
      expect(fs.realpathSync(runtime.executablePath)).toBe(electronPath)
      expect(fs.realpathSync(runtime.appPath)).toBe(fs.realpathSync(path.dirname(entries[build])))
      expect(fs.realpathSync(runtime.userData)).toBe(
        fs.realpathSync(path.join(runDir, 'user-data'))
      )
    }
    const authenticated = async () => {
      try {
        await expect(page.getByTestId('nav-chat')).toBeVisible()
        await expect(page.locator('#email-input')).toBeHidden()
      } catch (error) {
        const userData = path.join(runDir, 'user-data')
        const tokenName = fs
          .readdirSync(userData)
          .find(name => /^session-token-.*\.enc$/.test(name))
        const diagnosis = {
          build: launchedBuild,
          launch: launches,
          token: tokenName
            ? {
                bytes: fs.statSync(path.join(userData, tokenName)).size,
                mtime: fs.statSync(path.join(userData, tokenName)).mtime.toISOString(),
                decrypt: await app!.evaluate(
                  async ({ safeStorage }, file) => {
                    try {
                      const fsp = process.mainModule!.require('node:fs/promises')
                      return `ok length=${safeStorage.decryptString(await fsp.readFile(file)).length}`
                    } catch (failure) {
                      return `error: ${String((failure as Error)?.message).slice(0, 160)}`
                    }
                  },
                  path.join(userData, tokenName)
                ),
              }
            : 'absent',
          session: await page
            .evaluate(async () => {
              const state = await window.clerum.auth.getSessionState()
              return { authenticated: Boolean(state.authenticated), hasMe: Boolean(state.me) }
            })
            .catch(failure => `error: ${String((failure as Error)?.message).slice(0, 160)}`),
        }
        fs.writeFileSync(
          testInfo.outputPath(`session-diagnosis-${launches}.json`),
          JSON.stringify(diagnosis, null, 2),
          { mode: 0o600 }
        )
        throw error
      }
    }
    const snapshot = () => readHostSnapshot(HOSTS[1], HOSTS[1], context)
    const ready = () => waitForStatelessReady(270_000, context, HOSTS[1], HOSTS[1])
    // Between L rounds no Desktop is open, so the idle timer can suspend the stateless Host and
    // `ready()` alone would wait for a wake nobody requests. Wake it the way phase W does: a
    // Desktop launch requests its catalog, and rpc-proxy holds that request until the Host is Ready.
    const wakeStateless = async (build: Build, iteration: number) => {
      if ((await snapshot()).readyReplicas === 0) {
        report.statelessWakes.push({ build, iteration, at: new Date().toISOString() })
        await launch(build)
        await authenticated()
      }
      await ready()
    }
    let cacheDir: string
    const cacheState = () => {
      if (!fs.existsSync(cacheDir)) return { agents: 0, chats: 0, pending: 0 }
      const indexes = fs
        .readdirSync(cacheDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry =>
          JSON.parse(fs.readFileSync(path.join(cacheDir, entry.name, 'index.json'), 'utf8'))
        )
      return {
        agents: indexes.length,
        chats: indexes.reduce((sum, index) => sum + index.chats.length, 0),
        pending: indexes.reduce(
          (sum, index) => sum + (index.pendingChatCleanup ? index.pendingChatCleanup.length : 0),
          0
        ),
      }
    }
    // `timed` wraps every measured window; the Host snapshots (each a few kubectl processes)
    // run only between those windows, so they never compete with a measurement.
    const round = async (
      scenario: string,
      build: Build,
      action: (id: number, timed: Timed) => Promise<void>
    ) => {
      const record: (typeof rounds)[number] = {
        id: rounds.length + 1,
        scenario,
        build,
        loadavg: os.loadavg(),
        cache: { before: cacheState() },
        snapshots: [await snapshot()],
        invalidated: false,
      }
      rounds.push(record)
      let stopped = false
      let paused = false
      let sampling: Promise<void> = Promise.resolve()
      let observationFailure: { error: unknown } | undefined
      const observation = (async () => {
        while (!stopped) {
          if (!paused) {
            sampling = snapshot().then(state => {
              record.snapshots.push(state)
            })
            await sampling
          }
          if (!stopped) await new Promise(resolve => setTimeout(resolve, 250))
        }
      })().catch(error => {
        observationFailure = { error }
      })
      const timed: Timed = async work => {
        paused = true
        try {
          // A snapshot already running finishes before the measured window opens.
          await sampling
          return await work()
        } finally {
          paused = false
        }
      }
      try {
        await action(record.id, timed)
        // A rate-limited round runs on stale or empty catalogs, so its timings are not valid samples.
        const limited = mainOutput.join('').match(RATE_LIMITED)?.length ?? 0
        if (limited)
          throw new Error(
            `Round ${record.id} (${scenario} ${build}) logged ${limited} rate-limited responses in ${path.basename(mainLog)}.`
          )
      } finally {
        stopped = true
        await observation
        record.snapshots.push(await snapshot())
        record.cache.after = cacheState()
        record.invalidated =
          scenario !== 'W' &&
          record.snapshots.some(
            (state, index, all) =>
              index > 0 &&
              state.readyReplicas > 0 &&
              (all[index - 1]!.readyReplicas === 0 ||
                state.podNames.join(',') !== all[0]!.podNames.join(','))
          )
        if (observationFailure) throw observationFailure.error
      }
    }
    try {
      await test.step('precondition: one isolated login and existing server chats with at least two turns', async () => {
        await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
        await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)
        // Every run starts without a session or chat cache, so no step can pass on an earlier run's history.
        if (fs.existsSync(runDir))
          throw new Error(`precondition: ${runDir} must not exist before the first launch.`)
        await launch('before')
        await login(page!, desktopCredentials())
        await ready()
        expect(
          (await readHostSnapshot(HOSTS[0], HOSTS[0], context)).readyReplicas,
          'The stateful control Host must be Ready.'
        ).toBeGreaterThan(0)
        const scope = await page!.evaluate(async (): Promise<ChatAuthorityScope> => {
          const state = await window.clerum.auth.getSessionState()
          const config = await window.clerum.auth.getRuntimeConfigState()
          if (!state.authenticated || !state.me || !config.envKey)
            throw new Error('Logged-in authority scope is unavailable.')
          return { environmentKey: config.envKey, userId: state.me.id, teamId: state.me.teamId }
        })
        assertSafeFilesystemSegment('environmentKey', scope.environmentKey)
        assertSafeFilesystemSegment('userId', scope.userId)
        cacheDir = isolatedPath(
          runDir,
          path.join(runDir, 'chats', scope.environmentKey, scope.userId)
        )
        hostLabels = await page!.evaluate(
          async hosts => {
            const catalog = await window.clerum.access.refreshCatalog()
            return Object.fromEntries(
              hosts.map(host => [host, catalog.agentDisplayByName?.[host] ?? host])
            )
          },
          [...HOSTS]
        )
        report.catalogs = await page!.evaluate(
          async hosts => {
            const catalogs: Catalog[] = []
            for (const host of hosts) {
              const items: Awaited<ReturnType<typeof window.clerum.rpc.listSessions>>['items'] = []
              let cursor: string | undefined
              do {
                const result = await window.clerum.rpc.listSessions(host, undefined, {
                  limit: 100,
                  cursor,
                })
                items.push(...result.items)
                cursor = result.nextCursor
              } while (cursor)
              const eligible = items.filter(item => item.turnCount >= 2)
              const K = Math.min(10, eligible.length)
              if (K < 5)
                throw new Error(
                  `precondition: ${host} has ${K} eligible chats; at least 5 are required, without seeding.`
                )
              const chats: Chat[] = []
              for (const session of eligible.slice(0, K)) {
                const result = await window.clerum.rpc.loadSessionMessages(
                  host,
                  session.agent,
                  session.chatId,
                  undefined,
                  { limit: session.turnCount }
                )
                const last = result.turns[result.turns.length - 1]
                if (
                  result.turns.length !== session.turnCount ||
                  !last?.response ||
                  result.turns.some(turn => !turn.user_input || !turn.response)
                )
                  throw new Error(
                    `precondition: ${host}/${session.chatId} must expose all completed turns.`
                  )
                const count = result.turns.length * 2
                if (session.messageCount !== undefined && session.messageCount !== count)
                  throw new Error(
                    `precondition: ${host}/${session.chatId} message count disagrees with completed turns.`
                  )
                chats.push({ id: session.chatId, count, lastText: last.response })
              }
              catalogs.push({
                host,
                size: items.length,
                eligible: eligible.length,
                K,
                chats,
                latestActivity: items.map(item => item.lastActivityAt),
              })
            }
            return catalogs
          },
          [...HOSTS]
        )
        // The transcript stop condition identifies a chat by its last text, so that text must be unique.
        const lastTexts = report.catalogs.flatMap(catalog =>
          catalog.chats.map(chat => chat.lastText)
        )
        if (new Set(lastTexts).size !== lastTexts.length)
          throw new Error('precondition: every measured chat must end with a unique last text.')
        if (phase === 'W') {
          // W empties the cache, so its sidebar preview is the server's latest sessions across Hosts.
          const previewHosts = new Set(
            report.catalogs
              .flatMap(catalog => catalog.latestActivity.map(at => ({ at, host: catalog.host })))
              .sort((a, b) => b.at.localeCompare(a.at))
              .slice(0, SIDEBAR_PREVIEW)
              .map(entry => entry.host)
          )
          for (const host of HOSTS)
            if (!previewHosts.has(host))
              throw new Error(
                `precondition: W needs a ${host} session among the server's ${SIDEBAR_PREVIEW} latest sessions.`
              )
          return
        }
        // The benchmark builder owns valid paged metadata; rebind its synthetic tombstones to the real session below.
        const fixtureDir = isolatedPath(runDir, path.join(runDir, 'fixture'))
        fs.mkdirSync(fixtureDir, { mode: 0o700 })
        const fixture = await createFixture({
          runDir: fixtureDir,
          ChatStore,
          adapter: {
            bind(Store: typeof ChatStore, root: string) {
              const store = new Store(root)
              store.setAuthorityScope(scope)
              return store
            },
          },
          agents: 25,
          chatsPerAgent: 200,
          pendingCleanupsPerAgent: 10,
        })
        for (const agent of fixture.agentNames) {
          const indexPath = isolatedPath(runDir, path.join(fixture.root, agent, 'index.json'))
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
          for (const key of ['deletedChatTombstones', 'pendingChatCleanup'])
            for (const tombstone of index[key]) tombstone.authorityScope = scope
          fs.writeFileSync(indexPath, JSON.stringify(index), { mode: 0o600 })
        }
        report.fixtureRoot = fixture.root
      })
      if (phase === 'OL') {
        for (const build of ['before', 'after', 'after', 'before'] as const) {
          await ready()
          await test.step(`O: ${build} cached chat opens`, () =>
            round('O', build, async (id, timed) => {
              await launch(build)
              await authenticated()
              await page.getByTestId('nav-chat').click()
              // Stateless first: the sidebar preview orders cached chats by their first load, and L needs stateful rows in it.
              for (const catalog of [...report.catalogs].reverse()) {
                const checked = new Set<string>()
                // Round 1 is always BEFORE, so its first cached pass cannot be served from memory.
                const firstCachedPass = id === 1 ? 2 : 1
                // Reopens stay inside the remembered window: the last chats opened, newest first,
                // with the last chat opened at the end.
                const remembered = catalog.chats.slice(
                  -Math.min(catalog.chats.length, REMEMBERED_CHATS)
                )
                if (remembered.length < 2)
                  throw new Error(`precondition: ${catalog.host} needs two chats to reopen.`)
                const reopenOrder = [
                  ...remembered.slice(0, -1).reverse(),
                  remembered[remembered.length - 1]!,
                ]
                for (let pass = 1; pass <= firstCachedPass + 1; pass++) {
                  const remote = id === 1 && pass === 1
                  const reopen = pass > firstCachedPass
                  if (!remote)
                    await test.step(`precondition: ${catalog.host} transcripts are cached`, async () => {
                      await expect
                        .poll(
                          () =>
                            page.evaluate(
                              async ({ host, chats }) => {
                                const messages = await Promise.all(
                                  chats.map(chat => window.clerum.chat.loadMessages(host, chat.id))
                                )
                                return messages.every(
                                  (items, index) =>
                                    items.length === chats[index]!.count &&
                                    items[items.length - 1]?.content === chats[index]!.lastText
                                )
                              },
                              { host: catalog.host, chats: catalog.chats }
                            ),
                          { timeout: 30_000 }
                        )
                        .toBe(true)
                    })
                  for (const chat of reopen ? reopenOrder : catalog.chats) {
                    const { ms, blank, trace } = await openChat(
                      page,
                      catalog.host,
                      hostLabels[catalog.host]!,
                      chat,
                      timed
                    )
                    samples.push({
                      round: id,
                      build,
                      host: catalog.host,
                      metric: remote
                        ? 'open_remote_ms'
                        : reopen
                          ? 'open_memo_ms'
                          : 'open_cached_ms',
                      pass,
                      chatId: chat.id,
                      ms,
                      blank,
                      trace,
                    })
                    if (!checked.has(chat.id)) {
                      await expect
                        .poll(() =>
                          page.evaluate(
                            host => window.clerum.chat.getLastActive(host),
                            catalog.host
                          )
                        )
                        .toBe(chat.id)
                      await expect(page.getByTestId('message-list').locator(MESSAGES)).toHaveCount(
                        chat.count
                      )
                      // The sidebar previews only the latest sessions: when this chat has a row it is the active one, otherwise none is.
                      // An empty preview would satisfy "none is active" without checking anything.
                      await expect(
                        page.locator('[data-testid="latest-session-row"]')
                      ).not.toHaveCount(0)
                      const inSidebar = (await page.locator(row(catalog.host, chat.id)).count()) > 0
                      await expect(
                        page.locator('[data-testid="latest-session-row"][aria-current="true"]')
                      ).toHaveCount(inSidebar ? 1 : 0)
                      if (inSidebar)
                        await expect(page.locator(row(catalog.host, chat.id))).toHaveAttribute(
                          'aria-current',
                          'true'
                        )
                      checked.add(chat.id)
                    }
                  }
                }
              }
            }))
        }
        // A cached chat's updatedAt is set by its first remote load in round 1, so L times the
        // most recently loaded stateful chat, which the reversed host order puts in the preview.
        const statefulIndex = JSON.parse(
          fs.readFileSync(
            isolatedPath(runDir, path.join(cacheDir!, HOSTS[0], 'index.json')),
            'utf8'
          )
        ) as { chats: Array<{ id: string; updatedAt: string }> }
        const updatedAt = new Map(statefulIndex.chats.map(chat => [chat.id, chat.updatedAt]))
        const selected = report.catalogs[0]!.chats.reduce((latest, chat) => {
          const at = updatedAt.get(chat.id)
          if (!at)
            throw new Error(`precondition: ${HOSTS[0]}/${chat.id} is missing from the cache.`)
          return at > updatedAt.get(latest.id)! ? chat : latest
        })
        await openChat(page!, HOSTS[0], hostLabels[HOSTS[0]]!, selected, untimed)
        await expect
          .poll(() => page!.evaluate(host => window.clerum.chat.getLastActive(host), HOSTS[0]))
          .toBe(selected.id)
        // L times a sidebar row, which exists only for sessions inside the sidebar preview.
        await expect(
          page!.locator(row(HOSTS[0], selected.id)),
          `precondition: L needs ${HOSTS[0]}/${selected.id} inside the sidebar preview.`
        ).toBeVisible()
        await close()
        const savedCache = isolatedPath(runDir, path.join(runDir, 'cache-snapshot'))
        fs.cpSync(isolatedPath(runDir, cacheDir!), savedCache, { recursive: true })
        const fixtureRoot = report.fixtureRoot
        for (const agent of fs.readdirSync(fixtureRoot))
          fs.cpSync(
            isolatedPath(runDir, path.join(fixtureRoot, agent)),
            isolatedPath(runDir, path.join(savedCache, agent)),
            { recursive: true }
          )
        // L: the large cache is in place and the app relaunches. Desktop does not reopen the last
        // active chat on launch, so the user opens it: relaunch_rows_ms ends at the first stateful
        // sidebar row (before any click), relaunch_ms at the transcript of the explicit open.
        for (const build of ['before', 'after'] as const)
          for (let iteration = 0; iteration < RELAUNCH_ROUNDS; iteration++) {
            // The wake launch runs before the cache restore below, so it cannot change what L reads.
            await wakeStateless(build, iteration)
            await close()
            fs.rmSync(isolatedPath(runDir, cacheDir!), { recursive: true })
            fs.cpSync(savedCache, isolatedPath(runDir, cacheDir!), { recursive: true })
            await test.step(`L: ${build} large-cache relaunch ${iteration + 1}`, () =>
              round('L', build, async (id, timed) => {
                await awaitQuietWindow()
                const paint = await timed(async () => {
                  await launch(build)
                  const [observed] = await Promise.all([
                    relaunchPaint(page, [
                      { host: HOSTS[0], metric: 'relaunch_rows_ms', selector: rows(HOSTS[0]) },
                      {
                        host: HOSTS[0],
                        metric: 'relaunch_ms',
                        selector: row(HOSTS[0], selected.id),
                        chat: selected,
                      },
                    ]),
                    (async () => {
                      await authenticated()
                      await expect(page.locator(row(HOSTS[0], selected.id))).toBeVisible()
                      // Click only after the in-page observer has recorded the rows; otherwise a
                      // late animation frame records them after this click.
                      await page.waitForFunction(() =>
                        (
                          window as { __abRelaunchObserved?: string[] }
                        ).__abRelaunchObserved?.includes('relaunch_rows_ms')
                      )
                      await page.getByTestId('nav-chat').click()
                      await openChat(page, HOSTS[0], hostLabels[HOSTS[0]]!, selected, untimed)
                    })(),
                  ])
                  return observed
                })
                for (const sample of paint) samples.push({ round: id, build, ...sample })
                await authenticated()
              }))
          }
      }
      if (phase === 'W')
        for (const build of ['before', 'after'] as const)
          for (let iteration = 0; iteration < RELAUNCH_ROUNDS; iteration++) {
            await close()
            await waitForStatelessSuspended(240_000, context, HOSTS[1], HOSTS[1])
            // Empty only the isolated chat cache: both observed rows must come from the remote catalog.
            if (fs.existsSync(cacheDir!))
              fs.rmSync(isolatedPath(runDir, cacheDir!), { recursive: true })
            await test.step(`W: ${build} suspended-stateless relaunch ${iteration + 1}`, () =>
              round('W', build, async (id, timed) => {
                await awaitQuietWindow()
                const paint = await timed(async () => {
                  await launch(build)
                  return relaunchPaint(
                    page,
                    HOSTS.map((host, index) => ({
                      host,
                      selector: rows(host),
                      metric: index === 0 ? 'first_stateful_row_ms' : 'stateless_rows_ms',
                    }))
                  )
                })
                for (const sample of paint) samples.push({ round: id, build, ...sample })
                await authenticated()
                await ready()
              }))
          }
      const values = (build: Build, host: string, metric: string, roundId?: number) =>
        samples
          .filter(
            sample =>
              sample.build === build &&
              sample.host === host &&
              sample.metric === metric &&
              (roundId === undefined || sample.round === roundId)
          )
          .map(sample => sample.ms)
      for (const sample of samples)
        report.cells[`${sample.build}/${sample.host}/${sample.metric}`] = quantiles(
          values(sample.build, sample.host, sample.metric)
        )
      if (phase === 'OL') {
        for (const host of HOSTS) {
          const before = quantiles(values('before', host, 'open_cached_ms')).p50,
            after = quantiles(values('after', host, 'open_cached_ms')).p50
          const spread = Math.abs(
            quantiles(values('before', host, 'open_cached_ms', 1)).p50 -
              quantiles(values('before', host, 'open_cached_ms', 4)).p50
          )
          const budget = Math.max(spread, before * 0.1)
          report.gates.push({
            metric: 'open_cached_ms',
            host,
            before,
            after,
            aa_spread_ms: spread,
            budget_ms: budget,
            passed: after <= before + budget,
          })
          const memoBefore = quantiles(values('before', host, 'open_memo_ms')).p50,
            memoAfter = quantiles(values('after', host, 'open_memo_ms')).p50
          report.gates.push({
            metric: 'open_memo_ms',
            host,
            before: memoBefore,
            after: memoAfter,
            passed: memoAfter < memoBefore,
          })
          // AFTER reopens never show the loading skeleton. The witnesses prove the observer does see
          // it where it happens: on AFTER first opens (disk path) and on BEFORE reopens.
          const blanks = (build: Build, metric: string) =>
            samples.filter(
              sample =>
                sample.build === build &&
                sample.host === host &&
                sample.metric === metric &&
                sample.blank
            ).length
          const witness = {
            after_reopen_blank: blanks('after', 'open_memo_ms'),
            after_first_open_blank: blanks('after', 'open_cached_ms'),
            before_reopen_blank: blanks('before', 'open_memo_ms'),
          }
          report.gates.push({
            metric: 'reopen_blank_witness',
            host,
            ...witness,
            passed:
              values('after', host, 'open_memo_ms').length > 0 &&
              witness.after_reopen_blank === 0 &&
              witness.after_first_open_blank > 0 &&
              witness.before_reopen_blank === values('before', host, 'open_memo_ms').length,
          })
        }
        // Every relaunch round of both builds contributes one sample per L metric.
        const relaunchSamples = (build: Build, metric: string) => {
          const found = values(build, HOSTS[0], metric)
          if (found.length !== RELAUNCH_ROUNDS)
            throw new Error(`L recorded ${found.length} ${build} ${metric} samples.`)
          return found
        }
        // The L claim is that chat:getIndex no longer waits for the 10 pending cleanups, so AFTER
        // must keep most of that gain, not merely be faster. On 48fcd0b30 the p50 ratio was 0.05
        // (rows) and 0.10 (transcript); with the inline cleanup await restored in AFTER it was
        // 0.93 and 0.90. A ratio of at most 0.5 separates the two by a wide margin.
        const RELAUNCH_MAX_RATIO = 0.5
        // relaunch_rows_ms: window load to the first stateful sidebar row, observed before the
        // test clicks anything; the non-blocking chat:getIndex is what shortens it.
        const rowsUnclicked = samples
          .filter(sample => sample.metric === 'relaunch_rows_ms')
          .every(sample => sample.before_first_click === true)
        const rowsBefore = quantiles(relaunchSamples('before', 'relaunch_rows_ms')).p50,
          rowsAfter = quantiles(relaunchSamples('after', 'relaunch_rows_ms')).p50
        report.gates.push({
          metric: 'relaunch_rows_ms',
          definition: 'window load -> first stateful sidebar row, before any click',
          before: rowsBefore,
          after: rowsAfter,
          observed_before_click: rowsUnclicked,
          max_ratio: RELAUNCH_MAX_RATIO,
          passed: rowsUnclicked && rowsAfter <= RELAUNCH_MAX_RATIO * rowsBefore,
        })
        // relaunch_ms: window load to the transcript of the selected chat, including the explicit
        // open. Desktop never restores the last active chat on launch.
        const before = quantiles(relaunchSamples('before', 'relaunch_ms')).p50,
          after = quantiles(relaunchSamples('after', 'relaunch_ms')).p50
        report.gates.push({
          metric: 'relaunch_ms',
          definition: 'window load -> sidebar row -> explicit open -> transcript with all messages',
          before,
          after,
          max_ratio: RELAUNCH_MAX_RATIO,
          passed: after <= RELAUNCH_MAX_RATIO * before,
        })
      } else {
        // W needs a control: BEFORE runs the same suspended-Host relaunches as AFTER.
        const wake = (build: Build) => {
          const found = values(build, HOSTS[0], 'first_stateful_row_ms')
          if (found.length !== RELAUNCH_ROUNDS)
            throw new Error(`W recorded ${found.length} ${build} first_stateful_row_ms samples.`)
          return found
        }
        const wakeBefore = wake('before'),
          wakeAfter = wake('after')
        const afterMax = Math.max(...wakeAfter)
        report.gates.push({
          metric: 'first_stateful_row_ms',
          after_max_ms: afterMax,
          budget_ms: 2000,
          passed: afterMax < 2000,
        })
        const beforeP50 = quantiles(wakeBefore).p50,
          afterP50 = quantiles(wakeAfter).p50
        report.gates.push({
          metric: 'first_stateful_row_ms_vs_before',
          before: beforeP50,
          after: afterP50,
          passed: afterP50 < beforeP50,
        })
      }
      report.gates.push({
        metric: 'round_validity',
        invalidated: rounds.filter(round => round.invalidated).length,
        passed: rounds.every(round => !round.invalidated),
      })
      // 1-minute load spread across the rounds of each scenario.
      for (const scenario of phase === 'OL' ? ['O', 'L'] : ['W']) {
        const loads = rounds
          .filter(round => round.scenario === scenario)
          .map(round => round.loadavg[0]!)
        if (loads.length === 0) throw new Error(`Scenario ${scenario} recorded no rounds.`)
        const spread = Math.max(...loads) - Math.min(...loads)
        report.loadSpread.push({ scenario, spread, budget: 1, within_budget: spread <= 1 })
      }
      report.complete = true
    } finally {
      try {
        await close()
      } finally {
        // Chat text stays in memory; evidence contains only catalog sizes, identities and raw timings.
        const catalogs = report.catalogs.map(({ chats, ...catalog }) => ({
          ...catalog,
          chats: chats.map(({ id, count }) => ({ id, count })),
        }))
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, JSON.stringify({ ...report, catalogs }, null, 2), { mode: 0o600 })
      }
    }
    // O: three gates per Host; L: two; W: two; both phases: round validity.
    expect(report.gates.length, 'Desktop A/B gate count').toBe(
      phase === 'OL' ? HOSTS.length * 3 + 3 : 3
    )
    expect(
      report.gates.every(gate => gate.passed),
      `Desktop A/B gates: ${JSON.stringify(report.gates)}; evidence: ${output}`
    ).toBe(true)
  })
}
