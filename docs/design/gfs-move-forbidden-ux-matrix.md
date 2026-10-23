# EvenDrive move-forbidden UX — full case matrix

**Worktree:** `feat/even-drive-drag-and-drop-fix` · **Scope:** Desktop sidebar tree + Files
panel (Control UI parity noted where it differs)
**Sibling doc:** [`gfs-breadcrumb-drop-move.md`](./gfs-breadcrumb-drop-move.md) — breadcrumb drop targets; refused drops there MUST use this matrix for messaging.
**Goal:** every forbidden-move case tells the user WHAT happened and WHY — visually and
programmatically — instead of the current silent refusal.

---

## 1. Why it is silent today (receipts)

The deny **reason is computed and then thrown away** at the UI layer:

| Layer | File | What it does |
|---|---|---|
| Structure decision | `packages/gfs-interaction-policy/dragPolicy.cjs` → `decideDragStructure` | returns `{kind:'deny', reason:'self'│'cross-drive'│'root-source'│'same-parent'│'descendant'}` or `server-check-required` |
| Authority decision | `dragPolicy.cjs` → `decideDragAuthority` | returns `{kind:'deny', reason:'destination-write'│'source-write'│'source-delete'}`, `checking`, `unavailable`, `observed-allowed` |
| Adjudication | `desktop-app/ui/src/gfs/dragAdjudication.ts` | maps probes/session loss to `session-lost`, `unavailable`, `target-unavailable`, `source-location-unknown` |
| Paint | `FileExplorerTree/index.tsx:314` | row gets `data-drop-state={allowed│denied│checking│unavailable}` — **reason collapsed to a boolean-ish state** |
| Speech | `dropVerdict.ts` (RP-026) | generic only: *"You cannot move into {target}."* — no reason |
| CSS | `styles.css:1987-2010` | **Tree:** `denied` only de-emphasizes the label (1999) — nearly invisible. **Files grid:** `checking`/`allowed` styles exist; **`denied` has NO style at all** → this is the "no blue highlight and no idea why" bug |

**The two symptoms you hit are exactly this:**
- Sidebar tree: `denied` ≈ invisible (label dimming only) → "nothing happens".
- Files panel: `allowed` paints the blue highlight; `denied` has no CSS → no highlight,
  no explanation.

Design rule already in the codebase (RP-026 header comment): *paint the verdict on the
row for sighted users, speak it for SR users*. The fix keeps that shape but carries the
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

| # | Reason (code) | Trigger — what the user did | Underlying rule | Sidebar tree feedback | Files panel feedback | Persistent message (drop) | SR announcement |
|---|---|---|---|---|---|---|---|
| A1 | `self` | Drop onto the dragged item itself | `dragPolicy.cjs:73` | row `denied` + tooltip | row `denied` | Banner/toast: "You dropped {name} onto itself. Pick a destination folder." | "You cannot move {name} into itself." |
| A2 | `cross-drive` | Drop across drives | `dragPolicy.cjs:76` | same as A1 | same | "Moving between drives isn't supported." | same, spoken |
| A3 | `root-source` | Source is the drive root (or virtual root item that is physically root) | `dragPolicy.cjs:79` | refused at dragstart: don't start a session, or show `denied` on all targets | same | "This location is the top level — it can't be moved." | spoken |
| A4 | `same-parent` | Target IS the physical parent (no-op move) | `dragPolicy.cjs:84` + path form `:118` | row `denied` | row `denied` | "{name} is already in {target}." — **NOT an error tone; info**. Critical with the flat sidebar: e.g. `Assets` physically lives in `Product`, so dragging Assets→Product is a no-op even though it *looks* like a real move | "{name} is already in {target}." |
| A5 | `descendant` | Folder dropped into its own subtree | `dragPolicy.cjs:92` | row `denied` on the whole subtree | highlight suppressed | "You can't move {name} into a folder inside itself." | spoken |
| A6 | `destination-write` | No `write` on destination (e.g. read-only share) | `dragPolicy.cjs:146` — checked FIRST (surface the user acts on) | row `denied` — this is the case where the blue highlight must NOT appear | row `denied`, no blue | "You don't have permission to move items into {target}. You need edit access to the destination folder." | spoken with reason |
| A7 | `source-write` | No `write` on the physical **source parent** | `dragPolicy.cjs:147` | row `denied` | row `denied`, no blue | "You can move {name} within places you manage, but not out of its current folder — you don't have edit access to the folder that contains it." | spoken |
| A8 | `source-delete` | `write` but no `delete` on the source parent | `dragPolicy.cjs:148` | row `denied` | row `denied`, no blue | "Removing {name} from its current folder needs delete access there. You have edit, but not delete." | spoken |
| A9 | `checking` | Bits not yet known (cold hover) | `dragPolicy.cjs:140` | neutral spinner-tint row | neutral | none (transient) | "Checking whether you can move into {target}…" |
| A10 | `unavailable` / `target-unavailable` / `source-location-unknown` | Probe failed (network/5xx); hover budget exhausted | `dragAdjudication.ts:58-98` | row `unavailable` — must NOT look denied | row `unavailable` | "EvenDrive couldn't verify the move just now. Check your connection and try again — the move is still allowed on drop." (drop-time check remains available by contract) | spoken |
| A11 | `session-lost` | 401 during probe | `dragAdjudication.ts:58` | gesture ends; re-auth prompt | same | "Your session ended. Sign in again to continue moving files." (session revoked per med-probe-401) | spoken |
| A12 | `server-check-required` | Ancestry unproved (grants start below root) | `dragPolicy.cjs:121` | row `checking` — NOT denied; stays landable | neutral | none at hover; drop proceeds to server verdict (Phase B) | "Checking…" |

