# EvenDrive move-forbidden UX — full case matrix

**Worktree:** `feat/even-drive-drag-and-drop-fix` · **Scope:** Desktop sidebar tree + Files
panel (Control UI parity noted where it differs)
**Sibling doc:** [`gfs-breadcrumb-drop-move.md`](./gfs-breadcrumb-drop-move.md) — breadcrumb drop targets; refused drops there MUST use this matrix for messaging.
**Goal:** every forbidden-move case tells the user WHAT happened and WHY — visually and
programmatically — instead of the current silent refusal.

**Audit baseline:** `966a3d647`, audited 2026-10-23 against the checked-out
sources. Line receipts below describe that baseline, before implementation.
The earlier live example is handoff evidence; this source audit did not access
or mutate the dev cluster.

---

## 1. Why it is silent today (receipts)

The deny **reason is computed and then thrown away** at the UI layer:

| Layer              | File                                                                          | What it does                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure decision | `packages/gfs-interaction-policy/dragPolicy.cjs` → `decideDragStructure`      | returns `{kind:'deny', reason:'self'│'cross-drive'│'root-source'│'same-parent'│'descendant'}` or `server-check-required`                                                                                             |
| Authority decision | `dragPolicy.cjs` → `decideDragAuthority`                                      | returns `{kind:'deny', reason:'destination-write'│'source-write'│'source-delete'}`, `checking`, `unavailable`, `observed-allowed`                                                                                    |
| Adjudication       | `desktop-app/ui/src/gfs/dragAdjudication.ts`                                  | maps probes/session loss to `session-lost`, `unavailable`, `target-unavailable`, `source-location-unknown`                                                                                                           |
| Paint              | `desktop-app/ui/src/components/SidebarNav/FileExplorerTree/index.tsx:314-315` | row gets `data-drop-state={allowed│denied│checking│unavailable}` — **reason collapsed to a boolean-ish state**                                                                                                       |
| Speech             | `desktop-app/ui/src/gfs/dropVerdict.ts:14-27` (RP-026)                        | generic only: _"You cannot move into {target}."_ — no reason                                                                                                                                                         |
| CSS                | `desktop-app/ui/src/styles.css:1987-2011`                                     | **Tree:** `denied` only de-emphasizes the label (1999) — nearly invisible. **Files grid:** `checking`/`allowed` styles exist; **`denied` has NO style at all** → this is the "no blue highlight and no idea why" bug |

`GfsDropVerdict` already carries denied/unavailable reasons in
`desktop-app/ui/src/gfs/dragSession.types.ts:61-65`. Both surfaces discard
them when storing only `verdict.state` (tree `:663-669`, FilesPage
`:1284-1287`). `moveDenialMessage` already exists in `moveCommit.ts:360`,
but its copy is generic and both callers toast every refusal as an error.
Self-hover is skipped entirely (tree `:650`, FilesPage `:1339`). Both use
`dropEffect=none` for denied hover (tree `:675`, FilesPage `:1364`), which
can prevent Chromium from delivering the refused drop at all.

**The two symptoms are:**

- Sidebar tree: `denied` ≈ invisible (label dimming only) → "nothing happens".
- Files panel: `allowed` paints the blue highlight; `denied` has no CSS → no highlight,
  no explanation.

Design rule already in the codebase (RP-026 header comment): _paint the verdict on the
row for sighted users, speak it for SR users_. The fix keeps that shape but carries the
**reason** through and adds a **persistent, readable explanation at drop time** (row
tints alone are too subtle to read a reason from).

---

## 2. The two-phase gate (when is a move forbidden?)

A move must pass BOTH phases. The reason shown must name the phase.

**Phase A — drag adjudication (before confirm):** structure check → authority check
(`decideDragAuthority`: needs `write` + `delete` on the **physical source parent** and
`write` on the destination; bits may be direct/inherited/team).
**Phase B — commit (after confirm):** server re-validates atomically (cycle/self guard,
destination kind, parent permissions) and executes the PATCH (with numbered-name ladder
on 409).

> Verified live example (dev cluster, 2026-10-23): dragging `live tests` → `Assets`
> fails Phase A with `source-write`/`source-delete` because `live tests`' physical
> parent is a nameless folder where the desktop user holds **zero** bits — even though
> the user holds ALL bits on both `live tests` and `Assets` themselves. `gfs_audit`
> shows **no mutation rows** → refused client-side, silently.

---

## 3. Phase-A matrix — every drag-time forbidden case

