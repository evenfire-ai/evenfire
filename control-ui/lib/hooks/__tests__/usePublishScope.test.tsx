import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../../api'
import {
  PublishScopeProvider,
  isPublisherEnabled,
  resetPublishScopeCache,
  usePublishScope,
} from '../usePublishScope'

vi.mock('../../api', async orig => {
  const actual = await orig<typeof import('../../api')>()
  return { ...actual, getPublishScope: vi.fn() }
})

function Probe() {
  const { scope, loading, error } = usePublishScope()
  return (
    <div>
      {loading ? 'loading' : error ? 'error' : isPublisherEnabled(scope) ? 'enabled' : 'disabled'}
    </div>
  )
}

function RefreshProbe() {
  const { scope, loading, error, refresh } = usePublishScope()
  return (
    <div>
      <div data-testid="scope">
        {loading ? 'loading' : error ? 'error' : (scope?.scope ?? 'none')}
      </div>
      <button type="button" onClick={() => void refresh({ force: true })}>
        Refresh
      </button>
    </div>
  )
}

function renderWithProvider(children: React.ReactNode = <Probe />) {
  return render(<PublishScopeProvider cacheKey="admin-1">{children}</PublishScopeProvider>)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function scope(value: string | null) {
  return {
    scope: value,
    curator: value === null,
    orgName: value,
  }
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  resetPublishScopeCache()
})

