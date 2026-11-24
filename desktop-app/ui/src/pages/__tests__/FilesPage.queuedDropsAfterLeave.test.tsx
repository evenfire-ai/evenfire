// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { childView, createFolderResult } from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  AGENT,
  TARGET_ID,
  mountParentUpdatePage,
  waitSettled,
} from './__fixtures__/parentUpdateHarness'
import {
  AUTHORITY_FRESH_MS,
  FOLDER_ID,
  FOLDER_NAME,
  IGNORED_UPLOAD_RECEIPT,
  type UploadReceipt,
  mountQueuedDropPage,
  queuedDropFixtures,
  settle,
} from './__fixtures__/queuedDropHarness'

/**
 * Queued GFS actions started on Files keep running after the user leaves
 * Files, as long as the session they were started under is still the one main
 * runs. Only a session change (team/environment switch, logout, revocation)
 * cuts them; the page unmounting does not.
 */

const ORIGIN = { env: 0, teamId: 'team-a', generation: 1 }
const clients: QueryClient[] = []

interface PendingUpload {
  release: () => void
  reject: (message: string) => void
}

/** The page plus a server whose uploads settle only when the test says so. */
async function mountDropPage() {
  const fixtures = await queuedDropFixtures()
  const serverNames: string[] = []
  const pendingUploads: PendingUpload[] = []
  const createFileFromPath = vi.fn(
    (_parent: string, name: string, _path: string, _drive?: string) =>
      new Promise<UploadReceipt>((resolve, reject) => {
        pendingUploads.push({
          release: () => {
            if (serverNames.includes(name)) {
              reject(new Error(fixtures.conflict))
              return
            }
            serverNames.push(name)
            resolve(IGNORED_UPLOAD_RECEIPT)
          },
          reject: message => reject(new Error(message)),
        })
      })
  )
  const createFolder = vi.fn(async (parentResourceId: string, name: string) =>
    createFolderResult(
      parentResourceId,
      childView('folder-created', name, 'directory', { parentResourceId })
    )
  )
  let nextAffordanceFailure: Error | null = null
  const affordances = vi.fn(async (_resourceId: string, _drive?: string) => {
    const failure = nextAffordanceFailure
    nextAffordanceFailure = null
    if (failure) throw failure
    return fixtures.writable
  })
  let mainGeneration = 1
  const getSessionGeneration = vi.fn(async () => mainGeneration)

  const page = await mountQueuedDropPage(fixtures, {
    affordances,
    createFileFromPath,
    createFolder,
    getSessionGeneration,
    listedNames: () => serverNames,
  })
  clients.push(page.queryClient)
  return {
    ...page,
    fixtures,
    affordances,
    createFolder,
    getSessionGeneration,
    pendingUploads,
    uploadedNames: () => [...serverNames],
    sentNames: () => createFileFromPath.mock.calls.map(call => call[1]),
    dropNames: (names: string[]) =>
      page.drop(names.map(name => new File([name], name, { type: 'text/plain' }))),
    failNextAffordances: (error: Error) => {
      nextAffordanceFailure = error
    },
    setMainGeneration: (generation: number) => {
      mainGeneration = generation
    },
  }
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
})

