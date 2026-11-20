// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onlineManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describeGfsGrantError } from '@lib/gfsGrantErrors'
import {
  DIRECT_GRANT,
  DOWNGRADE_SUCCESS,
  MEMBER,
  PARENT_ONE,
  PARENT_ONE_GRANT,
  PARENT_TWO,
  PARENT_TWO_GRANT,
  type ParentUpdatePage,
  REMOVE_SUCCESS,
  SESSION_GENERATION,
  TARGET_ID,
  deferred,
  mountParentUpdatePage,
  waitSettled,
  writeTargets,
} from '@/pages/__tests__/__fixtures__/parentUpdateHarness'

/**
 * The Share dialog's parent-folder confirmation with the sidebar's action
 * host as its owner: the same scenarios the Files page pins, through the
 * host's own session effect, dismissal and failClosed.
 */

const pages: ParentUpdatePage[] = []
async function mount(options: Parameters<typeof mountParentUpdatePage>[0] = {}) {
  const page = await mountParentUpdatePage({ ...options, owner: 'host' })
  pages.push(page)
  return page
}

afterEach(() => {
  cleanup()
  pages.forEach(page => page.queryClient.clear())
  pages.length = 0
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

const REMOVE_WRITES = [
  `revokeGrant:${PARENT_ONE_GRANT}`,
  `revokeGrant:${PARENT_TWO_GRANT}`,
  `revokeGrant:${DIRECT_GRANT}`,
]
const DOWNGRADE_WRITES = [`grant:${PARENT_ONE}`, `grant:${PARENT_TWO}`, `grant:${TARGET_ID}`]
const DENIED_PREFLIGHT = `Your access on Team folder does not allow making ${MEMBER} Read-only.`

function ancestorReads(page: ParentUpdatePage): number {
  return page.listGrants.mock.calls.filter(([resourceId]) => resourceId === PARENT_ONE).length
}

/** The host's last report to the overlay gate: true while Share covers the window. */
function overlayCovered(page: ParentUpdatePage): boolean | undefined {
  return page.hostActionOpen.mock.calls.at(-1)?.[0]
}

const modes = [
  {
    name: 'remove',
    ipc: (page: ParentUpdatePage) => page.revokeGrant,
    open: (page: ParentUpdatePage) => page.openRemovePlan(),
    writes: REMOVE_WRITES,
    success: REMOVE_SUCCESS,
  },
  {
    name: 'change-role',
    ipc: (page: ParentUpdatePage) => page.grant,
    open: (page: ParentUpdatePage) => page.startDowngrade(),
    writes: DOWNGRADE_WRITES,
    success: DOWNGRADE_SUCCESS,
  },
] as const

async function startHeldRun(page: ParentUpdatePage, mode: (typeof modes)[number]) {
  mode.ipc(page).hold()
  await mode.open(page)
  await page.confirmPlan()
  await waitFor(() => expect(mode.ipc(page).pending).toHaveLength(1))
}

async function releaseWrite(page: ParentUpdatePage, mode: (typeof modes)[number], index: number) {
  await act(async () => mode.ipc(page).pending[index]!.resolve(undefined))
}

async function finishRun(page: ParentUpdatePage, mode: (typeof modes)[number]) {
  mode.ipc(page).hold(false)
  for (const call of mode.ipc(page).pending) await act(async () => call.resolve(undefined))
  await waitSettled()
}

describe('GfsActionHost — parent-folder pre-flight', () => {
  it('S-1 shows nothing once the renderer publishes another session mid pre-flight', async () => {
    const page = await mount()
    page.holdAffordancesOf(PARENT_ONE)
    await page.startDowngrade()
    await waitFor(() => expect(page.heldAffordances(PARENT_ONE)).toHaveLength(1))

    page.switchMain()
    await page.publishGeneration()
    await waitFor(() => expect(page.shareDialog()).toBeNull())
    await act(async () => page.heldAffordances(PARENT_ONE)[0]!.resolve(page.freshDenied))
    await waitSettled()

    expect(page.affordances).toHaveBeenCalledWith(PARENT_ONE, 'main')
    expect(page.pushToast).not.toHaveBeenCalled()
    expect(page.confirmation()).toBeNull()
    expect(overlayCovered(page)).toBe(false)
  })

  it('S-1b shows nothing once the session is revoked mid pre-flight', async () => {
    const page = await mount()
    page.holdAffordancesOf(PARENT_ONE)
    await page.startDowngrade()
    await waitFor(() => expect(page.heldAffordances(PARENT_ONE)).toHaveLength(1))

    page.revoke()
    await waitFor(() => expect(page.shareDialog()).toBeNull())
    await act(async () => page.heldAffordances(PARENT_ONE)[0]!.resolve(page.freshDenied))
    await waitSettled()

    expect(page.accessState()).toBe('revoked')
    expect(page.affordances).toHaveBeenCalledWith(PARENT_ONE, 'main')
    expect(page.pushToast).not.toHaveBeenCalled()
  })

  it('S-1c reports a pre-flight refusal only while the Share dialog is still open', async () => {
    const open = await mount()
    open.holdAffordancesOf(PARENT_ONE)
    await open.startDowngrade()
    await waitFor(() => expect(open.heldAffordances(PARENT_ONE)).toHaveLength(1))
    await act(async () => open.heldAffordances(PARENT_ONE)[0]!.resolve(open.freshDenied))
    await waitFor(() => expect(open.pushToast).toHaveBeenCalledWith(DENIED_PREFLIGHT, 'error'))
    cleanup()

    const closed = await mount()
    closed.holdAffordancesOf(PARENT_ONE)
    await closed.startDowngrade()
    await waitFor(() => expect(closed.heldAffordances(PARENT_ONE)).toHaveLength(1))
    fireEvent.click(closed.closeButton())
    await waitFor(() => expect(closed.shareDialog()).toBeNull())
    await act(async () => closed.heldAffordances(PARENT_ONE)[0]!.resolve(closed.freshDenied))
    await waitSettled()

    expect(closed.affordances).toHaveBeenCalledWith(PARENT_ONE, 'main')
    expect(closed.pushToast).not.toHaveBeenCalled()
  })

  it('S-1c reports a pre-flight read failure only while the Share dialog is still open', async () => {
    const open = await mount()
    const failure = await open.affordancesFailure(500)
    const message = describeGfsGrantError(new Error(failure)).message
    open.holdAffordancesOf(PARENT_ONE)
    await open.startDowngrade()
    await waitFor(() => expect(open.heldAffordances(PARENT_ONE)).toHaveLength(1))
    await act(async () => open.heldAffordances(PARENT_ONE)[0]!.reject(new Error(failure)))
    await waitFor(() => expect(open.pushToast).toHaveBeenCalledWith(message, 'error'))
    expect(open.accessState()).toBe('active')
    cleanup()

    const closed = await mount()
    closed.holdAffordancesOf(PARENT_ONE)
    await closed.startDowngrade()
    await waitFor(() => expect(closed.heldAffordances(PARENT_ONE)).toHaveLength(1))
    fireEvent.click(closed.closeButton())
    await waitFor(() => expect(closed.shareDialog()).toBeNull())
    await act(async () => closed.heldAffordances(PARENT_ONE)[0]!.reject(new Error(failure)))
    await waitSettled()

    expect(closed.pushToast).not.toHaveBeenCalled()
    expect(closed.affordances).toHaveBeenCalledWith(PARENT_ONE, 'main')
    expect(closed.accessState()).toBe('active')
  })

  it('S-1d revokes on a pre-flight 401 even after the Share dialog closed', async () => {
    const page = await mount()
    const unauthorized = await page.affordancesFailure(401)
    page.holdAffordancesOf(PARENT_ONE)
    await page.startDowngrade()
    await waitFor(() => expect(page.heldAffordances(PARENT_ONE)).toHaveLength(1))
    fireEvent.click(page.closeButton())
    await waitFor(() => expect(page.shareDialog()).toBeNull())
    expect(page.accessState()).toBe('active')

    await act(async () => page.heldAffordances(PARENT_ONE)[0]!.reject(new Error(unauthorized)))
    await waitSettled()

    expect(page.accessState()).toBe('revoked')
    expect(page.pushToast).not.toHaveBeenCalled()
  })
})

describe('GfsActionHost — parent-folder confirmation run', () => {
  for (const mode of modes) {
    it(`S-2 writes nothing when main switched before the ${mode.name} confirmation`, async () => {
      const page = await mount()
      await mode.open(page)
      await screen.findByRole('alertdialog')
      page.switchMain()
      const confirmations = page.getSessionGeneration.mock.calls.length

      await page.confirmPlan()
      await waitSettled()

      expect(page.writes).toEqual([])
      expect(page.pushToast).not.toHaveBeenCalled()
      expect(page.getSessionGeneration.mock.calls.length).toBeGreaterThan(confirmations)
      expect(page.closeButton().disabled).toBe(false)
    })

    it(`${mode.name === 'remove' ? 'S-3' : 'S-4'} stops the ${mode.name} run when main switches between writes`, async () => {
      const page = await mount()
      await startHeldRun(page, mode)
      const walks = ancestorReads(page)
      page.switchMain()
      const confirmations = page.getSessionGeneration.mock.calls.length

      await finishRun(page, mode)

      expect(writeTargets(page.writes)).toEqual(mode.writes.slice(0, 1))
      expect(page.getSessionGeneration.mock.calls.length).toBeGreaterThan(confirmations)
      expect(page.pushToast).not.toHaveBeenCalled()
      expect(ancestorReads(page)).toBe(walks)
      expect(page.closeButton().disabled).toBe(false)
    })

    it(`S-3c skips the direct alignment of a ${mode.name} run when main switches after the folders`, async () => {
      const page = await mount()
      await startHeldRun(page, mode)
      await releaseWrite(page, mode, 0)
      await waitFor(() => expect(mode.ipc(page).pending).toHaveLength(2))
      page.switchMain()

      await finishRun(page, mode)

      expect(writeTargets(page.writes)).toEqual(mode.writes.slice(0, 2))
      expect(page.pushToast).not.toHaveBeenCalled()
    })

    it(`S-7 shows no ${mode.name} outcome when main switches after the last write`, async () => {
      const page = await mount()
      await startHeldRun(page, mode)
      await releaseWrite(page, mode, 0)
      await waitFor(() => expect(mode.ipc(page).pending).toHaveLength(2))
      await releaseWrite(page, mode, 1)
      await waitFor(() => expect(mode.ipc(page).pending).toHaveLength(3))
      page.switchMain()
      const confirmations = page.getSessionGeneration.mock.calls.length

      await finishRun(page, mode)

      expect(page.pushToast).not.toHaveBeenCalled()
      expect(writeTargets(page.writes)).toEqual(mode.writes)
      expect(page.getSessionGeneration.mock.calls.length).toBeGreaterThan(confirmations)
    })
  }

  it('S-3b stops the run once the session is revoked between writes', async () => {
    const page = await mount()
    await startHeldRun(page, modes[0])
    page.revoke()
    await waitFor(() => expect(page.shareDialog()).toBeNull())

    await finishRun(page, modes[0])

    expect(page.accessState()).toBe('revoked')
    expect(writeTargets(page.writes)).toEqual(REMOVE_WRITES.slice(0, 1))
    expect(page.pushToast).not.toHaveBeenCalled()
  })

  for (const revocation of ['revokeGfsSessionAccess', 'purgeGfsSessionCache'] as const) {
    it(`S-3d stays stopped after ${revocation} and a retry that restores access mid-write`, async () => {
      const page = await mount()
      await startHeldRun(page, modes[0])
      if (revocation === 'revokeGfsSessionAccess') page.revoke()
      else page.purge()
      await waitFor(() => expect(page.shareDialog()).toBeNull())
      await page.retryAccess()

      await finishRun(page, modes[0])

      expect(page.accessState()).toBe('active')
      expect(writeTargets(page.writes)).toEqual(REMOVE_WRITES.slice(0, 1))
      expect(page.pushToast).not.toHaveBeenCalled()
    })
  }

  it('S-5 keeps Share open while the run writes, then completes it and frees the dialog', async () => {
    const page = await mount()
    const confirmations = page.getSessionGeneration.mock.calls.length
    await startHeldRun(page, modes[0])
    const dialog = page.shareDialog()!

    expect(page.closeButton().disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(dialog.parentElement!)
    fireEvent.click(page.closeButton())
    await waitSettled()
    expect(page.shareDialog()).not.toBeNull()
    expect(overlayCovered(page)).toBe(true)

    await finishRun(page, modes[0])

    expect(writeTargets(page.writes)).toEqual(REMOVE_WRITES)
    await waitFor(() => expect(page.pushToast).toHaveBeenCalledWith(REMOVE_SUCCESS, 'success'))
    expect(page.pushToast).toHaveBeenCalledOnce()
    expect(page.getSessionGeneration.mock.calls.length - confirmations).toBe(
      REMOVE_WRITES.length + 1
    )
    await waitFor(() => expect(page.closeButton().disabled).toBe(false))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(page.shareDialog()).toBeNull())
    expect(overlayCovered(page)).toBe(false)
  })

  it('S-5b writes nothing when the host replaces Share before the first write is admitted', async () => {
    const page = await mount()
    const admission = deferred<number>()
    await page.openRemovePlan()
    await screen.findByRole('alertdialog')
    page.getSessionGeneration.mockImplementationOnce(() => admission.promise)
    const confirmations = page.getSessionGeneration.mock.calls.length

    await page.confirmPlan()
    await waitFor(() => expect(page.getSessionGeneration.mock.calls.length).toBe(confirmations + 1))
    await page.navigateAway()
    expect(page.shareDialog()).toBeNull()
    await act(async () => admission.resolve(SESSION_GENERATION))
    await waitSettled()

    expect(page.writes).toEqual([])
    expect(page.pushToast).not.toHaveBeenCalled()
    // The positive: the same admission with Share still open writes the plan.
    cleanup()
    const kept = await mount()
    const keptAdmission = deferred<number>()
    await kept.openRemovePlan()
    await screen.findByRole('alertdialog')
    kept.getSessionGeneration.mockImplementationOnce(() => keptAdmission.promise)
    await kept.confirmPlan()
    await act(async () => keptAdmission.resolve(SESSION_GENERATION))
    await waitSettled()
    expect(writeTargets(kept.writes)).toEqual(REMOVE_WRITES)
  })

  it('S-5c keeps Share open until the run ends, not until a direct role change ends', async () => {
    const page = await mount({ agentGrant: true })
    page.revokeGrant.hold()
    page.holdAffordancesOf(TARGET_ID)
    await page.startAgentRoleChange()
    await waitFor(() => expect(page.heldAffordances(TARGET_ID)).toHaveLength(1))
    await page.openRemovePlan()
    await page.confirmPlan()
    await waitFor(() => expect(page.revokeGrant.pending).toHaveLength(1))

    await act(async () => page.heldAffordances(TARGET_ID)[0]!.resolve(page.freshPositive))
    await waitFor(() =>
      expect(page.grant.fn).toHaveBeenCalledWith(
        TARGET_ID,
        ['host:1st:mcp-host/chatllm'],
        expect.arrayContaining(['read', 'write']),
        'main',
        true
      )
    )
    await waitSettled()

    expect(page.closeButton().disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitSettled()
    expect(page.shareDialog()).not.toBeNull()

    await finishRun(page, modes[0])
    expect(writeTargets(page.writes.filter(write => write.name === 'revokeGrant'))).toEqual(
      REMOVE_WRITES
    )
    await waitFor(() => expect(page.closeButton().disabled).toBe(false))
  })

  it('S-5d never starts a second confirmation while one runs', async () => {
    const page = await mount({ agentGrant: true })
    page.revokeGrant.hold()
    page.holdAffordancesOf(TARGET_ID)
    await page.startAgentRoleChange()
    await waitFor(() => expect(page.heldAffordances(TARGET_ID)).toHaveLength(1))
    await page.openRemovePlan()
    await page.confirmPlan()
    await waitFor(() => expect(page.revokeGrant.pending).toHaveLength(1))
    await act(async () => page.heldAffordances(TARGET_ID)[0]!.resolve(page.freshPositive))
    await waitFor(() => expect(page.grant.fn).toHaveBeenCalledOnce())
    await waitSettled()

    const memberRole = screen.getByRole('button', {
      name: `Access role for ${MEMBER}`,
    }) as HTMLButtonElement
    expect(memberRole.disabled).toBe(true)
    fireEvent.click(memberRole)
    expect(screen.queryByRole('option', { name: 'Read' })).toBeNull()
    await waitSettled()

    await finishRun(page, modes[0])
    expect(writeTargets(page.writes.filter(write => write.name === 'revokeGrant'))).toEqual(
      REMOVE_WRITES
    )
    expect(page.grant.fn).toHaveBeenCalledOnce()
    await waitFor(() => expect(memberRole.disabled).toBe(false))
  })

  it('S-6 reports how far a run got after an ordinary failure and refreshes the lists', async () => {
    const page = await mount()
    const failure = await page.failureMessage(500)
    await startHeldRun(page, modes[0])
    await releaseWrite(page, modes[0], 0)
    await waitFor(() => expect(page.revokeGrant.pending).toHaveLength(2))
    const walks = ancestorReads(page)

    await act(async () => page.revokeGrant.pending[1]!.reject(new Error(failure)))
    await waitSettled()

    expect(writeTargets(page.writes)).toEqual(REMOVE_WRITES.slice(0, 2))
    await waitFor(() =>
      expect(page.pushToast).toHaveBeenCalledWith(
        expect.stringContaining(`Removed from 1 of 2 folders — Root share still grants access`),
        'error'
      )
    )
    expect(page.pushToast).toHaveBeenCalledOnce()
    expect(page.accessState()).toBe('active')
    await waitFor(() => expect(ancestorReads(page)).toBeGreaterThan(walks))
  })

  it('S-8 stops without a toast or refresh when main cannot confirm the session', async () => {
    const page = await mount()
    await startHeldRun(page, modes[0])
    const walks = ancestorReads(page)
    page.getSessionGeneration.mockRejectedValueOnce(new Error('session IPC failed'))
    const confirmations = page.getSessionGeneration.mock.calls.length

    await finishRun(page, modes[0])

    expect(page.getSessionGeneration.mock.calls.length).toBe(confirmations + 1)
    expect(writeTargets(page.writes)).toEqual(REMOVE_WRITES.slice(0, 1))
    expect(page.pushToast).not.toHaveBeenCalled()
    expect(ancestorReads(page)).toBe(walks)
    expect(page.closeButton().disabled).toBe(false)
  })

  it('S-10 sends every write while the renderer is offline instead of pausing it', async () => {
    const page = await mount()
    await page.openRemovePlan()
    await screen.findByRole('alertdialog')
    page.goOffline()
    expect(onlineManager.isOnline()).toBe(false)

    await page.confirmPlan()
    await waitSettled()

    expect(writeTargets(page.writes)).toEqual(REMOVE_WRITES)
    await waitFor(() => expect(page.pushToast).toHaveBeenCalledWith(REMOVE_SUCCESS, 'success'))
    expect(page.closeButton().disabled).toBe(false)
  })
})

describe('GfsActionHost — session failures of the dialog’s direct IPC', () => {
  it('S-9 revokes access on a 401 from a folder grant of the change-role run', async () => {
    const page = await mount()
    const unauthorized = await page.grantFailureMessage(401)
    await startHeldRun(page, modes[1])
    expect(page.accessState()).toBe('active')

    await act(async () => page.grant.pending[0]!.reject(new Error(unauthorized)))
    await waitSettled()

    expect(page.accessState()).toBe('revoked')
    await waitFor(() => expect(page.shareDialog()).toBeNull())
    expect(writeTargets(page.writes)).toEqual(DOWNGRADE_WRITES.slice(0, 1))
    expect(page.pushToast).not.toHaveBeenCalled()
  })

  it('S-9 revokes only the session a folder grant 401 was issued under', async () => {
    // Positive: the same 401 in its own session revokes it.
    const same = await mount()
    const unauthorized = await same.grantFailureMessage(401)
    await startHeldRun(same, modes[1])
    await act(async () => same.grant.pending[0]!.reject(new Error(unauthorized)))
    await waitSettled()
    expect(same.accessState()).toBe('revoked')
    cleanup()

    const page = await mount()
    await startHeldRun(page, modes[1])
    page.switchMain()
    await page.publishGeneration()
    await waitFor(() => expect(page.shareDialog()).toBeNull())
    expect(page.rendererGeneration()).toBe(SESSION_GENERATION + 1)
    expect(page.accessState()).toBe('active')

    await act(async () => page.grant.pending[0]!.reject(new Error(unauthorized)))
    await waitSettled()

    // The late 401 belongs to the replaced session; the new one keeps its access.
    expect(page.accessState()).toBe('active')
    expect(writeTargets(page.writes)).toEqual(DOWNGRADE_WRITES.slice(0, 1))
    expect(page.pushToast).not.toHaveBeenCalled()
  })

  it('S-9 keeps access and reports an ordinary folder grant failure', async () => {
    const page = await mount()
    const failure = await page.grantFailureMessage(500)
    await startHeldRun(page, modes[1])

    await act(async () => page.grant.pending[0]!.reject(new Error(failure)))
    await waitSettled()

    expect(page.accessState()).toBe('active')
    expect(page.shareDialog()).not.toBeNull()
    await waitFor(() => expect(page.pushToast).toHaveBeenCalledOnce())
    expect(page.pushToast.mock.calls[0]![1]).toBe('error')
  })

  it('S-9 revokes access on a 401 from the pre-flight affordances read', async () => {
    const page = await mount()
    const unauthorized = await page.affordancesFailure(401)
    page.holdAffordancesOf(PARENT_ONE)
    await page.startDowngrade()
    await waitFor(() => expect(page.heldAffordances(PARENT_ONE)).toHaveLength(1))
    expect(page.accessState()).toBe('active')

    await act(async () => page.heldAffordances(PARENT_ONE)[0]!.reject(new Error(unauthorized)))
    await waitSettled()

    expect(page.accessState()).toBe('revoked')
    await waitFor(() => expect(page.shareDialog()).toBeNull())
    expect(page.confirmation()).toBeNull()
    expect(page.pushToast).not.toHaveBeenCalled()
  })

  it('S-9 opens the downgrade plan when the pre-flight reads succeed', async () => {
    const page = await mount()
    await page.startDowngrade()

    const plan = await screen.findByRole('alertdialog')
    expect(within(plan).getByRole('button', { name: 'Update role' })).toBeTruthy()
    expect(page.accessState()).toBe('active')
  })
})