| #   | Reason (code)                                                    | Trigger — what the user did                                                               | Underlying rule                                                 | Sidebar tree feedback                                                                        | Files panel feedback  | Persistent message (drop)                                                                                                                                                                                                                                                                                                                                         | SR announcement                                |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A1  | `self`                                                           | Drop onto the dragged item itself                                                         | `dragPolicy.cjs:59`                                             | row `denied` + tooltip                                                                       | row `denied`          | Banner/toast: "You dropped {name} onto itself. Pick a destination folder."                                                                                                                                                                                                                                                                                        | "You cannot move {name} into itself."          |
| A2  | `cross-drive`                                                    | Drop across drives                                                                        | `dragPolicy.cjs:60`                                             | same as A1                                                                                   | same                  | "Moving between drives isn't supported."                                                                                                                                                                                                                                                                                                                          | same, spoken                                   |
| A3  | `root-source`                                                    | Source is the drive root (or virtual root item that is physically root)                   | `dragPolicy.cjs:61-62`                                          | show `denied` on targets when the source is observed to be root                              | same                  | "This location is the top level — it can't be moved."                                                                                                                                                                                                                                                                                                             | spoken                                         |
| A4  | `same-parent`                                                    | Target IS the physical parent (no-op move)                                                | `dragPolicy.cjs:64-65` + path form `:118`                       | row `denied`                                                                                 | row `denied`          | "{name} is already in {target}." — **NOT an error tone; info**. Critical with the flat sidebar: e.g. `Assets` physically lives in `Product`, so dragging Assets→Product is a no-op even though it _looks_ like a real move                                                                                                                                        | "{name} is already in {target}."               |
| A5  | `descendant`                                                     | Folder dropped into its own subtree                                                       | `dragPolicy.cjs:73`                                             | row `denied` on the whole subtree                                                            | row `denied`, no blue | "You can't move {name} into a folder inside itself."                                                                                                                                                                                                                                                                                                              | spoken                                         |
| A6  | `destination-write`                                              | No `write` on destination (e.g. read-only share)                                          | `dragPolicy.cjs:146` — checked FIRST (surface the user acts on) | row `denied` — this is the case where the blue highlight must NOT appear                     | row `denied`, no blue | "You don't have permission to move items into {target}. You need edit access to the destination folder."                                                                                                                                                                                                                                                          | spoken with reason                             |
| A7  | `source-write`                                                   | No `write` on the physical **source parent**                                              | `dragPolicy.cjs:147`                                            | row `denied`                                                                                 | row `denied`, no blue | "You can’t move {name} out of its current folder because you don’t have edit access to the folder that contains it."                                                                                                                                                                                                                                              | spoken                                         |
| A8  | `source-delete`                                                  | `write` but no `delete` on the source parent                                              | `dragPolicy.cjs:148`                                            | row `denied`                                                                                 | row `denied`, no blue | "You can’t move {name} out of its current folder because you don’t have delete access to the folder that contains it."                                                                                                                                                                                                                                            | spoken                                         |
| A9  | `checking`                                                       | Bits not yet known (cold hover)                                                           | `dragPolicy.cjs:140`                                            | neutral spinner-tint row                                                                     | neutral               | none (transient)                                                                                                                                                                                                                                                                                                                                                  | "Checking whether you can move into {target}…" |
| A10 | `unavailable` / `target-unavailable` / `source-location-unknown` | Required drop probe failed (network/5xx/429/404); exhausted hover budget stays `checking` | `dragAdjudication.ts:58-98`                                     | failed cold hover currently remains `checking`; any `unavailable` paint must NOT look denied | row `unavailable`     | "EvenDrive couldn’t verify this move. Check your connection and try again." For target disappearance: "This folder is no longer available." For an unknown source location: "EvenDrive cannot verify this item’s current location. Refresh and try again." Drop checks remain available after inconclusive hover; a failed required drop check refuses admission. | spoken                                         |
| A11 | `session-lost`                                                   | 401 during probe                                                                          | `dragAdjudication.ts:58`                                        | gesture ends; re-auth prompt                                                                 | same                  | "Your session ended. Sign in again to continue moving files." (session revoked per med-probe-401)                                                                                                                                                                                                                                                                 | spoken                                         |
| A12 | `server-check-required`                                          | Ancestry unproved (grants start below root)                                               | `dragPolicy.cjs:82`                                             | row `checking` — NOT denied; stays landable                                                  | neutral               | none at hover; drop proceeds to server verdict (Phase B)                                                                                                                                                                                                                                                                                                          | "Checking…"                                    |

