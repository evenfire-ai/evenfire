// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render as renderTestingLibrary,
  screen,
  waitFor,
} from '@testing-library/react'
import { buildGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { buildComposerMarkdownSemanticModel } from '@lib/chatMessageSemantics'
import {
  resolveDeniedMessage,
  resolveResource,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { ChatMarkdownContent } from '../ChatMarkdownContent'

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
let nextTestPrincipal = 1

function render(ui: ReactNode, options?: Parameters<typeof renderTestingLibrary>[1]) {
  const client = new QueryClient()
  const ExistingWrapper = options?.wrapper
  function TestProviders({ children }: { children: ReactNode }) {
    const wrapped = ExistingWrapper ? <ExistingWrapper>{children}</ExistingWrapper> : children
    return <QueryClientProvider client={client}>{wrapped}</QueryClientProvider>
  }
  return renderTestingLibrary(ui, { ...options, wrapper: TestProviders })
}

function authFor(id = `user-${nextTestPrincipal++}`) {
  return {
    isAuthenticated: true,
    me: { id, teamId: 'team-1' },
    runtimeConfigState: {
      envKey: 'test',
      currentConfig: { externalRestApiBaseUrl: 'https://api.example.net/v1' },
    },
  } as unknown as AuthContextValue
}

type ResolvedTestResource = Awaited<ReturnType<typeof resolveResource>>

function installClerum(
  resolve: (uri: string) => Promise<ResolvedTestResource> = vi.fn(async () =>
    resolveResource(resolvedFile(uri.slice(-32), 'Plan.md'))
  ),
  getSessionGeneration = vi.fn(async () => 1)
) {
  const openUrl = vi.fn(async () => undefined)
  const getResourceProfileOrigin = vi.fn(async () => ({
    origin: 'https://invitation-profile.tenant.example',
    sessionGeneration: 1,
    envKey: 'test',
  }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration },
      gfs: { resolve, getResourceProfileOrigin },
      app: { openUrl },
    } as unknown as Window['clerum'],
  })
  return { resolve, openUrl, getResourceProfileOrigin }
}

