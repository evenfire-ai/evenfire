/**
 * Producer-derived composer references for the suggested-reference tests. Each
 * one comes out of the code that makes it in production: the picker modal, the
 * prefetch hook on top of the navigation answer, and the resend path on top of
 * the chips a send persists.
 */
import { vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { buildChatMessageAttachments } from '@lib/chatMessageAttachments'
import { buildComposerResendDraft } from '@lib/composerResend'
import { activeWorkspaceTab, createEmptyWorkspaceTabsState, openFilesTab } from '@lib/workspaceTabs'
import { ComposerGlobalFilesModal } from '../../../components/agents/ComposerGlobalFilesModal'
import { listAccessiblePage } from '../../../gfs/__fixtures__/gfsProducerFixtures'
import {
  gfscResourceView,
  resolvedNavigation,
} from '../../../gfs/__fixtures__/navigationResolutionFixtures'
import type { ComposerGlobalFileReference, ComposerReferenceAttachment } from '../../../uiTypes'
import { useTabReferenceSuggestion } from '../../useTabReferenceSuggestion'

type GfsResourceView = Awaited<ReturnType<typeof gfscResourceView>>

/** A file as gfs-controller projects it, with a UUID `resourceId` and a 32-hex rid. */
export function fileView(
  index: number,
  name = `file-${index}.md`,
  version = 3
): Promise<GfsResourceView> {
  const suffix = index.toString(16).padStart(12, '0')
  return gfscResourceView({
    resourceId: `0b9f3c1e-7a42-4d4e-9c1a-${suffix}`,
    name,
    version,
    bytes: 11,
  })
}

/** The fields of `useGfsBrowserController` the picker modal reads. */
export function pickerController(accessibleResources: unknown[]) {
  return {
    current: null,
    crumbs: [],
    items: [],
    accessibleResources,
    loading: false,
    loadingAccessible: false,
    error: null,
    errorUpdatedAt: 0,
    accessibleError: null,
    accessibleNotice: null,
    discoveryFailure: null,
    retryDiscovery: vi.fn(),
    retryChildren: vi.fn(),
    hasMore: false,
    hasMoreAccessible: false,
    isFetchingMore: false,
    isFetchingMoreAccessible: false,
    loadMore: vi.fn(),
    loadMoreAccessible: vi.fn(),
    openChild: vi.fn(),
    openResource: vi.fn(),
    goToCrumb: vi.fn(),
    reset: vi.fn(),
  }
}

/**
 * The references the picker attaches for `views`. The caller mocks
 * `useGfsBrowserController` (a module mock must live in the test file) and
 * hands its mock here.
 */
export async function pickedReferences(
  useGfsBrowserController: ReturnType<typeof vi.fn>,
  views: GfsResourceView[]
): Promise<ComposerReferenceAttachment[]> {
  const page = await listAccessiblePage(views)
  useGfsBrowserController.mockReturnValue(pickerController(page.items))
  const onAdd = vi.fn()
  const picker = render(
    <ComposerGlobalFilesModal attachedIds={[]} onAdd={onAdd} onClose={vi.fn()} />
  )
  for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: `Attach ${views.length}` }))
  picker.unmount()
  return onAdd.mock.calls[0]![0] as ComposerReferenceAttachment[]
}

/** The reference the prefetch hook suggests for `view`, open in Files. */
export async function suggestedCandidate(
  view: GfsResourceView
): Promise<ComposerGlobalFileReference> {
  const answer = await resolvedNavigation(view)
  const previous = Object.getOwnPropertyDescriptor(window, 'clerum')
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { resolveForNavigation: async () => answer } },
  })
  try {
    const hook = renderHook(() =>
      useTabReferenceSuggestion({
        activeTab: activeWorkspaceTab(
          openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path: view.gfsUri })
        ),
        navItem: DESKTOP_ROUTES.files,
        filesResolvedLocation: { gfsUri: view.gfsUri, kind: 'file' },
        authorityScope: 'dev:true:user-1:',
        drawerVisible: true,
      })
    )
    await act(async () => {})
    const candidate = hook.result.current.candidate
    hook.unmount()
    if (!candidate) throw new Error('the prefetch hook suggested nothing for this file')
    return candidate
  } finally {
    if (previous) Object.defineProperty(window, 'clerum', previous)
    else delete (window as { clerum?: unknown }).clerum
  }
}

/** The reference a resend puts back for a sent message that carried `reference`. */
export function resentReference(
  reference: ComposerReferenceAttachment
): ComposerReferenceAttachment {
  const draft = buildComposerResendDraft({
    content: 'What does this file say?',
    attachments: buildChatMessageAttachments([], [reference], []),
  })
  const [resent] = draft.referenceAttachments
  if (!resent) throw new Error('the resend path restored nothing for this reference')
  return resent
}
