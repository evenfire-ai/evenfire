# Breadcrumb drop-move — implementation plan (Control UI)

**Sibling doc:** [`gfs-move-forbidden-ux-matrix.md`](./gfs-move-forbidden-ux-matrix.md) —
the deny-reason → message/visual matrix. This feature MUST reuse those treatments for
refused breadcrumb drops.

**HARD CONSTRAINT — NO BACKEND CHANGES.** The move PATCH, permission model, and policy
server contracts are frozen. Everything here is browser/renderer-side. Allowed areas:
`control-ui/**`, this plan document, and only surface-agnostic pure additions
to `packages/gfs-interaction-policy` if genuinely needed. Do **not** touch
`control-api`, `external-rest-api`, `gfs-controller`, `deploy/`, or any DB.

---

## 1. Feature

Users drag a file **or folder** from the listing onto a **breadcrumb crumb** — an
ancestor folder (e.g. `Product` while browsing `main › Product › live tests`) or the
drive root (`main`) — to move it there. Today the only upward-move path is the row ⋯
menu → Move dialog. Crumbs are plain buttons (`GfsBrowser.tsx`,
`cu-gfs-breadcrumb__button`) with no drag handlers, while rows already advertise
draggability ("Drag {name} into a folder to move it", `GfsBrowser.tsx:2372`).

## 2. Current state (receipts)

| Fact | Where |
|---|---|
| Breadcrumb = `<nav aria-label="Breadcrumb">` of per-crumb `<button>`s; click = `goToCrumb(index)`; active crumb carries `aria-current="page"`; only active crumb has ⋯ menu | `control-ui/components/GfsBrowser.tsx` (~line 2255) |
| Crumb model: `{ id, rid, gfsUri, name, version, isDriveRoot }`; drive root starts synthetic (`id === null`) then receives its real ID and RID from `TreePage.rootResourceId`; `isDriveRoot` remains true — `isDriveRootCrumb` | `GfsBrowser.tsx`, `Crumb`, `createDriveRootCrumb`, root hydration in `load` |
| Rows: `draggable`, native tooltip, per-row `onDrop` + container `onDrop` → `handleGfsDrop` | `GfsBrowser.tsx:2217, 2372, 2389` |
| Shared, browser-safe move policy (structure + authority + convergence) already consumed by both UIs | `packages/gfs-interaction-policy/dragPolicy.cjs` |
| Folder confirmation with numbered-name toggle + impact copy; Move dialog is a separate keyboard path | `control-ui/components/GfsMoveConfirmDialog/index.tsx`, `GfsMoveDialog/index.tsx` |
| Existing Control UI commit runner sends the listing version and bounds the 409 ladder; it does **not** re-resolve either endpoint or implement Desktop outcome verification | `GfsBrowser.tsx`, `moveResource` |
| Control UI has one local row drag ref and a blue target ID, **no** `hoverVerdict`, authority probes, cold-hover budget, gesture epochs, or reason-aware announcements | `handleResourceDragStart`, `handleFolderDragOver`, `handleFolderDrop` |
| Existing row files move directly; folder drops use one confirmation | `handleFolderDrop`, `GfsMoveConfirmDialog` |

## 3. Design

### 3.1 Drop targets and audit decisions (2026-10-23)
- Every crumb is a drop target: ancestors, the `main` drive root, and the active
  folder. Capture the physical source-parent ID at dragstart; active-crumb drops
  resolve to `same-parent`, with named “already in” info feedback and no PATCH.
- **Root question resolved:** use the hydrated root ID/RID (not null, a made-up ID,
  or an authority denial). It is a directory destination with canonical path `/`.
  If identity is not available yet, show `unavailable` and retry on drop. Control UI
  is the operator plane: authority is intrinsic, including at root. No affordance
  probe is necessary and no permission denial is fabricated.
- A visible crumb is an observed ancestor, not an unconditional ancestry proof:
  stream reconstruction or remote moves can change it. Re-resolve both captured
  endpoint identities before admission and again before drag commit; use fresh
  canonical paths with `decideDragPathStructure`. Missing paths defer structure to
  the atomic server guard; failed resolution prevents dispatch with honest feedback.

### 3.2 Extend the existing drag pipeline
- Crumb and row handlers share one admission function, one drag session/epoch,
  `confirmMoveTarget`, and `moveResource`; do not introduce a separate crumb runner.
- Hover uses cached observed IDs/paths and shared pure structure policy. No cold
  hover requests are needed for these operator listings, so a Desktop-style hover
  budget and its exhausted-budget scenario are inapplicable here. Unknown ancestry
  remains landable (`checking` / `server-check-required`), never a fake denial.
- Existing file-to-row drops keep moving directly. **Both files and folders dropped
  onto crumbs get one confirmation**, as requested. Extend the same confirmation
  with source kind for accurate file impact copy and accessible naming; keep the
  existing folder dialog name and copy. Keep numbered naming in that dialog.
- Drop checks have priority because they are the only network adjudication. A failed
  hover observation does not consume or disable drop-time checking.