describe('FilesPage: queued actions after leaving Files', () => {
  it('S-1 uploads every dropped file after Files unmounts with a fresh write authority', async () => {
    const page = await mountDropPage()
    page.dropNames(['first.txt', 'second.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['first.txt']))

    await page.leave()
    await act(async () => page.pendingUploads[0]!.release())
    await settle()

    expect(page.sentNames()).toEqual(['first.txt', 'second.txt'])
    await act(async () => page.pendingUploads[1]!.release())
    await settle()
    expect(page.uploadedNames()).toEqual(['first.txt', 'second.txt'])
    expect(page.toasts).toContainEqual(['Uploaded second.txt', 'success'])
  })

  it('S-2 re-reads an expired authority once and uploads the rest after Files unmounts', async () => {
    const page = await mountDropPage()
    page.dropNames(['first.txt', 'second.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['first.txt']))

    await page.leave()
    page.advanceClock(AUTHORITY_FRESH_MS + 1_000)
    const readsBefore = page.affordances.mock.calls.length
    await act(async () => page.pendingUploads[0]!.release())
    await settle()

    expect(page.sentNames()).toEqual(['first.txt', 'second.txt'])
    await act(async () => page.pendingUploads[1]!.release())
    await settle()
    expect(page.uploadedNames()).toEqual(['first.txt', 'second.txt'])
    expect(page.affordances.mock.calls.length - readsBefore).toBe(1)
    expect(page.toasts).toContainEqual(['Uploaded second.txt', 'success'])
  })

  it('S-3 shows the error of a failed authority read that finished after Files unmounted', async () => {
    const page = await mountDropPage()
    const readFailure = new Error(page.fixtures.readFailure)
    page.dropNames(['first.txt', 'second.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['first.txt']))

    await page.leave()
    page.advanceClock(AUTHORITY_FRESH_MS + 1_000)
    page.failNextAffordances(readFailure)
    await act(async () => page.pendingUploads[0]!.release())
    await settle()

    expect(page.toasts).toContainEqual([describeGfsReadError(readFailure).message, 'error'])
    expect(page.sentNames()).toEqual(['first.txt'])
  })

  it('S-4 sends nothing more after a team switch while Files is unmounted', async () => {
    const page = await mountDropPage()
    page.dropNames(['first.txt', 'second.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['first.txt']))
    expect(page.getSessionGeneration).toHaveBeenCalledTimes(1)

    await page.leave()
    page.setMainGeneration(2)
    await page.publishSession({ teamId: 'team-b', generation: 2 })
    await act(async () => page.pendingUploads[0]!.release())
    await settle()

    // The second attempt reached its session confirmation, and main refused it.
    expect(page.getSessionGeneration).toHaveBeenCalledTimes(2)
    expect(page.sentNames()).toEqual(['first.txt'])
    expect(page.toasts).toEqual([['Uploaded first.txt', 'success']])
  })

  it('S-5 lets main stop the queue when it moved on before the renderer cleared its cache', async () => {
    const page = await mountDropPage()
    page.dropNames(['first.txt', 'second.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['first.txt']))
    expect(page.getSessionGeneration).toHaveBeenCalledTimes(1)

    await page.leave()
    // Logout in main: the renderer has not cleared the cache yet, so the
    // shared access flag still reads active and only main can stop the run.
    page.setMainGeneration(2)
    await act(async () => page.pendingUploads[0]!.release())
    await settle()

    expect(page.accessState(ORIGIN)).toBe('active')
    expect(page.getSessionGeneration).toHaveBeenCalledTimes(2)
    expect(page.sentNames()).toEqual(['first.txt'])
    expect(page.toasts).toEqual([['Uploaded first.txt', 'success']])
  })

  it('S-6 revokes the origin session on a 401 and sends no later file', async () => {
    const page = await mountDropPage()
    page.dropNames(['first.txt', 'second.txt', 'third.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['first.txt']))
    await act(async () => page.pendingUploads[0]!.release())
    await waitFor(() => expect(page.sentNames()).toEqual(['first.txt', 'second.txt']))

    await page.leave()
    await act(async () => page.pendingUploads[1]!.reject(page.fixtures.uploadUnauthorized))
    await settle()

    expect(page.sentNames()).toEqual(['first.txt', 'second.txt'])
    expect(page.accessState(ORIGIN)).toBe('revoked')
    expect(page.uploadedNames()).toEqual(['first.txt'])
  })

  it('S-7 retries the orphan upload under a free name when a new Files took its name', async () => {
    const page = await mountDropPage()
    page.dropNames(['report.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['report.txt']))

    await page.leave()
    await page.enter()
    await page.waitReady()
    page.dropNames(['report.txt'])
    await waitFor(() => expect(page.sentNames()).toEqual(['report.txt', 'report.txt']))

    // The new Files lands first; the orphan run gets the conflict outside Files.
    await act(async () => page.pendingUploads[1]!.release())
    await act(async () => page.pendingUploads[0]!.release())
    await waitFor(() => expect(page.sentNames()).toHaveLength(3))
    await act(async () => page.pendingUploads[2]!.release())
    await settle()

    const uploaded = page.uploadedNames()
    expect(uploaded).toHaveLength(2)
    expect(new Set(uploaded).size).toBe(2)
    expect(page.toasts.filter(([, tone]) => tone === 'success')).toEqual([
      ['Uploaded report.txt', 'success'],
      [`Uploaded ${uploaded[1]}`, 'success'],
    ])
  })

  it('S-8 creates a confirmed folder when Files unmounts right after the submit', async () => {
    const page = await mountDropPage()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Options for ${FOLDER_NAME}` }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }))
    })
    const form = await screen.findByRole('form', { name: 'Create folder' })
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Reports' } })

    // Submit and leave in the same task: the unmount commits before the run
    // resumes from its first permission check.
    act(() => {
      fireEvent.click(within(form).getByRole('button', { name: 'Create folder' }))
      page.leaveSync()
    })
    expect(page.region()).toBeNull()
    await settle()

    expect(page.createFolder).toHaveBeenCalledWith(FOLDER_ID, 'Reports', 'main')
    expect(page.toasts).toContainEqual(['Folder Reports created', 'success'])
  })

  it('S-9 sends no Manage access write that had not started when Files unmounted', async () => {
    const page = await mountParentUpdatePage({ agentGrant: true })
    clients.push(page.queryClient)
    page.holdAffordancesOf(TARGET_ID)
    await page.startAgentRoleChange()
    await waitFor(() => expect(page.heldAffordances(TARGET_ID)).toHaveLength(1))

    await page.navigateAway()
    await act(async () => page.heldAffordances(TARGET_ID)[0]!.resolve(page.freshPositive))
    await waitSettled(12)

    expect(page.writes.filter(write => write.name === 'grant')).toEqual([])
    expect(
      page.pushToast.mock.calls.filter(([message]) => message.startsWith(`${AGENT} is now`))
    ).toEqual([])
  })
})
