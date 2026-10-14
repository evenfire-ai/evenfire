import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFixture } from '../../scripts/bench-chat-open/fixtures.mjs'
import { ChatStore } from '../../src/chatStore'
import { isPathInside } from '../../src/devIsolation'
import { assertSafeFilesystemSegment } from '../../src/pathSafety'
import { type ChatAuthorityScope } from '../../src/types'
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
  openExactAgentChat,
  validateMainEntry,
} from './qa-recorder-helpers'

// E2E_GUARDIAN_IPC_FLOW: server reads are preconditions through Desktop IPC;
// the measured journey clicks real rows and observes the visible transcript.
// Inputs: CHAT_OPEN_AB_BEFORE_MAIN, CHAT_OPEN_AB_AFTER_MAIN, CHAT_OPEN_AB_KUBE_CONTEXT,
// CHAT_OPEN_AB_OUTPUT_JSON. Run only with playwright.chat-open-ab.config.ts.
type Build = 'before' | 'after'
type Chat = { id: string; count: number; lastText: string }
type Catalog = { host: string; size: number; eligible: number; K: number; chats: Chat[] }
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
}
const HOSTS = ['chatllm', 'chatllm-stateless'] as const
const MESSAGES = '[data-testid="user-message"], [data-testid="agent-response"]'
const LIMIT_WINDOW_MS = 65_000
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
async function openChat(page: Page, host: string, label: string, chat: Chat): Promise<number> {
  await page
    .getByRole('navigation', { name: 'Chat breadcrumb', exact: true })
    .getByRole('button', { name: 'Chat', exact: true })
    .click()
  await openExactAgentChat(page, host, label)
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
  return page.evaluate(
    ({ selector, chat, messages }) =>
      new Promise<number>((resolve, reject) => {
        const button = document.querySelector<HTMLButtonElement>(`${selector} button`)
        if (!button || button.disabled)
          throw new Error(`Chat row has no enabled open button: ${selector}`)
        let started: number
        // The sidebar previews only the latest sessions, so the active-row witness is checked outside the timing.
        const finish = () => {
          const transcripts = document.querySelectorAll('[data-testid="message-list"]')
          if (transcripts.length > 1) {
            observer.disconnect()
            clearTimeout(deadline)
            reject(new Error(`Expected one transcript, found ${transcripts.length}.`))
            return
          }
          const transcript = transcripts[0]
          const bubbles = transcript?.querySelectorAll(messages)
          if (
            bubbles?.length === chat.count &&
            bubbles[chat.count - 1]?.textContent?.includes(chat.lastText) &&
            transcript &&
            transcript.getBoundingClientRect().height > 0
          ) {
            observer.disconnect()
            clearTimeout(deadline)
            resolve(performance.now() - started)
          }
        }
        const observer = new MutationObserver(finish)
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
        started = performance.now()
        button.click()
        finish()
      }),
    {
      selector: agentRow(host, chat.id),
      chat,
      messages: MESSAGES,
    }
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
        }>
      >((resolve, reject) => {
        const navigation = performance.getEntriesByType('navigation')[0] as
          | PerformanceNavigationTiming
          | undefined
        if (!navigation) throw new Error('Window navigation timing is unavailable.')
        const installed = performance.now()
        const observed = new Map<string, { at: number; initial: boolean }>()
        let initial = true
        const visible = (element: Element) =>
          element.getBoundingClientRect().height > 0 &&
          getComputedStyle(element).visibility !== 'hidden'
        const finish = () => {
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
            if (ready && !observed.has(target.metric))
              observed.set(target.metric, { at: performance.now(), initial })
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
                }
              })
            )
          }
          initial = false
        }
        const observer = new MutationObserver(finish)
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
    const output = required('CHAT_OPEN_AB_OUTPUT_JSON')
    if (!path.isAbsolute(output) || path.extname(output) !== '.json')
      throw new Error('CHAT_OPEN_AB_OUTPUT_JSON must be an absolute JSON path.')
    const builds = Object.fromEntries(
      Object.entries(entries).map(([build, entry]) => [
        build,
        {
          entry,
          sha: execFileSync(
            'git',
            ['-C', path.resolve(path.dirname(entry), '../..'), 'rev-parse', 'HEAD'],
            { encoding: 'utf8' }
          ).trim(),
        },
      ])
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
    let launches = 0
    let launchedBuild: Build | undefined
    const launch = async (build: Build) => {
      await close()
      // A closed build's background requests can exhaust control-api's per-minute
      // limits; the next build's session restore then fails. Start each launch in
      // a fresh window, outside every timed section.
      const quiet = closedAt + LIMIT_WINDOW_MS - Date.now()
      if (quiet > 0) await new Promise(resolve => setTimeout(resolve, quiet))
      const launched = await launchDesktopApp(testInfo, 'issue-1091-ab', entries[build])
      app = launched.app
      page = launched.page
      launchedBuild = build
      // Keep each main process's output so a lost session can be explained after the run.
      const log = fs.createWriteStream(testInfo.outputPath(`main-${++launches}-${build}.log`), {
        mode: 0o600,
      })
      app.process().stdout?.pipe(log)
      app.process().stderr?.pipe(log)
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
    const round = async (scenario: string, build: Build, action: (id: number) => Promise<void>) => {
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
      let observationFailure: { error: unknown } | undefined
      const observation = (async () => {
        while (!stopped) {
          record.snapshots.push(await snapshot())
          if (!stopped) await new Promise(resolve => setTimeout(resolve, 250))
        }
      })().catch(error => {
        observationFailure = { error }
      })
      try {
        await action(record.id)
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
              catalogs.push({ host, size: items.length, eligible: eligible.length, K, chats })
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
      for (const build of ['before', 'after', 'after', 'before'] as const) {
        await ready()
        await test.step(`O: ${build} cached chat opens`, () =>
          round('O', build, async id => {
            await launch(build)
            await authenticated()
            await page.getByTestId('nav-chat').click()
            for (const catalog of report.catalogs) {
              const checked = new Set<string>()
              for (let pass = 1; pass <= (id === 1 ? 3 : 2); pass++) {
                const remote = id === 1 && pass === 1
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
                for (const chat of catalog.chats) {
                  const ms = await openChat(page, catalog.host, hostLabels[catalog.host]!, chat)
                  samples.push({
                    round: id,
                    build,
                    host: catalog.host,
                    metric: remote ? 'open_remote_ms' : 'open_cached_ms',
                    pass,
                    chatId: chat.id,
                    ms,
                  })
                  if (!checked.has(chat.id)) {
                    await expect
                      .poll(() =>
                        page.evaluate(host => window.clerum.chat.getLastActive(host), catalog.host)
                      )
                      .toBe(chat.id)
                    await expect(page.getByTestId('message-list').locator(MESSAGES)).toHaveCount(
                      chat.count
                    )
                    // The sidebar previews only the latest sessions: when this chat has a row it is the active one, otherwise none is.
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
      // L times the selected chat's sidebar row, so it must be a measured chat inside the preview.
      await expect(page!.locator(rows(HOSTS[0])).first()).toBeVisible()
      const previewIds = await page!
        .locator(rows(HOSTS[0]))
        .evaluateAll(elements => elements.map(element => element.getAttribute('data-chat-id')))
      const selected = report.catalogs[0]!.chats.find(chat => previewIds.includes(chat.id))
      if (!selected)
        throw new Error(
          `precondition: L needs a measured ${HOSTS[0]} chat inside the sidebar preview.`
        )
      await openChat(page!, HOSTS[0], hostLabels[HOSTS[0]]!, selected)
      await expect
        .poll(() => page!.evaluate(host => window.clerum.chat.getLastActive(host), HOSTS[0]))
        .toBe(selected.id)
      // L and W time sidebar rows, which exist only for sessions inside the sidebar preview.
      await expect(
        page!.locator(row(HOSTS[0], selected.id)),
        `precondition: L needs ${HOSTS[0]}/${selected.id} inside the sidebar preview.`
      ).toBeVisible()
      for (const host of HOSTS)
        await expect(
          page!.locator(rows(host)).first(),
          `precondition: W needs a ${host} session inside the sidebar preview.`
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
      for (const build of ['before', 'after'] as const)
        for (let iteration = 0; iteration < 3; iteration++) {
          await ready()
          await close()
          fs.rmSync(isolatedPath(runDir, cacheDir!), { recursive: true })
          fs.cpSync(savedCache, isolatedPath(runDir, cacheDir!), { recursive: true })
          await test.step(`L: ${build} large-cache relaunch ${iteration + 1}`, () =>
            round('L', build, async id => {
              await launch(build)
              const [paint] = await Promise.all([
                relaunchPaint(page, [
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
                  await page.getByTestId('nav-chat').click()
                  await openChat(page, HOSTS[0], hostLabels[HOSTS[0]]!, selected)
                })(),
              ])
              for (const sample of paint) samples.push({ round: id, build, ...sample })
              await authenticated()
            }))
        }
      for (const build of ['before', 'after'] as const)
        for (let iteration = 0; iteration < 3; iteration++) {
          await close()
          await waitForStatelessSuspended(240_000, context, HOSTS[1], HOSTS[1])
          // Empty only the isolated chat cache: both observed rows must come from the remote catalog.
          if (fs.existsSync(cacheDir!))
            fs.rmSync(isolatedPath(runDir, cacheDir!), { recursive: true })
          await test.step(`W: ${build} suspended-stateless relaunch ${iteration + 1}`, () =>
            round('W', build, async id => {
              await launch(build)
              for (const sample of await relaunchPaint(
                page,
                HOSTS.map((host, index) => ({
                  host,
                  selector: rows(host),
                  metric: index === 0 ? 'first_stateful_row_ms' : 'stateless_rows_ms',
                }))
              ))
                samples.push({ round: id, build, ...sample })
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
      }
      const before = quantiles(values('before', HOSTS[0], 'relaunch_ms')).p50,
        after = quantiles(values('after', HOSTS[0], 'relaunch_ms')).p50
      report.gates.push({ metric: 'relaunch_ms', before, after, passed: after < before })
      const wakeAfter = Math.max(...values('after', HOSTS[0], 'first_stateful_row_ms'))
      report.gates.push({
        metric: 'first_stateful_row_ms',
        after_max_ms: wakeAfter,
        budget_ms: 2000,
        passed: wakeAfter < 2000,
      })
      report.gates.push({
        metric: 'round_validity',
        invalidated: rounds.filter(round => round.invalidated).length,
        passed: rounds.every(round => !round.invalidated),
      })
      // Rounds compared within a scenario must run under comparable 1-minute load.
      for (const scenario of ['O', 'L', 'W']) {
        const loads = rounds
          .filter(round => round.scenario === scenario)
          .map(round => round.loadavg[0]!)
        const spread = Math.max(...loads) - Math.min(...loads)
        report.gates.push({
          metric: 'loadavg_spread',
          scenario,
          spread,
          budget: 1,
          passed: loads.length > 0 && spread <= 1,
        })
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
    expect(
      report.gates.every(gate => gate.passed),
      `Desktop A/B gates: ${JSON.stringify(report.gates)}; evidence: ${output}`
    ).toBe(true)
  })
}