### 3.3 Visual and messaging contract
- Paint `data-drop-state` and `data-drop-reason` on crumbs and rows. Only allowed
  targets get blue. Checking is neutral, unavailable warning, ordinary denials error,
  and `same-parent` neutral/info. Use the existing CSS tokens.
- Reuse the sibling matrix §3 wording by reason in an app-local browser-safe helper.
  Share hover announcements and drop refusal copy across row/crumb handlers. Hover
  announces through aria-live without toast spam; refused drops use the toast stack
  (which is itself live). Session loss also stays in a persistent page alert.
- Operator permission denies A6–A8 cannot be produced truthfully from local bits;
  cover their copy mapping in pure tests and surface server refusal honestly. Never
  manufacture missing bits to meet a test. Desktop parity remains out of scope.
- Keep native row tooltips and extend them to mention breadcrumbs.

### 3.4 Races and convergence
- Capture crumb ID/RID/URI/version into a destination value synchronously at drop.
  Stop propagation/default on internal crumb drops so the upload container cannot
  process them. Keep click/keyboard breadcrumb navigation intact.
- A monotonic gesture epoch supersedes pending admission/confirmation/commit reads.
  Dragend clears hover/source presentation but does not invalidate an accepted drop.
  A newer drag invalidates stale reads and confirmation. Unmount invalidates work.
- Immediately before dispatch, resolve **both endpoints by immutable URI**, validate
  returned identities and destination kind, and use the fresh source version. Do
  not consult a rebuilt trail for the destination (R7-M1). Check epoch after reads
  and immediately before every PATCH; already dispatched requests cannot be recalled.
- Preserve existing R5/R7 trail reconstruction. Use `planMoveConvergence` to invalidate
  observed old/new parent caches; refresh the live current location after a drag move,
  keeping the user there instead of navigating to the target. Do not claim a failed
  transport dispatch left the resource unchanged; report an unknown outcome.

## 4. Files to touch (allowlist)

| Area | Change |
|---|---|
| `control-ui/components/GfsBrowser.tsx` | crumb drag handlers, verdict state per crumb, drop wiring into existing commit path |
| `control-ui/app/globals.css` | `cu-gfs-breadcrumb__button` drop-state styles (`checking/allowed/denied/unavailable` + reason attribute) |
| `control-ui/e2e/run-gfs-drag-and-drop.mjs` + component tests | cases below |
| `packages/gfs-interaction-policy` | ONLY if a pure helper (e.g. root-target facts) is genuinely needed; no signature breaks |
| `control-ui/lib/gfsDragFeedback*` + colocated types/tests | reason/tone/announcement mapping |
| `control-ui/components/GfsMoveConfirmDialog/**` | source-kind-aware file confirmation |

Desktop Files and the sibling UX matrix document are owned by another task and must not be edited.

## 5. Test plan

- ☐ Drag `abac.md` onto `Product` crumb → confirm dialog shows "Move abac.md to
  Product?" → commit → listing refreshes; file gone from `live tests`, present in
  `Product`.
- ☐ Drag onto drive-root crumb `main` → moves to root (admin plane).
- ☐ Drag onto the ACTIVE crumb → info "already here", no error styling, no PATCH.
- ☐ Folder onto ancestor crumb (incl. a crumb above its own parent) → moves;
  descendant targets are impossible by construction (crumbs are ancestors) — assert no
  `descendant` case can trigger here.
- ☐ Structural refusal and same-parent info have reason attributes, correct styles,
  toasts and SR wording. Pure copy tests cover `destination-write`, `source-write`,
  and `source-delete`; operator hover never fabricates these permission denials.
- ☐ Unavailable endpoint → warning, no PATCH; a later drop retries resolution. No
  cold-hover budget exists in this operator surface (audit decision §3.2).
- ☐ Breadcrumb reconstruction mid-drag → drop commits against captured crumb identity;
  no mis-anchored trail (R5-M1/R7-M1 regression suite stays green).
- ☐ Keyboard/access: crumb buttons keep click-navigation; Move dialog unchanged as the
  keyboard path; verdicts announced via aria-live.
- ☐ Control UI production build + permission suites green; Desktop untouched in
  phase 1.

## 6. Acceptance criteria

1. From any listing row, a file or folder can be moved to any visible ancestor crumb
   (including root) with one confirmation — no ⋯ menu needed.
2. Every refused crumb drop explains WHY in plain language (matrix doc), visually and
   to SRs; nothing is silently ignored.
3. Zero changes outside the allowlist in §4; backend untouched (verifiable via
   `git diff --stat`).
4. All existing drag-and-drop suites (unit, component, property, Playwright spec)
   remain green; new cases in §5 pass.

## 7. Verification ownership

The runner `e2e/run-gfs-drag-and-drop.mjs` validates Playwright inventory; actual
journeys belong in `e2e/gfs-drag-and-drop.spec.ts`. Extend both so the gate requires
the new breadcrumb cases. Component tests own deferred-read/epoch and reconstruction
races. Live E2E requires configured owned endpoints and credentials; report it
separately from the production build and permission/unit suites.