---

## 4. Phase-B matrix — commit-time outcomes (after "Move" confirm)

Source of truth: `desktop-app/ui/src/gfs/moveCommit.ts`
`commitGfsMove` (`:132`), `toastMoveOutcome` (`:323`) and
`desktop-app/ui/src/gfs/moveCommitRunner.ts` `runGfsMoveCommit` (`:63`).
There is no `presentMoveCommitOutcome` symbol. The table records the required
user-facing semantics; the notes distinguish existing behavior and safe copy
limits from proposed improvements.

| #   | Outcome                                                        | Trigger                    | Message (toast)                                                                                                                                                                                                                                             | Tone                                       |
| --- | -------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| B1  | `committed` (+ optional `renamedTo`)                           | PATCH 200                  | "Moved {source} to {destination}." / "…as {renamed}."                                                                                                                                                                                                       | success                                    |
| B2  | numbered-name conflict resolved                                | 409 → ladder accepted      | same as B1 with "as {renamed}"                                                                                                                                                                                                                              | success                                    |
| B3  | conflict ladder exhausted                                      | 409 × N > limit            | Existing bounded-ladder result: "The destination changed. Refresh it or choose another folder." Without rename consent: choose another folder or use Move to rename if permitted.                                                                           | error                                      |
| B4  | source vanished (404 on source re-resolve/dispatch)            | rp-027                     | "EvenDrive cannot verify this item’s current location. Refresh and try again." (404 may also mean hidden; do not claim deletion.)                                                                                                                           | error                                      |
| B5  | destination vanished (404 on destination)                      | rp-027                     | "This folder is no longer available." (source re-resolve distinguishes the sides; do not claim deletion.)                                                                                                                                                   | error                                      |
| B6  | server structural deny (cycle/kind/parent-permission re-check) | PATCH 403/400              | 400: "The server rejected this destination. Refresh and choose a different folder." 403 (implemented): "EvenDrive could not confirm permission for this move. Refresh and try again." — never names a parent bit without fresh proof, never raw HTTP prose. | 403 → warn (unknown outcome); 400 → error  |
| B7  | transport loss, outcome unknown                                | fetch threw after dispatch | Existing verification resolves by identity once → B1 or "Couldn’t confirm the move. Refresh before trying again." Do not repeat PATCH. An in-progress notice may precede this verification.                                                                 | warn when unconfirmed; success if verified |
| B8  | 5xx                                                            | server error               | Verify by identity → B1 or "Couldn’t confirm the move. Refresh before trying again." A 5xx does not prove nothing changed.                                                                                                                                  | warn when unconfirmed; success if verified |

