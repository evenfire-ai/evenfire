// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useAppController } from '@hooks/useAppController'
import { desktopQueryDefaults } from '@lib/queryClient'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  accessibleResource,
  affordancesFailureMessage,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilesPage } from '../FilesPage'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/evenfire-renderer-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FOLDER_URI = 'gfs://main/r82-old-team-folder'
const NEXT_FOLDER_URI = 'gfs://main/r82-new-team-folder'

type Controller = ReturnType<typeof useAppController>

type Model = {
  sessionScope: 'team-1' | 'team-2'
  sessionGeneration: number
  bindingActive: boolean
  bindingScope: 'team-1' | 'team-2'
  bindingQueries: number
  cachedPermissionErrors: { 'team-1': number; 'team-2': number }
  filesMounted: boolean
  seedState: 'not-started' | 'pending' | 'success' | 'failure'
  visiblePermissionCue: boolean
  g1FailureSettled: boolean
  g1FailureQueued: boolean
  g1FailurePhase: 'before-route-exit' | 'queued-while-files-absent-before-remount' | null
  settlementOrder: string[]
  quiescenceObserved: boolean
  executedTransitions: string[]
}

type Real = {
  client: QueryClient
  controller: () => Controller
  switchCalled: () => boolean
  setRouteMounted: (mounted: boolean) => Promise<void>
  switchTeam: () => Promise<void>
  settleG1Failure: () => Promise<void>
  queueG1Failure: () => void
  settleG2Seed: (outcome: 'success' | 'failure') => Promise<string[]>
  assertModel: (model: Readonly<Model>) => Promise<void>
  queryKey: ReturnType<typeof desktopQueryKeys.gfsAffordances>
}

class MountFiles implements AsyncCommand<Model, Real, true> {
  async check(model: Readonly<Model>): Promise<boolean> {
    return !model.filesMounted && model.sessionScope === 'team-1' && model.bindingQueries === 0
  }
  async run(model: Model, real: Real): Promise<void> {
    await real.setRouteMounted(true)
    model.executedTransitions.push('mount-files')
    model.filesMounted = true
    model.bindingActive = true
    model.bindingScope = model.sessionScope
    model.bindingQueries += 1
    await waitFor(() =>
      expect(real.client.getQueryState(real.queryKey)?.fetchStatus).toBe('fetching')
    )
    await real.assertModel(model)
  }
  toString(): string {
    return 'mount the production Files route through useAppController navigation'
  }
}

class SettleG1Failure implements AsyncCommand<Model, Real, true> {
  constructor(private readonly expectVisible: boolean) {}

  async check(model: Readonly<Model>): Promise<boolean> {
    return model.filesMounted && !model.g1FailureSettled && model.sessionScope === 'team-1'
  }
  async run(model: Model, real: Real): Promise<void> {
    await real.settleG1Failure()
    model.executedTransitions.push('settle-g1-while-files-mounted')
    model.g1FailureSettled = true
    model.cachedPermissionErrors['team-1'] = 1
    model.visiblePermissionCue = this.expectVisible
    model.g1FailurePhase = 'before-route-exit'
    expect(Boolean(screen.queryByRole('alertdialog'))).toBe(this.expectVisible)
    await real.assertModel(model)
  }
  toString(): string {
    return 'settle the real G1 permission producer and observe its dialog'
  }
}

class UnmountFiles implements AsyncCommand<Model, Real, true> {
  async check(model: Readonly<Model>): Promise<boolean> {
    return model.filesMounted && model.sessionScope === 'team-1' && model.bindingQueries > 0
  }
  async run(model: Model, real: Real): Promise<void> {
    await real.setRouteMounted(false)
    model.executedTransitions.push('unmount-files')
    model.filesMounted = false
    model.bindingActive = false
    model.visiblePermissionCue = false
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await real.assertModel(model)
  }
  toString(): string {
    return 'leave Files through the production Chat route and retire its active binding'
  }
}