describe('usePublishScope / isPublisherEnabled', () => {
  it('isPublisherEnabled: org-bound non-curator → true', () => {
    expect(isPublisherEnabled({ scope: 'acme', curator: false, orgName: 'Acme' })).toBe(true)
  })
  it('isPublisherEnabled: curator → false', () => {
    expect(isPublisherEnabled({ scope: null, curator: true, orgName: null })).toBe(false)
  })
  it('isPublisherEnabled: unbound (scope null) → false', () => {
    expect(isPublisherEnabled({ scope: null, curator: false, orgName: null })).toBe(false)
  })
  it('isPublisherEnabled: null scope object → false', () => {
    expect(isPublisherEnabled(null)).toBe(false)
  })

  it('isPublisherEnabled: org-bound non-curator, publisherUiEnabled explicitly false → false', () => {
    expect(
      isPublisherEnabled({
        scope: 'acme',
        curator: false,
        orgName: 'Acme',
        publisherUiEnabled: false,
      })
    ).toBe(false)
  })

  it('isPublisherEnabled: org-bound non-curator, publisherUiEnabled explicitly true → true', () => {
    expect(
      isPublisherEnabled({
        scope: 'acme',
        curator: false,
        orgName: 'Acme',
        publisherUiEnabled: true,
      })
    ).toBe(true)
  })

  it('isPublisherEnabled: org-bound non-curator, publisherUiEnabled absent (backward compat) → true', () => {
    expect(isPublisherEnabled({ scope: 'acme', curator: false, orgName: 'Acme' })).toBe(true)
  })

  it('resolves to enabled for an org-bound scope', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: 'acme',
      curator: false,
      orgName: 'Acme',
    })
    renderWithProvider()
    expect(await screen.findByText('enabled')).toBeInTheDocument()
  })

  it('fails closed (disabled) on error', async () => {
    vi.mocked(api.getPublishScope).mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 })
    )
    renderWithProvider()
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument())
  })

  it('shares one request across consumers and child route changes', async () => {
    vi.mocked(api.getPublishScope).mockResolvedValue({
      scope: 'acme',
      curator: false,
      orgName: 'Acme',
    })

    const view = renderWithProvider(
      <>
        <Probe />
        <Probe />
      </>
    )
    expect(await screen.findAllByText('enabled')).toHaveLength(2)

    view.rerender(
      <PublishScopeProvider cacheKey="admin-1">
        <div data-testid="next-route">
          <Probe />
        </div>
      </PublishScopeProvider>
    )

    expect(await screen.findByTestId('next-route')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(1)
  })

  it('bypasses the resolved provider cache on forced refresh', async () => {
    vi.mocked(api.getPublishScope)
      .mockResolvedValueOnce(scope('@acme'))
      .mockResolvedValueOnce(scope('@beta'))

    const view = renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('@acme')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('@beta')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(2)

    view.unmount()
    renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('@beta')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(2)
  })

  it('keeps overlapping forced refreshes ordered after an existing cache hit', async () => {
    const beta = deferred<api.PublishScope>()
    const gamma = deferred<api.PublishScope>()
    vi.mocked(api.getPublishScope)
      .mockResolvedValueOnce(scope('@acme'))
      .mockReturnValueOnce(beta.promise)
      .mockReturnValueOnce(gamma.promise)

    const view = renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('@acme')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(api.getPublishScope).toHaveBeenCalledTimes(3)

    await act(async () => {
      gamma.resolve(scope('@gamma'))
      await gamma.promise
    })
    expect(await screen.findByText('@gamma')).toBeInTheDocument()

    await act(async () => {
      beta.resolve(scope('@beta'))
      await beta.promise
    })
    expect(screen.getByText('@gamma')).toBeInTheDocument()
    expect(screen.queryByText('@beta')).toBeNull()

    view.unmount()
    renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('@gamma')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(3)
  })

  it('does not expose a stale resolved scope after a forced refresh failure', async () => {
    vi.mocked(api.getPublishScope)
      .mockResolvedValueOnce(scope('@acme'))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))

    renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('@acme')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('error')).toBeInTheDocument()
    expect(screen.queryByText('@acme')).toBeNull()
    expect(api.getPublishScope).toHaveBeenCalledTimes(2)
  })

  it('does not expose a stale keyed request that resolves after reset', async () => {
    const stale = deferred<api.PublishScope>()
    const fresh = deferred<api.PublishScope>()
    vi.mocked(api.getPublishScope)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    const view = renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('loading')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(1)

    resetPublishScopeCache('admin-1')
    await act(async () => {
      stale.resolve(scope('@stale'))
      await stale.promise
    })
    expect(screen.queryByText('@stale')).toBeNull()
    expect(screen.getByText('none')).toBeInTheDocument()
    view.unmount()

    renderWithProvider(<RefreshProbe />)
    expect(api.getPublishScope).toHaveBeenCalledTimes(2)

    await act(async () => {
      fresh.resolve(scope('@fresh'))
      await fresh.promise
    })
    expect(await screen.findByText('@fresh')).toBeInTheDocument()
  })

  it('does not expose a stale request that resolves after a full reset', async () => {
    const stale = deferred<api.PublishScope>()
    const fresh = deferred<api.PublishScope>()
    vi.mocked(api.getPublishScope)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    const view = renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('loading')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(1)

    resetPublishScopeCache()
    await act(async () => {
      stale.resolve(scope('@stale'))
      await stale.promise
    })
    expect(screen.queryByText('@stale')).toBeNull()
    expect(screen.getByText('none')).toBeInTheDocument()
    view.unmount()

    renderWithProvider(<RefreshProbe />)
    expect(api.getPublishScope).toHaveBeenCalledTimes(2)

    await act(async () => {
      fresh.resolve(scope('@fresh'))
      await fresh.promise
    })
    expect(await screen.findByText('@fresh')).toBeInTheDocument()
  })

  it('keeps an older request from overwriting a newer provider refresh', async () => {
    const stale = deferred<api.PublishScope>()
    const fresh = deferred<api.PublishScope>()
    vi.mocked(api.getPublishScope)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    const view = renderWithProvider(<RefreshProbe />)
    expect(await screen.findByText('loading')).toBeInTheDocument()
    expect(api.getPublishScope).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(api.getPublishScope).toHaveBeenCalledTimes(2)

    await act(async () => {
      fresh.resolve(scope('@fresh'))
      await fresh.promise
    })
    expect(await screen.findByText('@fresh')).toBeInTheDocument()

    await act(async () => {
      stale.resolve(scope('@stale'))
      await stale.promise
    })
    expect(screen.getByText('@fresh')).toBeInTheDocument()
    expect(screen.queryByText('@stale')).toBeNull()

    view.unmount()
    renderWithProvider(<RefreshProbe />)
    expect(api.getPublishScope).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('@fresh')).toBeInTheDocument()
  })
})