---

## 4. Phase-B matrix — commit-time outcomes (after "Move" confirm)

Source of truth: `moveCommit.ts` `presentMoveCommitOutcome` (rev-2 §8 toasts) +
`dragAdjudication.ts` verdict reasons.

| # | Outcome | Trigger | Message (toast) | Tone |
|---|---|---|---|---|
| B1 | `committed` (+ optional `renamedTo`) | PATCH 200 | "Moved {source} to {destination}." / "…as {renamed}." | success |
| B2 | numbered-name conflict resolved | 409 → ladder accepted | same as B1 with "as {renamed}" | success |
| B3 | conflict ladder exhausted | 409 × N > limit | "A name collision couldn't be resolved for {source} in {destination}. Try renaming first." | error |
| B4 | source vanished (404 on source re-resolve/dispatch) | rp-027 | "{source} no longer exists — it may have been deleted or moved by someone else." | error |
| B5 | destination vanished (404 on destination) | rp-027 | "The destination folder no longer exists." | error |
| B6 | server structural deny (cycle/kind/parent-permission re-check) | PATCH 403/400 | distinct copy per status; if parent-permission: same wording as A7/A8 + "the change was not made" | error |
| B7 | transport loss, outcome unknown | fetch threw after dispatch | "The connection dropped while moving {source}. EvenDrive is checking whether the move completed…" then verify-by-identity → converge to B1 or "couldn't confirm; refresh Files" | warning→info |
| B8 | 5xx | server error | "EvenDrive couldn't complete the move. Nothing was changed. Try again." | error |
| B9 | `session-lost` | 401 at commit | "Your session ended. Sign in again — the move was not completed." | error |
| B10 | user stopped / canceled dialog | Stop / Esc / backdrop | silent or "Move canceled." (per PR's stop-notice pattern) | info |

---

## 5. Visual spec (what to change)

1. **Carry the reason**: extend `GfsDropVerdict` (dragSession.types) with `reason`;
   `data-drop-reason` attribute next to `data-drop-state` (FileExplorerTree:314, grid
   rows). Tests in `dropVerdict`/RP-026 keep their one-wording-per-verdict contract by
   keying on reason, not surface.
2. **Give `denied` a real treatment in BOTH surfaces** (today: tree = label dim only,
   grid = nothing):
   - Tree row + grid row: red/neutral border tint (match existing `allowed` blue
     treatment, not-blue), reduced-opacity drag ghost.
   - **Do NOT** use error-red for `same-parent` (A4: info) or `unavailable` (A10:
     warning) — reasons map to tones: deny=error, no-op=info, unknown=warning.
3. **Drop-time persistent message**: on a refused DROP, show the reason message from
   the matrix as a toast (reuse `pushToast` from `presentMoveCommitOutcome`) or the
   `StatusBanner` component — banners for `session-lost` (persistent), toasts for
   one-shot denies. Hover-time stays row-tint-only (no toast spam while dragging over
   many rows).
4. **SR**: extend `gfsDropVerdictAnnouncement(state, target)` →
   `(state, target, reason)`; on drop, announce the full reason sentence (RP-026
   contract: same wording per reason on every surface).
5. **Blue highlight rule stays**: only `observed-allowed` (and `checking`→neutral)
   paints blue. The fix is not to show blue more — it's to SAY WHY when it isn't blue.

## 6. Plain-language copy rules (match PR's existing tooltip style)

- Name the **missing access**, not the bit: "edit access" = write, "delete access" =
  delete. Never "source-parent-write".
- Distinguish the **three places** a move touches: the item, the folder it leaves, the
  folder it enters. A7/A8 messages must mention "the folder that contains it".
- No-op moves (A4) get info tone + "already there", never "cannot".
- Unknown (A10) never implies forbidden — say "couldn't verify, try again".

## 7. Manual test matrix (maps to your PR checklist lane 1/3)

- ☐ A4 drag `Assets` onto `Product` (physically already inside) → info "already there", NOT red
- ☐ A7 drag `live tests` onto any folder → refused drop + banner naming "the folder that contains it"
- ☐ A6 read-only destination share → no blue, reason names destination
- ☐ A5 folder into own subfolder → refusal names self-containment
- ☐ A10 kill network mid-hover → warning tone, drop still attempts
- ☐ B4/B5 vanish source/destination via second user → distinct messages
- ☐ B7 drop during network cut → "checking whether it completed", then converge
- ☐ SR: every refused drop announces reason; sighted: every denied row readable