> Tone baseline (implemented in `toastMoveOutcome`): the unknown-outcome
> statuses — `unconfirmed` (B6-403/B7/B8) and `rate-limited` — present as
> `warn`, because an unconfirmed move has not been shown to fail; every
> definite negative (B3/B4/B5, B6-400) stays `error`. Dispatch, retry and
> verification safety are unchanged.
> | B9 | `session-lost` | 401 at commit | Persistent revoked-session surface: "Your session ended. Sign in again to continue moving files." Do not claim a dispatched move failed if its outcome is unknown. | error |
> | B10 | user stopped / canceled dialog | Stop / Esc / backdrop | silent or "Move canceled." (per PR's stop-notice pattern) | info |

---

## 5. Visual spec (what to change)

1. **Carry the reason**: preserve the existing `GfsDropVerdict.reason` instead of storing only its state;
   `data-drop-reason` attribute next to `data-drop-state` (FileExplorerTree:315, grid
   rows). Tests in `dropVerdict`/RP-026 keep their one-wording-per-verdict contract by
   keying on reason, not surface. Add a shared browser-safe presenter for message and tone; reuse it for hover tooltips, SR and refused drops.
2. **Give `denied` a real treatment in BOTH surfaces** (today: tree = label dim only,
   grid = nothing):
   - Tree row + grid row: red/neutral inset border and background tint; retain readable labels and existing source-opacity treatment.
   - **Do NOT** use error-red for `same-parent` (A4: info) or `unavailable` (A10:
     warning) — reasons map to tones: deny=error, no-op=info, unknown=warning.
3. **Drop-time persistent message**: keep internal directory drops deliverable
   (`preventDefault`, `dropEffect='move'`) even for observed denial, so release
   can present the reason. Admission still refuses the mutation. Remove the
   self-hover early return so self drops also paint and explain their reason.
   On a refused DROP, show the reason message from
   the matrix as a toast (reuse the application `pushToast` stack) or the
   `StatusBanner` component — banners for `session-lost` (persistent), toasts for
   one-shot denies. Hover-time stays row-tint-only (no toast spam while dragging over
   many rows).
4. **SR**: extend `gfsDropVerdictAnnouncement(state, target)` →
   `(state, target, reason, sourceName?)`; on drop, announce the full reason sentence (RP-026
   contract: same wording per reason on every surface).
5. **Blue highlight rule stays**: only `observed-allowed` paints blue;
   `checking` is neutral, and unknown/unavailable uses warning tokens. The fix is not to show blue more — it's to SAY WHY when it isn't blue.

## 6. Plain-language copy rules (match PR's existing tooltip style)

- Name the **missing access**, not the bit: "edit access" = write, "delete access" =
  delete. Never "source-parent-write".
- Distinguish the **three places** a move touches: the item, the folder it leaves, the
  folder it enters. A7/A8 messages must mention "the folder that contains it".
- No-op moves (A4) get info tone + "already there", never "cannot".
- Unknown (A10) never implies forbidden — say "couldn't verify, try again".

## 7. Implementation and verification handoff

Frontend-only: implement Desktop tree + Files grid feedback; leave Control UI
breadcrumb work and `docs/design/gfs-breadcrumb-drop-move.md` to their owner.
No backend, deployment, or server-contract edits. Read `AGENTS.md`,
`desktop-app/ui/AGENTS.md` and its referenced style documents first.

Use Node 24.22.1 (`/home/pal/.nvm/versions/node/v24.22.1/bin`) and prefix
**every npm invocation** with `UV_USE_IO_URING=0`. Before counting Desktop
validation, verify `node --version` and `npm run verify:electron`. Required:
Desktop `npm run build` (main + renderer), Desktop `npm test`; Control UI
`npm run build` only if its parity surface changes. Cover reason retention,
state-to-reason changes, no-op info tone, missing source/destination access,
self/descendant, unknown warning and the browser drop-delivery contract with
focused regression tests. Preserve session/gesture ownership checks and
cold-hover network budgets. Keep session loss visible even when revocation
invalidates the gesture before the normal drop callback resumes.

Commit only owned paths in logical conventional commits. Do not stage
`control-ui/next-env.d.ts`, `profile-ui/next-env.d.ts`, generated output or
`desktop-app/package.json` churn. The checkbox reset is preserved separately
in `bf469d7d8`. Other agents may commit on this same branch; never reset or
amend their work. Report tests, commit IDs and any unresolved limitation to
the supervisor for review before push.

### Desktop implementation baseline (2026-10-23, local commits)

Implemented in `desktop-app/ui` only: the shared presenter
`src/gfs/dropVerdict.ts` (+ `dropVerdict.types.ts`) owns tone, sentences,
announcements and the drop-refusal presentation; the tree and the Files grid
carry the full verdict (`data-drop-state` + `data-drop-reason`), keep denied
internal hovers deliverable, gate the session-ended banner by the captured
scope/session identity, and render the session-ended sentence on the revoked
surfaces themselves. Grid tone tints are grid-scoped in `src/styles.css` so
they out-rank the row base and hover backgrounds (guarded by
`src/pages/__tests__/gfsDropTintCascade.test.ts`). Covered by focused unit
regressions: reason retention, same-state reason changes, no-op info tone,
missing source/destination access, self/descendant/root-source, unknown
warning, denied drop-delivery without mutation, SR announcements, and both
cross-surface tooltip directions. No live-cluster lane was run for this
baseline; the manual matrix below remains unchecked until it is.

## 8. Manual test matrix (maps to your PR checklist lane 1/3)

Not executed against a live cluster yet — unit-regression coverage for A1/A3–A8
and A10 exists (see §7); the checkboxes stay open until the manual lane runs.

- ☐ A4 drag `Assets` onto `Product` (physically already inside) → info "already there", NOT red
- ☐ A7 drag `live tests` onto any folder → refused drop + toast naming "the folder that contains it"
- ☐ A6 read-only destination share → no blue, reason names destination
- ☐ A5 folder into own subfolder → refusal names self-containment
- ☐ A10 kill network mid-hover → warning tone, drop still attempts
- ☐ B4/B5 vanish source/destination via second user → distinct messages
- ☐ B7 drop during network cut → "checking whether it completed", then converge
- ☐ SR: every refused drop announces reason; sighted: every denied row readable
  (row tints, incl. hovered grid rows, verified by the cascade guard unit test)
