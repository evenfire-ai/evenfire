# GFS Desktop — authority lifecycle, grants/shares independence, Move pagination (R4 spec)

Status: implemented (R4 fix round)
Scope: `desktop-app/ui` — `useGfsBrowserController`, `FilesPage`, `GfsGrantList`, `GfsMoveDialog`
Supercedes: the ad-hoc corrective patches from the R3 fix round (`93f211d08`). This document
is the durable contract for the three behavior areas below; future changes to these files
must keep this spec true or update it in the same commit.

## 1. GFS authority / cache / error lifecycle

### Roles

- **Server is the only authority.** Permissions (affordances), listings, grants, shares,
  and versions (`ifMatch`) are always server responses. No client cache may be treated as
  an authorization fact.
- **Discovery (`listAccessible`) is the session/authority boundary.** It is
  permission-derived session state, so on every controller mount it is revalidated
  (`refetchOnMount: 'always'`) even though the production client otherwise never
  refetches (`staleTime: Infinity`, `refetchOnMount: false`).
- **`accessState`** (`'active' | 'revoked'`) is session-local UI state owned by the
  controller. `'revoked'` gates every GFS query observer (`enabled`) and is the only
  fail-closed verdict; `retryAccess()` merely re-enables the queries — a fresh server
  success is the only way data returns.

### What the UI may render while authority is being revalidated

- `authorityPending` is true from controller mount (or session-scope return) until the
  first fresh discovery response lands (success or failure), whenever discovery is
  available in the runtime.
- While `authorityPending`, the controller withholds all cached GFS state it exposes:
  `accessibleResources`, `items`, `affordances`, `rowAffordances`, `grants`, and `shares`
  are reported as empty/`null`. FilesPage renders the loading state, never cached rows.
  Prefetched children therefore cannot bypass revalidation: their cache may exist, but it
  is not rendered until discovery re-proves the session.
- Local navigation chrome (breadcrumb trail titles typed by the user's own navigation)
  is not server-derived data and may remain; it is cleared on failure (below).

### Which queries/caches are cleared on authority failure

- Every session-scoped GFS query is removed via `queryClient.removeQueries({ queryKey:
desktopQueryKeys.gfsRoot })` — accessible roots, folder children (including prefetch),
  affordances (dialog + row), grants, and shares. The Move dialog deliberately shares
  these exact keys, so its destination listings are purged too.
- Removal (not invalidation) is required: under production defaults an invalidated-but-
  cached query would keep rendering its stale data.

### Which local UI state is cleared on authority failure

- Controller: `crumbs`, `openError` (`clearGfsState`), and `accessState → 'revoked'`.
- FilesPage (via effect on `accessState === 'revoked'`): file preview state (dialog +
  already-fetched bytes), Manage dialog, Move dialog target, rename dialog target +
  inline rename form, delete confirm, open-link dialog, and the inline create-folder form.
  Anything that could display or act on stale GFS data must close.

### How 401 / typed authority failures reach one boundary

- One classifier: `isGfsSessionAuthorityFailure(message, surface)`.
  - `surface: 'discovery'` — 401 **or** 403/unauthorized/forbidden fail closed (the
    discovery listing itself is permission-derived).
  - `surface: 'operation'` — only a bare 401 / "not authenticated" / "unauthenticated"
    or a typed lifecycle code (`desktop_user_retired`, `operator_link_inactive`,
    `operator_link_invalid`, `gfs_operator_link_invalid`) fails closed. A generic 403 on
    one resource is a policy verdict (e.g. `manage_acl_required`, `escalation_rejected`)
    and stays local to that operation.
- **Query path**: errors from accessible, children, affordances, row-affordances,
  grants, and shares queries are collected and routed into the same boundary effect.
- **Imperative path**: `handleAuthorityFailure` is wired into `openUri`, every
  controller mutation (`onError`), and every FilesPage imperative catch (grant, revoke
  grant/share, create share, create folder, upload, replace, rename, delete, move,
  download) plus preview byte-fetch failures (`onDownloadError`). A Move commit failure
  first passes the boundary: an authority failure closes the dialog and fails the
  session; anything else remains the dialog's in-place banner (403/412 policy verdicts).

### Cached data under production `staleTime: Infinity`

- Cache is a rendering optimization only. It may be served while `active` and not
  `authorityPending`, must be withheld during authority revalidation, and is deleted on
  any authority failure. Content mutations refresh listings through explicit
  invalidation; permission affordances are refreshed when Manage opens or a row menu
  resolves.

## 2. Grants / shares partial-failure independence

- `listGrants` and `listShares` are independent surfaces with independent failure modes.
- `GfsGrantList` renders grant rows and share rows as independent sections:
  - A grants-list error shows the grants banner (quiet for `manage_acl_required`) and
    suppresses grant rows only; share rows and their revoke actions still render.
  - A shares-list error shows the shares banner and suppresses share rows only; grant
    rows and their revoke actions still render.
  - The combined "Loading access…"/empty notices appear only when neither list errored.
- Neither source's failure may hide, disable, or suppress the other's rows or actions.

## 3. Paginated Move destination navigation

- The Move dialog browses the same session-scoped caches as the Files page
  (`gfsAccessible` at the root, `gfsChildren` inside folders).
- Both listings are cursor-paginated. Whenever the active listing reports a next page,
  a "Load more" control is visible; fetching the next page preserves the rows already
  rendered, shows pending state on the control, and surfaces fetch errors through the
  dialog's existing error banner.
- Destinations loaded from any page are selectable identically to page-one rows.
- Cycle prevention is unchanged: the moved resource itself never appears as a
  destination, and "Move here" stays disabled while the dialog path passes through the
  target's own subtree; a server 403/412 remains an in-dialog banner.

## Regression coverage map

| Decision                                                                                        | Tests                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Withhold cache during authority revalidation; purge + revoke on 401 (production query defaults) | `useGfsBrowserController.test.tsx` — "withholds cached GFS state … until discovery revalidates" / "fails closed … drops cached gfs state"      |
| Query + imperative + preview paths reach one boundary | `useGfsBrowserController.test.tsx` (mutation 401; `replaceFileFromPath` 401 under production defaults), `FilesPage.test.tsx` ("fails closed and closes previews/dialogs when authority is revoked") |
| FilesPage local UI cleared on revocation                                                        | `FilesPage.test.tsx` — previews/manage/move/rename/delete state                                                                                |
| Grants/shares independence                                                                      | `GfsGrantList.test.tsx` — "a share-list failure does not hide grants"                                                                          |
| Move pagination + page-two selection                                                            | `moveDialog.test.tsx` — root and child two-page listings                                                                                       |

Previous-buggy-head evidence: all new tests above fail on `93f211d08` (recorded in the R4
fix commit message).
