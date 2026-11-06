// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import { listAccessiblePage } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
import { GfsClient, type GfsTransport } from '../../../../../src/gfs/uriHandler.js'
import { ComposerGlobalFilesModal } from '../ComposerGlobalFilesModal'

const SESSION_SCOPE = ':user-a:team-a'
const SESSION_GENERATION = 1
const SESSION_TOKEN = 'fixture-session-token'
const authValue = {
  isAuthenticated: true,
  sessionGeneration: SESSION_GENERATION,
  me: {
    id: 'user-a',
    email: 'a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member' as const,
  },
  runtimeConfigState: null,
} as unknown as AuthContextValue

const queryClients: QueryClient[] = []

function installGfsBridge(listAccessible: typeof window.clerum.gfs.listAccessible) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        listAccessible,
        resolve: vi.fn(),
        listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
        affordances: vi.fn(async () => ({
          held: [],
          canDelegate: false,
          grantableBits: [],
          canCreateShare: false,
        })),
      },
    },
  })
}

function renderPicker(queryClient: QueryClient) {
  queryClients.push(queryClient)
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <ComposerGlobalFilesModal attachedIds={[]} onAdd={vi.fn()} onClose={vi.fn()} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  queryClients.forEach(queryClient => queryClient.clear())
  queryClients.length = 0
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

describe('ComposerGlobalFilesModal discovery errors', () => {
  it('shows a scoped retry for a producer error with an empty message', async () => {
    const emptyMessageError = new Error('')
    const failingTransport: GfsTransport = {
      baseUrl: 'https://gfs.fixture.test',
      requestJson: async () => {
        throw emptyMessageError
      },
      fetchBytes: async () => new ArrayBuffer(0),
    }
    const failingProducer = new GfsClient(failingTransport)
    const producedError = await failingProducer
      .listAccessible(SESSION_TOKEN, { drive: 'main' })
      .catch(error => error)
    expect(producedError).toBe(emptyMessageError)
    expect((producedError as Error).message).toBe('')

    const emptyPage = await listAccessiblePage([])
    const successfulProducer = new GfsClient({
      baseUrl: 'https://gfs.fixture.test',
      requestJson: async () => ({ ok: true, data: emptyPage }) as never,
      fetchBytes: async () => new ArrayBuffer(0),
    })
    const listAccessible = vi
      .fn<typeof window.clerum.gfs.listAccessible>()
      .mockRejectedValueOnce(producedError)
      .mockImplementationOnce(() =>
        successfulProducer.listAccessible(SESSION_TOKEN, { drive: 'main' })
      )
    installGfsBridge(listAccessible)

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    renderPicker(queryClient)

    const accessibleKey = desktopQueryKeys.gfsAccessible(SESSION_SCOPE, 'main', SESSION_GENERATION)
    await waitFor(() => {
      expect(queryClient.getQueryState(accessibleKey)?.status).toBe('error')
      expect((queryClient.getQueryState(accessibleKey)?.error as Error).message).toBe('')
    })
    expect(screen.queryByText('No shared files yet')).toBeNull()
    expect(await screen.findByText('Could not load your files')).toBeTruthy()
    expect(screen.getByText('The file request failed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /retry file listing/i })).toBeTruthy()
    expect(screen.queryByText('No shared files yet')).toBeNull()
    const failureStatus = screen.getByRole('status')
    expect(failureStatus.textContent).toContain('Could not load your files')
    expect(failureStatus.textContent).not.toContain('Loading files')
    expect(screen.queryByText(/fixture\.test|Error invoking remote method/)).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry file listing/i }))
    })

    expect(await screen.findByText('No shared files yet')).toBeTruthy()
    expect(listAccessible).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