class SettleG1FailureWhileFilesAbsent implements AsyncCommand<Model, Real, true> {
  async check(model: Readonly<Model>): Promise<boolean> {
    return (
      !model.filesMounted &&
      model.sessionScope === 'team-2' &&
      model.bindingQueries > 0 &&
      !model.g1FailureSettled &&
      !model.g1FailureQueued
    )
  }
  async run(model: Model, real: Real): Promise<void> {
    real.queueG1Failure()
    model.executedTransitions.push('queue-g1-while-files-absent')
    model.g1FailureQueued = true
    model.visiblePermissionCue = false
    model.g1FailurePhase = 'queued-while-files-absent-before-remount'
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await real.assertModel(model)
  }
  toString(): string {
    return 'queue the uncancelled G1 permission rejection while Files is absent in G2'
  }
}

class SwitchTeamWhileFilesAbsent implements AsyncCommand<Model, Real, true> {
  async check(model: Readonly<Model>): Promise<boolean> {
    return !model.filesMounted && model.sessionScope === 'team-1' && model.bindingQueries > 0
  }
  async run(model: Model, real: Real): Promise<void> {
    await real.switchTeam()
    model.executedTransitions.push('switch-session-while-files-absent')
    model.sessionScope = 'team-2'
    model.sessionGeneration = 1
    expect(real.switchCalled()).toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await real.assertModel(model)
  }
  toString(): string {
    return 'publish the real same-principal team switch while Files and sidebar are absent'
  }
}

class RemountFilesWithHeldSeed implements AsyncCommand<Model, Real, true> {
  async check(model: Readonly<Model>): Promise<boolean> {
    return (
      !model.filesMounted &&
      model.sessionScope === 'team-2' &&
      (model.g1FailureSettled || model.g1FailureQueued) &&
      model.seedState === 'not-started'
    )
  }
  async run(model: Model, real: Real): Promise<void> {
    await real.setRouteMounted(true)
    model.executedTransitions.push('remount-files-with-g2-seed-pending')
    model.filesMounted = true
    model.bindingActive = false
    model.bindingScope = 'team-2'
    model.seedState = 'pending'
    model.visiblePermissionCue = false
    expect(['pending', 'error']).toContain(real.client.getQueryState(real.queryKey)?.status)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await real.assertModel(model)
  }
  toString(): string {
    return 'remount production Files for G2 while the location producer is held'
  }
}

class SettleG2Seed implements AsyncCommand<Model, Real, true> {
  constructor(private readonly outcome: 'success' | 'failure') {}
  async check(model: Readonly<Model>): Promise<boolean> {
    return model.filesMounted && model.sessionScope === 'team-2' && model.seedState === 'pending'
  }
  async run(model: Model, real: Real): Promise<void> {
    model.settlementOrder = await real.settleG2Seed(this.outcome)
    model.executedTransitions.push(`settle-g2-seed-${this.outcome}`)
    model.seedState = this.outcome
    model.bindingActive = this.outcome === 'success'
    model.visiblePermissionCue = false
    if (model.g1FailureQueued) {
      model.g1FailureQueued = false
      model.g1FailureSettled = true
      model.cachedPermissionErrors['team-1'] = 1
    }
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
    ).toBeNull()
    await real.assertModel(model)
  }
  toString(): string {
    return `settle the held G2 Files seed with ${this.outcome}`
  }
}

class ObserveQuiescentCue implements AsyncCommand<Model, Real, true> {
  async check(model: Readonly<Model>): Promise<boolean> {
    return (
      model.filesMounted &&
      model.sessionScope === 'team-2' &&
      model.seedState !== 'pending' &&
      model.seedState !== 'not-started' &&
      !model.quiescenceObserved
    )
  }
  async run(model: Model, real: Real, recordCommand = true): Promise<void> {
    if (recordCommand) model.executedTransitions.push('observe-quiescence')
    await waitFor(() =>
      expect(
        real.client
          .getQueryCache()
          .getAll()
          .every(query => query.state.fetchStatus === 'idle')
      ).toBe(true)
    )
    model.visiblePermissionCue = false
    model.quiescenceObserved = true
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
    ).toBeNull()
  }
  toString(): string {
    return 'assert the independent model and visible permission cue after Query/React quiescence'
  }
}