function renderMarkdown(
  source: string,
  onOpenGfsResource = vi.fn(),
  options: { auth?: AuthContextValue; queryClient?: QueryClient } = {}
) {
  const auth = options.auth ?? authFor()
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
  return {
    onOpenGfsResource,
    queryClient,
    sessionScope: `${auth.runtimeConfigState?.envKey}:${auth.me?.id}:${auth.me?.teamId}`,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={auth}>
          <ChatMarkdownContent
            model={buildComposerMarkdownSemanticModel(source)}
            query=""
            activeOccurrence={null}
            onOpenGfsResource={onOpenGfsResource}
          />
        </AuthContext.Provider>
      </QueryClientProvider>
    ),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ChatMarkdownContent resource links', () => {
  afterEach(() => {
    cleanup()
    delete (window as Partial<typeof window>).clerum
  })

  it('resolves a bare canonical URI to its authorized name and routes the exact target', async () => {
    const resource = await resolveResource(resolvedFile(uri.slice(-32), 'Quarterly Plan.md'))
    const resolve = vi.fn(async () => resource)
    const { openUrl } = installClerum(resolve)
    const { container, onOpenGfsResource } = renderMarkdown(`Open ${uri}.`)

    const link = await screen.findByRole('link', { name: 'Quarterly Plan.md' })
    expect(resolve).toHaveBeenCalledWith(uri)
    expect(link.getAttribute('href')).toBe('#gfs-resource')
    fireEvent.click(link)
    expect(onOpenGfsResource).toHaveBeenCalledWith(uri)
    expect(openUrl).not.toHaveBeenCalled()
    expect(container.textContent).toBe('Open Quarterly Plan.md.')
  })

  it('revokes shared GFS access when a bare-link label lookup reports session authority failure', async () => {
    const message = await resolveDeniedMessage(
      uri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    const resolve = vi.fn(async () => {
      throw new Error(message)
    })
    installClerum(resolve)
    const { queryClient, sessionScope } = renderMarkdown(uri)

    await waitFor(() =>
      expect(queryClient.getQueryData(desktopQueryKeys.gfsAccessState(sessionScope))).toBe(
        'revoked'
      )
    )
  })

  it('hides and forgets resolved labels after a sibling label revokes GFS session access', async () => {
    const secondUri = 'gfs://main/abcdefabcdefabcdefabcdefabcdefab'
    const message = await resolveDeniedMessage(
      secondUri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    const authorizedResource = await resolveResource(
      resolvedFile(uri.slice(-32), 'Previously authorized name.md')
    )
    const deniedLookup = deferred<ResolvedTestResource>()
    const resolve = vi.fn(async (requestedUri: string) => {
      if (requestedUri === uri) return authorizedResource
      return deniedLookup.promise
    })
    installClerum(resolve)
    const auth = authFor('label-revocation-cache')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const source = `${uri}\n${secondUri}`
    const rendered = renderMarkdown(source, vi.fn(), { auth, queryClient })
    const sessionScope = `${auth.runtimeConfigState?.envKey}:${auth.me?.id}:${auth.me?.teamId}`

    await screen.findByRole('link', { name: 'Previously authorized name.md' })
    await act(async () => {
      deniedLookup.reject(new Error(message))
      await deniedLookup.promise.catch(() => undefined)
    })
    await waitFor(() =>
      expect(queryClient.getQueryData(desktopQueryKeys.gfsAccessState(sessionScope))).toBe(
        'revoked'
      )
    )
    expect(screen.queryByRole('link', { name: 'Previously authorized name.md' })).toBeNull()

    rendered.unmount()
    renderMarkdown(uri, vi.fn(), { auth, queryClient })
    expect(screen.queryByRole('link', { name: 'Previously authorized name.md' })).toBeNull()
  })

  it('does not revoke the current GFS session for a label failure from an older session generation', async () => {
    const message = await resolveDeniedMessage(
      uri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    const resolution = deferred<ResolvedTestResource>()
    const resolve = vi.fn(() => resolution.promise)
    const getSessionGeneration = vi.fn(async () => 1)
    installClerum(resolve, getSessionGeneration)
    const { queryClient, sessionScope } = renderMarkdown(uri)

    await waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    getSessionGeneration.mockResolvedValue(2)
    await act(async () => {
      resolution.reject(new Error(message))
      await resolution.promise.catch(() => undefined)
      await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
    })

    expect(queryClient.getQueryData(desktopQueryKeys.gfsAccessState(sessionScope))).not.toBe(
      'revoked'
    )
  })

  it('ignores a late successful label after a sibling lookup revokes session access', async () => {
    const secondUri = 'gfs://main/abcdefabcdefabcdefabcdefabcdefab'
    const message = await resolveDeniedMessage(
      secondUri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    const delayedLabel = deferred<ResolvedTestResource>()
    const resolve = vi.fn((requestedUri: string) =>
      requestedUri === uri ? delayedLabel.promise : Promise.reject(new Error(message))
    )
    installClerum(resolve)
    const auth = authFor('late-label-after-revoke')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    renderMarkdown(`${uri}\n${secondUri}`, vi.fn(), { auth, queryClient })
    const sessionScope = `${auth.runtimeConfigState?.envKey}:${auth.me?.id}:${auth.me?.teamId}`

    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(queryClient.getQueryData(desktopQueryKeys.gfsAccessState(sessionScope))).toBe(
        'revoked'
      )
    )
    const lateResource = await resolveResource(resolvedFile(uri.slice(-32), 'Late label.md'))
    await act(async () => delayedLabel.resolve(lateResource))

    expect(screen.queryByRole('link', { name: 'Late label.md' })).toBeNull()
  })

  it('does not recreate GFS revocation state after logout clears the query cache', async () => {
    const message = await resolveDeniedMessage(
      uri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    const resolution = deferred<ResolvedTestResource>()
    const resolve = vi.fn(() => resolution.promise)
    installClerum(resolve)
    const auth = authFor('logout-label-race')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    renderMarkdown(uri, vi.fn(), { auth, queryClient })
    const sessionScope = `${auth.runtimeConfigState?.envKey}:${auth.me?.id}:${auth.me?.teamId}`
    const accessKey = desktopQueryKeys.gfsAccessState(sessionScope)

    await waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    queryClient.clear()
    await act(async () => {
      resolution.reject(new Error(message))
      await resolution.promise.catch(() => undefined)
      await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
    })

    expect(queryClient.getQueryData(accessKey)).toBeUndefined()
  })

  it('keeps shared GFS access for a resource-scoped label denial', async () => {
    const message = await resolveDeniedMessage(
      uri,
      { code: 'manage_acl_required', message: 'resource operation is denied' },
      403
    )
    const resolve = vi.fn(async () => {
      throw new Error(message)
    })
    installClerum(resolve)
    const { queryClient, sessionScope } = renderMarkdown(uri)

    await waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    await act(async () => new Promise(resolveTurn => setTimeout(resolveTurn, 0)))

    expect(queryClient.getQueryData(desktopQueryKeys.gfsAccessState(sessionScope))).not.toBe(
      'revoked'
    )
  })

  it('ignores a session-authority failure from an obsolete authorization epoch', async () => {
    const message = await resolveDeniedMessage(
      uri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    const oldResolution = deferred<ResolvedTestResource>()
    const currentResolution = deferred<ResolvedTestResource>()
    const resolve = vi
      .fn()
      .mockReturnValueOnce(oldResolution.promise)
      .mockReturnValueOnce(currentResolution.promise)
    installClerum(resolve)

    const auth = authFor('stale-label-epoch')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const model = buildComposerMarkdownSemanticModel(uri)
    const renderAtEpoch = (remoteGfsChangeEpoch: number) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={auth}>
          <ChatMarkdownContent
            model={model}
            query=""
            activeOccurrence={null}
            remoteGfsChangeEpoch={remoteGfsChangeEpoch}
          />
        </AuthContext.Provider>
      </QueryClientProvider>
    )
    const rendered = render(renderAtEpoch(0))
    const sessionScope = `${auth.runtimeConfigState?.envKey}:${auth.me?.id}:${auth.me?.teamId}`

    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    rendered.rerender(renderAtEpoch(1))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

    await act(async () => {
      oldResolution.reject(new Error(message))
      await oldResolution.promise.catch(() => undefined)
      await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
    })
    expect(queryClient.getQueryData(desktopQueryKeys.gfsAccessState(sessionScope))).not.toBe(
      'revoked'
    )

    const resource = await resolveResource(resolvedFile(uri.slice(-32), 'Fresh epoch.md'))
    await act(async () => currentResolution.resolve(resource))
  })

  it('sanitizes bidi controls in resolved names without changing the link target', async () => {
    const maliciousName = 'invoice.pdf\u202Eexe'
    const resource = await resolveResource(resolvedFile(uri.slice(-32), maliciousName))
    const resolve = vi.fn(async () => resource)
    installClerum(resolve)
    const { onOpenGfsResource } = renderMarkdown(uri)

    const link = await screen.findByRole('link', { name: 'invoice.pdfexe' })
    expect(screen.queryByText(maliciousName)).toBeNull()
    fireEvent.click(link)

    expect(onOpenGfsResource).toHaveBeenCalledWith(uri)
  })

  it('renders and resolves a bare GFS link with a one-character drive', async () => {
    const oneCharacterDriveUri = 'gfs://A/abcdefabcdefabcdefabcdefabcdefab'
    const resource = await resolveResource(
      resolvedFile('abcdefabcdefabcdefabcdefabcdefab', 'Single drive report.md', {
        drive: 'A',
        gfsUri: oneCharacterDriveUri,
      })
    )
    const resolve = vi.fn(async (requestedUri: string) => {
      expect(requestedUri).toBe(oneCharacterDriveUri)
      return resource
    })
    installClerum(resolve)
    const { onOpenGfsResource } = renderMarkdown(`Open ${oneCharacterDriveUri}.`)

    const link = await screen.findByRole('link', { name: 'Single drive report.md' })
    expect(resolve).toHaveBeenCalledWith(oneCharacterDriveUri)
    fireEvent.click(link)
    expect(onOpenGfsResource).toHaveBeenCalledWith(oneCharacterDriveUri)
  })

  it('renders a bare Desktop deep link and routes its exact canonical resource', async () => {
    const resource = await resolveResource(resolvedFile(uri.slice(-32), 'Desktop plan.md'))
    const resolve = vi.fn(async (requestedUri: string) => {
      expect(requestedUri).toBe(uri)
      return resource
    })
    const { openUrl } = installClerum(resolve)
    const desktopLink = buildGfsResourceDeepLink(uri)
    const { onOpenGfsResource } = renderMarkdown(`Open ${desktopLink}.`)

    const link = await screen.findByRole('link', { name: 'Desktop plan.md' })
    fireEvent.click(link)
    expect(onOpenGfsResource).toHaveBeenCalledWith(uri)
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('preserves an authored label and sends its canonical GFS target to the App owner', () => {
    const { resolve, openUrl } = installClerum()
    const { onOpenGfsResource } = renderMarkdown(`[Project Plan](${uri})`)

    const link = screen.getByRole('link', { name: 'Project Plan' })
    fireEvent.click(link)
    expect(onOpenGfsResource).toHaveBeenCalledWith(uri)
    expect(resolve).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('recognizes a Profile file link only through the configured origin', async () => {
    const { resolve, openUrl } = installClerum()
    const { onOpenGfsResource } = renderMarkdown(
      `https://invitation-profile.tenant.example/open/files?uri=${encodeURIComponent(uri)}`
    )

    const link = await screen.findByRole('link', { name: 'Plan.md' })
    expect(resolve).toHaveBeenCalledWith(uri)
    fireEvent.click(link)
    expect(onOpenGfsResource).toHaveBeenCalledWith(uri)
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('does not trust an origin response from a superseded session', async () => {
    let currentGeneration = 4
    let finishOrigin!: (value: {
      origin: string
      sessionGeneration: number
      envKey: string
    }) => void
    const resolve = vi.fn(async () => resolveResource(resolvedFile(uri.slice(-32), 'Plan.md')))
    const openUrl = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => currentGeneration) },
        gfs: {
          resolve,
          getResourceProfileOrigin: vi.fn(
            () =>
              new Promise(resolveOrigin => {
                finishOrigin = resolveOrigin
              })
          ),
        },
        app: { openUrl },
      } as unknown as Window['clerum'],
    })
    const profileLink = `https://invitation-profile.tenant.example/open/files?uri=${encodeURIComponent(uri)}`
    const { onOpenGfsResource } = renderMarkdown(profileLink)
    await waitFor(() => expect(finishOrigin).toBeTypeOf('function'))
    currentGeneration = 5
    await act(async () => {
      finishOrigin({
        origin: 'https://invitation-profile.tenant.example',
        sessionGeneration: 4,
        envKey: 'test',
      })
    })

    expect(resolve).not.toHaveBeenCalled()
    expect(onOpenGfsResource).not.toHaveBeenCalled()
    const link = screen.getByRole('link', { name: profileLink })
    fireEvent.click(link)
    expect(onOpenGfsResource).not.toHaveBeenCalled()
    expect(openUrl).toHaveBeenCalledWith(profileLink)
  })

  it('opens safe HTTP links externally and leaves unsafe schemes inert', () => {
    const { openUrl } = installClerum()
    renderMarkdown(
      '[Documentation](https://docs.example.test/guide)\n\n[Unsafe](javascript:alert(1))'
    )

    fireEvent.click(screen.getByRole('link', { name: 'Documentation' }))
    expect(openUrl).toHaveBeenCalledWith('https://docs.example.test/guide')
    expect(screen.queryByRole('link', { name: 'Unsafe' })).toBeNull()
    expect(screen.getByText('Unsafe')).toBeTruthy()
  })

  it('keeps remote Markdown images inert and preserves their alt text', () => {
    const { container } = renderMarkdown('![Remote](https://example.test/private.png)')

    expect(container.querySelector('img[src^="https://"]')).toBeNull()
    expect(screen.queryByRole('img', { name: 'Remote' })).toBeNull()
    expect(screen.getByText('Remote')).toBeTruthy()
  })

  it('keeps raw HTML inert after the Markdown renderer parses it', () => {
    const { container } = renderMarkdown(
      '<img src="https://example.test/private.png" onerror="alert(1)">'
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img')
  })

  it('bounds automatic label resolution to sixty unique links per principal', async () => {
    const uris = Array.from({ length: 70 }, (_, index) => {
      const id = String(index + 1).padStart(32, '0')
      return `gfs://main/${id}`
    })
    const resolve = vi.fn(async (requestedUri: string) => {
      const resourceId = requestedUri.split('/').at(-1)!
      const index = Number(resourceId)
      return resolveResource(resolvedFile(resourceId, `Resource ${index}`))
    })
    installClerum(resolve)
    renderMarkdown(uris.join('\n\n'))

    await screen.findByRole('link', { name: 'Resource 1' })
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(60))
    expect(screen.getByRole('link', { name: 'Resource 60' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'EvenDrive resource' })).toHaveLength(10)
    expect(screen.queryByRole('link', { name: 'Resource 61' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Resource 70' })).toBeNull()
  })

  it('shares one producer-backed label resolution across mounted message components', async () => {
    const resource = await resolveResource(resolvedFile(uri.slice(-32), 'Shared report.md'))
    const resolve = vi.fn(async () => resource)
    installClerum(resolve)
    const auth = authFor('shared-message-principal')
    const model = buildComposerMarkdownSemanticModel(`Open ${uri}`)
    render(
      <AuthContext.Provider value={auth}>
        {[1, 2, 3].map(message => (
          <ChatMarkdownContent key={message} model={model} query="" activeOccurrence={null} />
        ))}
      </AuthContext.Provider>
    )

    expect(await screen.findAllByRole('link', { name: 'Shared report.md' })).toHaveLength(3)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('keeps aggregate resolution under the principal budget across nine mounted messages', async () => {
    const uris = Array.from({ length: 72 }, (_, index) => {
      const id = String(index + 1).padStart(32, '0')
      return `gfs://main/${id}`
    })
    const resolve = vi.fn(async (requestedUri: string) => {
      const resourceId = requestedUri.split('/').at(-1)!
      const index = Number(resourceId)
      return resolveResource(resolvedFile(resourceId, `Message resource ${index}`))
    })
    installClerum(resolve)
    const auth = authFor('aggregate-message-principal')
    const models = Array.from({ length: 9 }, (_, message) =>
      buildComposerMarkdownSemanticModel(uris.slice(message * 8, message * 8 + 8).join('\n\n'))
    )
    render(
      <AuthContext.Provider value={auth}>
        {models.map((model, index) => (
          <ChatMarkdownContent key={index} model={model} query="" activeOccurrence={null} />
        ))}
      </AuthContext.Provider>
    )

    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(60))
    expect(screen.getAllByRole('link', { name: 'EvenDrive resource' })).toHaveLength(12)
    expect(screen.getByRole('link', { name: 'Message resource 60' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Message resource 61' })).toBeNull()
  })

  it('hides an old authorized label immediately when the App GFS epoch advances', async () => {
    const secondUri = 'gfs://main/abcdefabcdefabcdefabcdefabcdefab'
    const oldResource = await resolveResource(resolvedFile(uri.slice(-32), 'Old label.md'))
    const delayedOldResource = await resolveResource(
      resolvedFile(secondUri.slice(-32), 'Delayed stale label.md')
    )
    const freshResource = await resolveResource(resolvedFile(uri.slice(-32), 'Fresh label.md'))
    const refreshedSecondResource = await resolveResource(
      resolvedFile(secondUri.slice(-32), 'Fresh second label.md')
    )
    const oldRequest = deferred<ResolvedTestResource>()
    const freshFirstRequest = deferred<ResolvedTestResource>()
    const freshSecondRequest = deferred<ResolvedTestResource>()
    let resolveCalls = 0
    const resolve = vi.fn((requestedUri: string) => {
      resolveCalls += 1
      if (requestedUri === uri) {
        return resolveCalls === 1 ? Promise.resolve(oldResource) : freshFirstRequest.promise
      }
      return resolveCalls === 2 ? oldRequest.promise : freshSecondRequest.promise
    })
    installClerum(resolve)
    const auth = authFor('epoch-principal')
    const view = render(
      <AuthContext.Provider value={auth}>
        <ChatMarkdownContent
          model={buildComposerMarkdownSemanticModel(`Open ${uri}\n\nAnd ${secondUri}`)}
          query=""
          activeOccurrence={null}
          remoteGfsChangeEpoch={0}
        />
      </AuthContext.Provider>
    )

    expect(await screen.findByRole('link', { name: 'Old label.md' })).toBeTruthy()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

    view.rerender(
      <AuthContext.Provider value={auth}>
        <ChatMarkdownContent
          model={buildComposerMarkdownSemanticModel(`Open ${uri}\n\nAnd ${secondUri}`)}
          query=""
          activeOccurrence={null}
          remoteGfsChangeEpoch={1}
        />
      </AuthContext.Provider>
    )
    expect(screen.getAllByRole('link', { name: 'EvenDrive resource' })).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'Old label.md' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Delayed stale label.md' })).toBeNull()

    await act(async () => oldRequest.resolve(delayedOldResource))
    expect(screen.getAllByRole('link', { name: 'EvenDrive resource' })).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'Old label.md' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Delayed stale label.md' })).toBeNull()

    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(4))
    await act(async () => {
      freshFirstRequest.resolve(freshResource)
      freshSecondRequest.resolve(refreshedSecondResource)
    })
    expect(await screen.findByRole('link', { name: 'Fresh label.md' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'Fresh second label.md' })).toBeTruthy()
  })

  it('ignores a bare-link resolution after its source message changes', async () => {
    const resource = await resolveResource(resolvedFile(uri.slice(-32), 'Stale report.md'))
    const pending = deferred<ResolvedTestResource>()
    const resolve = vi.fn(() => pending.promise)
    installClerum(resolve)
    const auth = authFor('source-change-principal')
    const view = render(
      <AuthContext.Provider value={auth}>
        <ChatMarkdownContent
          model={buildComposerMarkdownSemanticModel(`Open ${uri}`)}
          query=""
          activeOccurrence={null}
        />
      </AuthContext.Provider>
    )

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(uri))
    view.rerender(
      <AuthContext.Provider value={auth}>
        <ChatMarkdownContent
          model={buildComposerMarkdownSemanticModel('The link was removed.')}
          query=""
          activeOccurrence={null}
        />
      </AuthContext.Provider>
    )
    await act(async () => pending.resolve(resource))

    expect(screen.queryByRole('link', { name: 'Stale report.md' })).toBeNull()
    expect(screen.queryByText('Stale report.md')).toBeNull()
  })

  it('does not turn a GFS URI inside a code span into a link', async () => {
    const { resolve } = installClerum()
    renderMarkdown(`Use \`${uri}\` as an example.`)

    await waitFor(() => expect(resolve).not.toHaveBeenCalled())
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(uri)).toBeTruthy()
  })
})
