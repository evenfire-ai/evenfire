# Breadcrumb drop-move — implementation plan (Control UI, Desktop parity phase 2)

**Sibling doc:** [`gfs-move-forbidden-ux-matrix.md`](./gfs-move-forbidden-ux-matrix.md) —
the deny-reason → message/visual matrix. This feature MUST reuse those treatments for
refused breadcrumb drops.

**HARD CONSTRAINT — NO BACKEND CHANGES.** The move PATCH, permission model, and policy
server contracts are frozen. Everything here is browser/renderer-side. Allowed areas:
`control-ui/**`, `desktop-app/ui/**` (phase 2), and only surface-agnostic pure additions
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
| Crumb model: `{ id, rid, gfsUri, name, version, isDriveRoot }`; drive root is synthetic (`id === null`) — `isDriveRootCrumb` | `GfsBrowser.tsx:141-149` |
| Rows: `draggable`, native tooltip, per-row `onDrop` + container `onDrop` → `handleGfsDrop` | `GfsBrowser.tsx:2217, 2372, 2389` |
| Shared, browser-safe move policy (structure + authority + convergence) already consumed by both UIs | `packages/gfs-interaction-policy/dragPolicy.cjs` |
| One-confirmation move flow with numbered-name toggle + impact copy | `control-ui/components/GfsMoveConfirmDialog/index.tsx`, `GfsMoveDialog/index.tsx` |
| Commit runner re-resolves source, sends version, bounded 409 ladder, honest unknown-outcome handling | `desktop-app/ui/src/gfs/moveCommit.ts` pattern; Control UI equivalent in its drop commit path |

## 3. Design

### 3.1 Drop targets
- **Every crumb** becomes a drop target: all ancestor crumbs **and the drive-root
  crumb** (`main`). The **active crumb** is also a target but always resolves to
  `same-parent` (policy `dragPolicy.cjs:84/118`) → info-level "already here" (matrix
  doc §3 A4), never error styling.
- Root crumb (`id === null`): root can never be inside the source's subtree, so the
  structural decision is trivially safe; treat as a normal directory target whose
  identity is the drive root. Authority: use the drive-root affordances if the session
  exposes them; in the admin plane the operator is intrinsic (all bits) so the drop
  proceeds. For non-operator desktop parity (phase 2), admit the drop and let the
  server be the authority (`server-check-required` semantics) — never fake a deny.

### 3.2 Reuse the existing drag pipeline (do not fork it)
- Crumbs join the **same drag session**: `dragstart` on rows already publishes source
  facts; crumbs register as targets with `dragover` (preventDefault + verdict request),
  `dragleave`, `drop`.
- Hover: request the same adjudication (`hoverVerdict`) — shared cold-hover budget,
  cached/canceled checks cost nothing; verdict states `checking │ allowed │ denied │
  unavailable` painted on the crumb via `data-drop-state` (+ `data-drop-reason` per the
  matrix doc's implementation notes).
- Drop: same drop-time adjudication (priority check; ownership epoch captured; stale
  gestures cannot commit). Then the **same** confirm dialog + commit runner as row
  drops — one confirmation, numbered-name suggestion on conflict.

### 3.3 Visual + copy
- Allowed crumb: blue tint (same treatment as `allowed` rows). Denied crumb: never
  blue; on refused drop surface the reason message from the matrix doc (§3 A1–A12) —
  toast, correct tone (error / info for `same-parent` / warning for `unavailable`).
- SR: announce verdict with reason on the crumb (same one-wording-per-reason contract
  as RP-026; Control UI equivalent of `gfsDropVerdictAnnouncement`).
- Keep the native row tooltip; optionally extend it: "Drag {name} into a folder or the
  breadcrumb to move it".

### 3.4 Races and gotchas (each already bit this PR once)
- **Crumb click vs drop:** `dragover` must `preventDefault()`; `drop` must
  `preventDefault()` + `stopPropagation()` so the container-level `onDrop`
  (`GfsBrowser.tsx:2217`) doesn't double-handle; clicks don't fire after a drop, but
  verify no navigation happens on `mouseup` during drag.
- **Breadcrumb reconstruction race (R7-M1):** capture the crumb's identity
  (`id`/`rid`/`gfsUri`/`version`) at drop time, not the live trail; a late trail
  rebuild must not re-anchor an in-flight commit. The commit runner's pre-dispatch
  re-resolve must resolve the **target** too, not only the source.
- **Ownership epochs:** dropping on a crumb is a normal drop — the same gesture-epoch
  guard applies (a newer gesture supersedes stale work; dragend must not cancel the
  drop's own adjudication).
- **After commit:** reuse `planMoveConvergence` (old + new parent child-listing
  refetch). The user stays in the current folder; the moved item disappears from the
  listing. No auto-navigation.

## 4. Files to touch (allowlist)

| Area | Change |
|---|---|
| `control-ui/components/GfsBrowser.tsx` | crumb drag handlers, verdict state per crumb, drop wiring into existing commit path |
| `control-ui/app/globals.css` | `cu-gfs-breadcrumb__button` drop-state styles (`checking/allowed/denied/unavailable` + reason attribute) |
| `control-ui/e2e/run-gfs-drag-and-drop.mjs` + component tests | cases below |
| `packages/gfs-interaction-policy` | ONLY if a pure helper (e.g. root-target facts) is genuinely needed; no signature breaks |
| Phase 2: `desktop-app/ui/src/pages/FilesPage.tsx` + `styles.css` | Desktop Files breadcrumb parity (`aria-label="Breadcrumb"` exists there today) |

## 5. Test plan

- ☐ Drag `abac.md` onto `Product` crumb → confirm dialog shows "Move abac.md to
  Product?" → commit → listing refreshes; file gone from `live tests`, present in
  `Product`.
- ☐ Drag onto drive-root crumb `main` → moves to root (admin plane).
- ☐ Drag onto the ACTIVE crumb → info "already here", no error styling, no PATCH.
- ☐ Folder onto ancestor crumb (incl. a crumb above its own parent) → moves;
  descendant targets are impossible by construction (crumbs are ancestors) — assert no
  `descendant` case can trigger here.
- ☐ Denied reasons per matrix doc: `destination-write` / `source-write` / /
  `source-delete` → crumb not blue, refused drop shows the reason message + SR
  announcement.
- ☐ Hover budget exhausted → crumb shows `unavailable`; drop still runs the drop-time
  check.
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