describe('R82 real app session lifecycle A6', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('generates reachable navigation, team-switch, and producer settlement histories', async () => {
    const seedOutcomes = fc.sample(fc.constantFrom<'success' | 'failure'>('success', 'failure'), {
      numRuns: 24,
      seed: 142715,
    })
    const observedOutcomes = new Set<'success' | 'failure'>()
    const observedFailurePhases = new Set<NonNullable<Model['g1FailurePhase']>>()
    const observedSettlementOrders = new Set<string>()
    for (const [sample, seedOutcome] of seedOutcomes.entries()) {
      const { handle } = installAppControllerClerum()
      let currentSessionGeneration = 1
      let releaseG1!: (result: Promise<never>) => void
      let releaseG2!: (result: Promise<Awaited<ReturnType<typeof resolveResource>>>) => void
      const g1Pending = new Promise<never>(resolve => {
        releaseG1 = resolve
      })
      const g2Pending = new Promise<Awaited<ReturnType<typeof resolveResource>>>(resolve => {
        releaseG2 = resolve
      })
      const oldFolder = await resolveResource(
        resolvedDirectory('r82-old-parent', 'Reports', {
          gfsUri: FOLDER_URI,
          parentResourceId: 'r82-source-parent',
        })
      )
      const nextFolder = await resolveResource(
        resolvedDirectory('r82-new-parent', 'Projects', { gfsUri: NEXT_FOLDER_URI })
      )
      const failureMessage = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'r82-source-parent'
      )
      const bridge = window.clerum as unknown as {
        auth: Record<string, unknown>
        gfs?: Record<string, unknown>
      }
      bridge.auth.getSessionGeneration = vi.fn(async () => currentSessionGeneration)
      bridge.gfs = {
        listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
        resolve: vi.fn(async (uri: string) => {
          if (uri === FOLDER_URI) return oldFolder
          if (uri === NEXT_FOLDER_URI) return g2Pending
          return resolveResource(
            resolvedDirectory('r82-source-parent', 'Shared', {
              gfsUri: 'gfs://main/r82-source-parent',
            })
          )
        }),
        listChildren: vi.fn(async () => listChildrenPage([])),
        affordances: vi.fn(async (resourceId: string) => {
          if (resourceId === 'r82-source-parent') return g1Pending
          return heldPermissionResponse(['read', 'write', 'delete'])
        }),
      }

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      let controller: Controller | undefined
      const RoutedFiles = () => {
        const state = useAppController()
        controller = state
        const tab = activeWorkspaceTab(state.workspaceTabs)
        const auth = {
          isAuthenticated: state.isAuthenticated,
          sessionGeneration: state.sessionGeneration,
          me: state.me,
          runtimeConfigState: state.runtimeConfigState,
        } as AuthContextValue
        return (
          <AuthContext.Provider value={auth}>
            {state.navItem === DESKTOP_ROUTES.files && tab?.kind === 'files' ? (
              <FilesPage key={tab.id} pendingGfsUri={tab.files?.path ?? null} />
            ) : null}
          </AuthContext.Provider>
        )
      }
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
        </QueryClientProvider>
      )
      const view = render(<RoutedFiles />, { wrapper })
      const queryKey = desktopQueryKeys.gfsAffordances(
        'harness-environment:user-1:team-1',
        'r82-source-parent',
        'main',
        1
      )
      const model: Model = {
        sessionScope: 'team-1',
        sessionGeneration: 1,
        bindingActive: false,
        bindingScope: 'team-1',
        bindingQueries: 0,
        cachedPermissionErrors: { 'team-1': 0, 'team-2': 0 },
        filesMounted: false,
        seedState: 'not-started',
        visiblePermissionCue: false,
        g1FailureSettled: false,
        g1FailureQueued: false,
        g1FailurePhase: null,
        settlementOrder: [],
        quiescenceObserved: false,
        executedTransitions: [],
      }
      let scheduler!: Scheduler
      const real: Real = {
        client,
        controller: () => {
          if (!controller) throw new Error('Expected mounted production app controller')
          return controller
        },
        switchCalled: () => handle.switchTeam.mock.calls.some(([team]) => team === 'team-2'),
        queryKey,
        setRouteMounted: async mounted => {
          const state = real.controller()
          await act(async () => {
            if (mounted) {
              state.openFilesSection(model.sessionScope === 'team-1' ? FOLDER_URI : NEXT_FOLDER_URI)
            } else state.handleNavSelect(DESKTOP_ROUTES.chat)
          })
        },
        switchTeam: async () => {
          await act(async () => {
            await real.controller().handleEnsureTeamContext({ teamId: 'team-2' })
          })
          currentSessionGeneration = 1
          await waitFor(() => expect(real.controller().currentTeamId).toBe('team-2'))
        },
        settleG1Failure: async () => {
          releaseG1(
            scheduler.schedule(
              Promise.reject(new Error(failureMessage)),
              'G1 permission Query rejection'
            )
          )
          await act(async () => scheduler.waitIdle())
          await waitFor(() => expect(client.getQueryState(queryKey)?.status).toBe('error'))
        },
        queueG1Failure: () => {
          const rejection = Promise.reject(new Error(failureMessage))
          void rejection.catch(() => {})
          const scheduled = scheduler.schedule(rejection, 'G1 permission Query rejection')
          void scheduled.catch(() => {})
          releaseG1(scheduled)
        },
        settleG2Seed: async outcome => {
          const result =
            outcome === 'success'
              ? Promise.resolve(nextFolder)
              : Promise.reject(new Error('G2 location seed failed'))
          releaseG2(scheduler.schedule(result, 'G2 Files seed settlement'))
          await act(async () => scheduler.waitIdle())
          return scheduler
            .report()
            .filter(
              task =>
                task.label === 'G1 permission Query rejection' ||
                task.label === 'G2 Files seed settlement'
            )
            .map(task => task.label)
        },
        assertModel: async state => {
          const cachedG1Error = state.cachedPermissionErrors['team-1'] > 0
          const queryState = client.getQueryState(queryKey)
          if (cachedG1Error) expect(queryState?.status).toBe('error')
          const expectedVisibleCue = Boolean(
            state.filesMounted &&
            state.bindingActive &&
            state.bindingScope === state.sessionScope &&
            state.cachedPermissionErrors[state.sessionScope as 'team-1' | 'team-2'] > 0
          )
          expect(state.visiblePermissionCue).toBe(expectedVisibleCue)
          expect(Boolean(screen.queryByRole('alertdialog'))).toBe(expectedVisibleCue)
          if (state.sessionScope === 'team-2' && cachedG1Error) {
            expect(client.getQueryState(queryKey)?.status).toBe('error')
            expect(screen.queryByRole('alertdialog')).toBeNull()
            expect(
              screen.queryByRole('button', {
                name: 'Permission check failed; open recovery options',
              })
            ).toBeNull()
          }
        },
      }

      const commandArbitrary = fc
        .commands<Model, Real, true>(
          [
            fc.constant(new MountFiles()),
            fc.constant(new SettleG1Failure(true)),
            fc.constant(new UnmountFiles()),
            fc.constant(new SwitchTeamWhileFilesAbsent()),
            fc.constant(new SettleG1FailureWhileFilesAbsent()),
            fc.constant(new RemountFilesWithHeldSeed()),
            fc.constant(new SettleG2Seed(seedOutcome)),
            fc.constant(new ObserveQuiescentCue()),
          ],
          { maxCommands: 128, size: 'max' }
        )
        .map(history => Array.from(history))
        .filter(history => {
          const labels = history.map(command => command.toString())
          const hasOrderedSubsequence = (required: string[]) => {
            let index = 0
            for (const label of labels) {
              if (label === required[index]) index += 1
            }
            return index === required.length
          }
          const settleSeed = `settle the held G2 Files seed with ${seedOutcome}`
          return (
            hasOrderedSubsequence([
              'mount the production Files route through useAppController navigation',
              'settle the real G1 permission producer and observe its dialog',
              'leave Files through the production Chat route and retire its active binding',
              'publish the real same-principal team switch while Files and sidebar are absent',
              'remount production Files for G2 while the location producer is held',
              settleSeed,
            ]) ||
            hasOrderedSubsequence([
              'mount the production Files route through useAppController navigation',
              'leave Files through the production Chat route and retire its active binding',
              'publish the real same-principal team switch while Files and sidebar are absent',
              'queue the uncancelled G1 permission rejection while Files is absent in G2',
              'remount production Files for G2 while the location producer is held',
              settleSeed,
            ])
          )
        })
      try {
        await waitFor(() => expect(controller?.isAuthenticated).toBe(true))
        await fc.assert(
          fc.asyncProperty(commandArbitrary, fc.scheduler(), async (commands, scheduled) => {
            scheduler = scheduled
            await fc.asyncModelRun(() => ({ model, real }), commands)
            if (!model.quiescenceObserved) {
              await new ObserveQuiescentCue().run(model, real, false)
            }
            observedOutcomes.add(seedOutcome)
            if (!model.g1FailurePhase) throw new Error('The real G1 producer did not settle')
            observedFailurePhases.add(model.g1FailurePhase)
            expect(model).toMatchObject({
              sessionScope: 'team-2',
              bindingActive: seedOutcome === 'success',
              bindingScope: 'team-2',
              cachedPermissionErrors: { 'team-1': 1, 'team-2': 0 },
              filesMounted: true,
              visiblePermissionCue: false,
              g1FailureSettled: true,
              g1FailureQueued: false,
              quiescenceObserved: true,
            })
            if (model.g1FailurePhase === 'queued-while-files-absent-before-remount') {
              expect(model.settlementOrder).toHaveLength(2)
              expect(new Set(model.settlementOrder)).toEqual(
                new Set(['G1 permission Query rejection', 'G2 Files seed settlement'])
              )
              observedSettlementOrders.add(model.settlementOrder.join(' → '))
            }
            const requiredTransitions =
              model.g1FailurePhase === 'before-route-exit'
                ? [
                    'mount-files',
                    'settle-g1-while-files-mounted',
                    'unmount-files',
                    'switch-session-while-files-absent',
                    'remount-files-with-g2-seed-pending',
                    `settle-g2-seed-${seedOutcome}`,
                  ]
                : [
                    'mount-files',
                    'unmount-files',
                    'switch-session-while-files-absent',
                    'queue-g1-while-files-absent',
                    'remount-files-with-g2-seed-pending',
                    `settle-g2-seed-${seedOutcome}`,
                  ]
            let transitionIndex = 0
            for (const transition of model.executedTransitions) {
              if (transition === requiredTransitions[transitionIndex]) transitionIndex += 1
            }
            expect(transitionIndex).toBe(requiredTransitions.length)
            expect(model.executedTransitions.length).toBeGreaterThanOrEqual(6)
            await real.assertModel(model)
            await waitFor(() =>
              expect(
                client
                  .getQueryCache()
                  .getAll()
                  .every(query => query.state.fetchStatus === 'idle')
              ).toBe(true)
            )
            expect(screen.queryByRole('alertdialog')).toBeNull()
            view.unmount()
            client.clear()
          }),
          { numRuns: 1, seed: 142715 + sample }
        )
      } finally {
        releaseG2(Promise.resolve(nextFolder))
        view.unmount()
        client.clear()
        uninstallMockClerum()
      }
    }
    expect(observedOutcomes).toEqual(new Set(seedOutcomes))
    expect(observedOutcomes).toEqual(new Set(['success', 'failure']))
    expect(observedFailurePhases).toEqual(
      new Set(['before-route-exit', 'queued-while-files-absent-before-remount'])
    )
    expect(observedSettlementOrders).toEqual(
      new Set([
        'G1 permission Query rejection → G2 Files seed settlement',
        'G2 Files seed settlement → G1 permission Query rejection',
      ])
    )
  })

  it('preserves a current-session recovery dialog through a pending same-session seed', async () => {
    installAppControllerClerum()
    let releaseSeed!: (result: Promise<Awaited<ReturnType<typeof resolveResource>>>) => void
    const seedPending = new Promise<Awaited<ReturnType<typeof resolveResource>>>(resolve => {
      releaseSeed = resolve
    })
    const folder = await resolveResource(
      resolvedDirectory('r82-continuity-folder', 'Reports', { gfsUri: FOLDER_URI })
    )
    const row = childView('r82-continuity-row', 'report.txt', 'file', {
      parentResourceId: 'r82-continuity-folder',
    })
    const bridge = window.clerum as unknown as {
      auth: Record<string, unknown>
      gfs?: Record<string, unknown>
    }
    bridge.auth.getSessionGeneration = vi.fn(async () => 1)
    bridge.gfs = {
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('r82-continuity-folder', 'Reports', 'directory')])
      ),
      resolve: vi.fn(async (uri: string) => (uri === NEXT_FOLDER_URI ? seedPending : folder)),
      listChildren: vi.fn(async () => listChildrenPage([row])),
      affordances: vi.fn((resourceId: string) =>
        appServiceAffordanceProducer(id =>
          id === resourceId && id === 'r82-continuity-row'
            ? Promise.reject(new Error('403 Forbidden: resource_access_denied httpStatus=403'))
            : Promise.resolve(heldPermissionResponse(['read']))
        )(resourceId)
      ),
    }

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    let controller: Controller | undefined
    const RoutedFiles = () => {
      const state = useAppController()
      controller = state
      const tab = activeWorkspaceTab(state.workspaceTabs)
      const auth = {
        isAuthenticated: state.isAuthenticated,
        sessionGeneration: state.sessionGeneration,
        me: state.me,
        runtimeConfigState: state.runtimeConfigState,
      } as AuthContextValue
      return (
        <AuthContext.Provider value={auth}>
          {state.navItem === DESKTOP_ROUTES.files && tab?.kind === 'files' ? (
            <FilesPage key={tab.id} pendingGfsUri={tab.files?.path ?? null} />
          ) : null}
        </AuthContext.Provider>
      )
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    const view = render(<RoutedFiles />, { wrapper })
    try {
      await waitFor(() => expect(controller?.isAuthenticated).toBe(true))
      await act(async () => controller!.openFilesSection(FOLDER_URI))
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await screen.findByRole('alertdialog')

      await act(async () => controller!.handleNavSelect(DESKTOP_ROUTES.chat))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      await act(async () => controller!.openFilesSection(NEXT_FOLDER_URI))
      await waitFor(() => expect(bridge.gfs?.resolve).toHaveBeenCalledWith(NEXT_FOLDER_URI))
      expect(screen.getByRole('alertdialog')).toBeTruthy()
      expect(screen.getByRole('alertdialog').textContent).toContain(
        'Could not verify permissions for report.txt'
      )
    } finally {
      releaseSeed(Promise.resolve(folder))
      view.unmount()
      client.clear()
      uninstallMockClerum()
    }
  })
})
