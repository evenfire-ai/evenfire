# Removing "Context" from the Control UI — Implementation Run

## 0. Agent handoff brief (read this first if you are an AI agent picking this up)

**What this is:** the k8s Context resource was removed from all user-facing control-ui surfaces. **Frontend-only** — the wire contract is frozen (`contextRef`, `contextIds`, `mcpServers`, `security.allowContextRef`, all `/api/v1/admin/*` payloads byte-identical). Never "fix" anything by changing control-api, charts, CRDs, or payload shapes; required backend changes get documented in §3, and that list is empty.

**The mental model (one line):** connectors are granted to *agents*; the private per-agent scope (a Context on the wire) is invisible plumbing; users/teams get "Access" tabs whose rows resolve to agent names.

**Flow map (high level):**
- **Legacy links** `/contexts/*` → client resolver (`app/contexts/[[...slug]]/page.tsx`) → owning agent's Connectors tab, else `/agents` (§6.3).
- **Agent connectors** — agent detail ▸ Connectors tab is the only context writer; additive PUTs with `resourceVersion` (§4; spec-preservation contract re-homed in `HostDetailsPage.connectors.test.tsx`).
- **Connector access** — `/connectors` expanded row: Agents group (write: per-agent remove, shared-scope confirm, "Add agents" modal), Teams/Users read-only; orphan scopes invisible (§5.1).
- **Create connector** — Connector ▸ *Access* (optional agents) ▸ Secrets; no agents ⇒ silent private scope (CRD requires `spec.contextRef`) (§5.3).
- **Marketplace install** — Package ▸ Credentials ▸ Install; silent private scope per install via `lib/privateContext.ts`; grant agents afterwards (§5.4, decision D3).
- **Users & Teams Access** — tabs renamed `access`; labels resolved by `lib/accessScopeLabels.ts` (owners → displayName → muted raw id); deleted scopes render as "Removed access" tombstones (§7).
- **Peripheral** — SFS "Mounted by" resolves agents; recipe banner says "connector scope"; budget chip "Connector scope" (§8).

**Key files:** `lib/privateContext.ts`, `lib/accessScopeLabels.ts`, `lib/agentContext.ts`, `app/mcp-servers/page.tsx` (bindings+targets), `components/McpServerTable.*`, `components/CreateMcpServerForm/`, `components/RegistryInstallForm/`, `app/hosts/[name]/page.tsx`, `app/profile-admin/{users,teams}/[id]/page.tsx`, `next.config.js` (legacy redirects).

**Test/evidence assets:** main e2e catalog in `tests/e2e/playwright/control-ui/` (+ `helpers/api-client.ts` seeding, `tsconfig.typecheck.json` gate); qa-recorder video journeys in `control-ui/e2e/qa-recorder-*.spec.ts` (run via `npm run qa:recorder:<name>`, videos under `.local-notes/qa-recorder/runs/control-ui/`, MP4 via `npm run qa:recorder:convert-mp4`). Mock backend for UI e2e without a cluster: `scripts/qa-recorder/mock-control-api.mjs` (any credentials; evidence produced against it is mock-backed UI e2e, never a T2 verdict).

**Live status (see §10 tail for the authoritative log):** phases 0–4 + audit complete and committed; unit suite 1701/1701; 37 recorder journeys green with video evidence preserved in `.local-notes/qa-recorder/evidence-final/`; 2 core journeys (marketplace-install, recipe-scope-copy) were environment-killed mid-run and are re-queued; pre-existing journeys needing real cluster depth (rotation, cost, llm-lifecycle, invitations, gfs) fail against the mock by design.

**Hard rules:** don't break the §2 guardrails (wire frozen, additive-spec, redirect-don't-strand, resolve-labels-client-side); the §2.5 exclusion list is exhaustive — "context window", `may_add_context`, "User context" (USER.md), kubectl `--context`, `host-context-controller`, wire keys, internal identifiers are NOT leaks. Diff hygiene: always diff against base `a584c259a` (`origin/dev` moves under us).

**Status:** Implemented on branch `feat/context-removal` (phases 0–4 complete, post-implementation audit clean — §11). This document is the source of truth for the change; the progress log in §10 is append-only history, and §12 is the full click-by-click manual test walkthrough.
**Branch:** `feat/context-removal` (base: `origin/dev` @ `a584c259a`, which includes `feat/ux-improvements-29`).
**Scope:** `control-ui/**` only. **No backend, CRD, or API-contract changes.** Every existing API call keeps its exact endpoint, payload, and field names.
**Audience:** Engineers executing/reviewing the change, and human testers validating it (start at §1, then §12).

---

## 1. What a tester needs to know in 60 seconds

**Before:** the Control UI had a first-class "Contexts" section (list / create / detail pages, sidebar entry). Connectors were granted to agents *through* contexts, members/teams got "Contexts" tabs, and several flows forced the user to pick a "Context" by its raw slug.

**After:** the word "Context" never appears in the UI. What the user manages instead:

| Old concept (gone) | New user-facing concept | Where it lives now |
| --- | --- | --- |
| Contexts section (list/create/detail) | **Nothing.** Auto-generated per-agent private contexts are an implementation detail | `/agents` (agent detail ▸ Connectors tab) |
| Connector "Context" bindings | **Agent access** — "which agents can use this connector" | `/connectors` (expand a row) and connector edit ▸ Access tab |
| Registry install "Context" step | **Removed** — a private context is silently created per install | `/marketplace/install` and the install modal |
| Create-connector "Context" step | **"Access" step** — optional picker of *agents* | `/connectors/new` |
| Member/team "Contexts" tabs | **"Access" tabs** — same mappings, labels resolved to agent names | Users & Teams ▸ member/team detail |
| Team wizard "Contexts" step | **"Access" step** — same write, agent-resolved labels | Users & Teams ▸ Teams ▸ New |

**Nothing changes on the wire**: same endpoints, same payloads (`contextRef`, `contextIds`, `mcpServers`, `security.allowContextRef`, …). The k8s Context resource still exists and is still written by the frontend — it is just never *shown*.

Old `/contexts/*` bookmarks are redirected (see §6.3), not 404'd. For the full click-by-click validation walkthrough, go to **§12**.

---

## 2. Guardrails (frontend-only contract)

1. **Wire format frozen.** `lib/api.ts` context functions, payload shapes, and internal keys are untouched. Only labels, copy, routes, and component composition change.
2. **Additive-spec discipline preserved.** Every context `PUT` still goes through `buildContextUpdatePayload()` with the loaded `resourceVersion`; unknown spec fields (e.g. `spec.gfs`) still survive edits. The spec-preservation contract tests were re-homed (see §7.3).
3. **Redirect, don't strand.** Every removed route shape has a redirect (§6.3).
4. **Labels resolved client-side.** Private contexts are displayed via the owning agent (`host.spec.contextRef` join); fallback chain: owning agent(s) → `spec.displayName` → raw id (muted).
5. **Out-of-scope "context" words stay** (complete list, re-verified by the §11 audit):
   - LLM "context window" (`context_window_tokens`, model forms/tables/discovery).
   - Guardrail hook permission "May add context" (`may_add_context`) — prompt context injected into tool calls.
   - LLM prompt "User context" / `## User Context` (USER.md background in the agent Identity tab).
   - React contexts (`AuthContext`, `ThemeContext`, `ToastContext`, …) and `context: { params }` route-handler signatures.
   - Wire-format identifiers: `spec.contextRef`, `contextIds`, `security.allowContextRef`, `mountedByContexts`, and `contextRef` prose inside recipe manifest templates (JSON the user edits is wire format).
   - `kubectl --context=<name>` flags in recipe-status debug hints (kubeconfig syntax, standard kubectl meaning).
   - The `host-context-controller` service label in trace filters (real infra service name, HCC).
   - Raw-scope-id fallback labels (muted, last resort) when neither an owning agent nor a `displayName` resolves — see §2.4.
   - Intentional legacy redirects in `next.config.js` (invisible plumbing for old bookmarks).
   - Internal code identifiers (function/variable/type names such as `agentContext`, `getContexts`, `contextResources`) and code comments.
6. **No half-states.** Within a phase a screen is either fully old-vocabulary or fully new-vocabulary.

## 3. Product decisions (locked for this run)

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Deep links `/contexts/*` | Redirect: private slug → owning agent's Connectors tab (resolved client-side); unknown slug or `/contexts`, `/contexts/new` → `/agents` |
| D2 | Standalone shared contexts | **Do not survive** as a user-facing concept. Every context is an implementation detail of exactly one agent or one install. The `/contexts` section is deleted |
| D3 | Registry install binding | **Silent private context per install** (HostWizard pattern). No user input, payload unchanged (`contextRef` still sent) |
| D4 | Access model naming | Users/teams "Contexts" tabs → **"Access"** tabs; rows labeled with resolved agent names; writes unchanged |
| D5 | Context deletion guardrail | Moot: after Category A removal there is **no user-facing context-delete path** left in the UI |
| D6 | Multi-agent GFS mounts via context detail | **Accepted loss** of that surface (was the only multi-agent mount UI). Single-agent GFS access continues via existing GFS grant surfaces; documented for product follow-up |
| D8 | Member/team Access tabs | **One concept: agents.** The Access tab lists agents (display name + Connectors column with the same pill/hover as the Agents table; click → agent's Connectors tab). The separate member/team "Agents" tabs are folded in (old URLs redirect to `…/access`). Writes are composite: granting agent X updates BOTH `PUT /{users,teams}/:id/agents` and `PUT /{users,teams}/:id/contexts` (scope synced, legacy scope-only mappings preserved), so whichever table the runtime enforces, the grant works. Granted rows = agent mapping ∪ agents resolved from legacy scope mappings; tombstones show deleted agents (+ unowned deleted scopes). The team wizard collapses to `Team → Members → Access` with an agent picker. Wire frozen — both endpoints already existed |
| D7 | Connector access-grid people | The connectors list + connector-edit Access tab derive Teams/Users from the **agent-centric grants** (`/admin/agents/:name/{users,teams}`) merged across the connector's agents — NOT from the legacy scope-centric `/admin/contexts/:id/{users,teams}`. The operator's chain: connector → agent (scope allowlist) → user/team (Access/Agents tabs). Connector↔user/team direct grants remain out of scope (would need backend) |

**Backend changes required:** none. (Explicitly verified per phase; any backend need would be listed here.)

---

## 4. Phase 0 — Category E: leaks inside the already-abstracted agent experience

**Goal:** the agent section never shows a context slug or the word "context".

| Item | Surface | Change | Status |
| --- | --- | --- | --- |
| E1 | Agents list ▸ Connectors column hover card (`components/HostTable.tsx`) | Card shows a neutral **"Connectors" heading + count + server names** — never the raw private-context slug; clicking navigates to that agent's own Connectors tab (`/agents/<name>/connectors`), never `/contexts/<slug>` | ✅ Done |
| E2 | Create-agent failure copy (`components/HostWizard/index.tsx`) | "The agent connector context could not be created…" → "We couldn't finish setting up this agent's connectors — please try again." | ✅ Done |
| E3 | Agent connectors tab error mapping (`app/hosts/[name]/page.tsx`) | `agentConnectorMutationError()` already intercepts the 409/"version unavailable" cases with agent-flavored copy; final fallback now passes a connector-flavored message so `contextMutationError()` defaults can never surface | ✅ Done |

Tests updated in the same commit: `HostTable.test.tsx` (hover card now asserts agent-name heading + agent connectors navigation).

**Flow after Phase 0 (new):** Agents list ▸ hover the Connectors count ▸ card titled "Connectors" with count + server names (slug never renders — test-locked) ▸ click → agent detail ▸ Connectors tab.

## 5. Phase 1 — Category B: connector flows stop speaking "Context"

### 5.1 Connectors list (`/connectors`)

**Before:** expanded row shows a "Contexts" group with raw context-name links into `/contexts/<name>/connectors`, per-context remove icons, "Add contexts" modal ("Add connector to contexts").
**After (new flow):**
- The write group is now **"Agents"**: one row per *agent that can use this connector*, resolved client-side via `host.spec.contextRef` join. Raw context names are never rendered.
- Remove icon per agent removes the connector from that agent's private context (`PUT /contexts/:name`, additive spec + `resourceVersion`). If several agents share one context, the row lists them together and removal confirms the shared effect.
- Contexts with **no owning agent** (e.g. per-install or workflow-recipe private contexts) are intentionally invisible here — they are not user-managed scopes.
- "Add contexts" → **"Add agents"** modal: multi-select of *agents* (by display name) that don't already have the connector; submit writes the connector into each selected agent's private context.
- Subtitle "Browse connector deployments and context bindings." → "Browse connector deployments and agent access."
- The read-only **Teams/Users** groups now ride the **agent grants** (`GET /admin/agents/:name/users|teams`, merged across the connector's agents) instead of the legacy scope-centric `GET /contexts/:id/users|teams` — they show exactly the people/teams an operator granted in Users & Teams, matching the "connectors ride agents; people ride scopes/agents" model (decision D7).

### 5.2 Connector edit page (`/connectors/<name>/edit`)

- Tab `context`/"Context" → tab `access`/"Access" (redirect added for old `/connectors/<name>/edit/context`).
- Section "Context access" → **"Agent access"**: read-only Agents/Teams/Users groups. Data path: `getContexts` (find scopes carrying the connector) → hosts join (owning agents) → per-AGENT `getAgentUsers/getAgentTeams` grants (D7). The `Contexts: <names>` line is gone; agents are the resolved truth.
- Page subtitle no longer mentions "context access".

### 5.3 Create connector (`/connectors/new`)

- Steps `['Connector', 'Context', 'Secrets']` → `['Connector', 'Access', 'Secrets']`.
- The step is now an **optional multi-select of agents** ("Give agents access"). Choosing none is valid: the connector is created and is simply not reachable by any agent yet (info copy says exactly that).
- Submit: `createMcpServer()` as today; then for each selected agent, add the connector to that agent's private context (fresh `getContext` + additive `updateContext` per agent). Partial-failure copy keeps stating the connector **was** created and names the agents that could not be updated.
- Loading skeleton steps in `createFlowLoading.ts` updated to match.

### 5.4 Registry install — page flow (`/marketplace/install`)

- Steps `['Package', 'Context', 'Credentials', 'Install']` → `['Package', 'Credentials', 'Install']`.
- No context selection anywhere. Before `installFromRegistry()`, the form **creates a private context** named `<connector-name>-<rand5>` (same generator/shape as the agent wizard, one collision retry) and passes it as `contextRef`. Payload shape unchanged.
- Success copy no longer mentions a context. The connector starts reachable by no agent; the operator grants agents from the connectors list (§5.1). This is decision D3.
- The "Context access" preview section (users/teams/agents of the selected context) is removed with the step.

### 5.5 Registry install — modal variant (`components/RegistryInstallModal.tsx`)

- Same treatment: required "Context" select removed; private context created silently at install; success toast reworded. Install no longer blocked on context availability.

### 5.6 Shared vocabulary (B5)

- `cu-registry-context-access*` CSS classes → `cu-entity-access*`; `cu-connector-context-access*` → `cu-connector-agent-access*`; `cu-agent-context-mcp-summary` → `cu-agent-connectors-summary`; `cu-host-context-*` → `cu-host-connectors-*`. Mechanical rename in `globals.css` + components; no behavior.

## 6. Phase 3 (executed after B) — Category A: the `/contexts` section is removed

> Ordering note: Categories B and C were implemented before the section removal so that no screen ever linked into `/contexts` once it dies.

### 6.1 What is deleted

- Sidebar item + tab key + order entry + `DashboardLayout` active-detection branch.
- `CONTROL_ROUTES.contexts.*` builders (all consumers rewritten first).
- `app/contexts/page.tsx`, `app/contexts/new/page.tsx`, `app/contexts/[name]/page.tsx`, `app/contexts/[name]/[tab]/page.tsx`, `components/ContextTable.tsx`.
- `createFlowLoading.createContext` entry.
- Their unit tests (list/create/detail/name/spec-preserve suites) — with the **spec-preservation and RFC1123 contracts re-homed** (see §7.3).

### 6.2 What replaces each lost capability

| Lost capability | Replacement |
| --- | --- |
| See/edit a context's connector set | Agent detail ▸ Connectors tab (per-agent, additive writes) |
| See which agents share a connector | Connectors list expanded row (Agents group) |
| See which members/teams reach connectors | Connectors list expanded row (Teams/Users groups); Users & Teams ▸ Access tabs |
| Move an agent between contexts | Gone by design (D2): an agent's private context is not a user concept |
| Create a shared context | Gone by design (D2) |
| Delete a context | Gone by design (D5) — no UI path remains |
| Mount a SharedFileSystem into a context | Gone as a *multi-agent* surface (D6); SFS detail shows mounts resolved to agent names |

### 6.3 Redirects (D1)

`app/contexts/[[...slug]]/page.tsx` is a small client resolver page (replaces the deleted section):

- `/contexts` and `/contexts/new` → `/agents`.
- `/contexts/<slug>` (any tab suffix ignored) → load hosts + contexts; if exactly the host with `spec.contextRef === slug` exists → `router.replace('/agents/<host>/connectors')`; otherwise → `/agents`.
- API/lookup failure → `/agents` (fail safe, never a dead end).

### 6.4 New flow (tester view)

1. Old bookmark `…/contexts/research-agent-48213/connectors` lands on `…/agents/research-agent/connectors` (owning agent resolved).
2. Unknown slug `…/contexts/legacy-thing` lands on the Agents list.
3. The sidebar has no Contexts entry anywhere.

## 7. Phase 2 — Category C: access management rebrand (superseded in part by D8)

### 7.1 Member detail (Users & Teams ▸ user) — as built after D8

- Tabs: Contact / Approval DMs / Communication Channels / **Access** / Teams (the former "Agents" tab folded into Access; `/users-and-teams/users/<id>/agents` redirects to `…/access`).
- Access tab = **agents**: table rows show the agent display name (link to agent detail), the **Connectors column** (identical pill + hover card + click-through as the Agents list), and "Remove access" (confirm: "This revokes the agent and every connector it carries.").
- Granted set = agent mapping ∪ agents resolved from legacy scope-only mappings; "Removed access" tombstones list deleted agents (+ unowned deleted scopes, muted).
- "Add access" picker lists **agents** (display names); submit performs the **composite write** (agents + contexts mappings in sync).
- Old scope-mapping read path (`getContextUsers/getContextTeams`) no longer used here.

### 7.2 Team detail + team wizard — as built after D8

- Team detail tabs: Members / **Access** (former "Agents" folded in; legacy URL redirects).
- Same agent-row table with Connectors column, composite write, and tombstones as 7.1 (toast "Team access updated.").
- Team wizard: `['Team','Members','Access']` — the Access step is an agent multi-select ("Choose the agents this team can use — their connectors come along."); creation writes both team mappings.

### 7.3 Legacy panel + admin home

- `components/ProfileAdminPanel.tsx`: dead code (zero importers) → **deleted**.
- `components/ProfileAdminHome.tsx`: sortable "Contexts" column → **"Access"** (same underlying count/sort key); org-delete warning reworded to "team access/agent mappings".

## 8. Phase 4 — Category D: peripheral copy sweep

| Item | Surface | Change |
| --- | --- | --- |
| D1 | `/agent-files` list | Column "Mounted by Contexts" → "Mounted by"; mount names resolved to owning agent names where possible; subtitle → "Workspace volumes that agents can mount read-only into their pods." |
| D2 | SFS create subtitle | Same reword |
| D3 | SFS detail mount chip | "not mounted by any Context" → "not mounted by any agent"; "mounted by X" resolves private contexts to agent names |
| D4 | Recipe editor L1 banner | Reworded to "shared connector scope" language (Option B wording completed in the §11 audit); JSON keys (`security.allowContextRef`, `spec.contextRef`) untouched (wire format) |
| D5 | Workflow run modal infra error | "…MCP server, Context allowlist, and ready endpoints…" → "…MCP server, connector access, and ready endpoints…" |
| D6 | Workflow access panel | "…in the matching context." → "…in the matching connector scope." |
| D7 | `components/ResourceTable.tsx` | Dead code (zero importers) → deleted |

## 9. Test strategy

- **Unit/vitest** travel with each phase (same commit). Re-homed contracts:
  - Context spec-preservation on `PUT` (unknown `spec.gfs` survives) → new suite against the agent-side connector writer (`app/hosts/[name]` save path), because that is the only surviving context writer.
  - RFC1123/displayName gating for generated private-context names → suite against `lib/agentContext.ts` (kept/extended for the generalized generator).
- **Playwright e2e** (`tests/e2e/playwright/control-ui/`): specs that walked the Contexts section are rewritten to the user-visible replacement path or deleted when the whole subject is gone (`contexts.spec.ts`). Selector constants updated.
- **QA-recorder specs** (`control-ui/e2e/qa-recorder-*.spec.ts`) + their `package.json` scripts: context-section journeys removed; connector/team journeys rewritten to agent-centric paths.
- **New main-suite e2e regression catalog** (`tests/e2e/playwright/control-ui/`, built 2026-08-27) — 15 new specs + 1 extended, covering every §12 manual flow as automation:

  | Spec | Covers (§12 flow) |
  | --- | --- |
  | `contexts.spec.ts` (extended) | A1–A5 incl. real private-slug → owning agent Connectors tab |
  | `agents-connectors-hover.spec.ts` | B1–B2 |
  | `agent-create-wizard.spec.ts` | B3 (rail labels + vocab; full creation stays in `qa-recorder-agent-create`) |
  | `agent-connectors-tab.spec.ts` | B4 |
  | `connectors-agent-access.spec.ts` | C1–C4 (incl. shared-scope confirm) |
  | `connector-create-access-step.spec.ts` | C5–C6 |
  | `connector-edit-access-tab.spec.ts` | C7–C9 |
  | `marketplace-install-flow.spec.ts` | D1–D2 light (skips when no registry entries deployed; never clicks Install) |
  | `member-access-tab.spec.ts` | E1–E3 (+ API round-trip verification, original mappings restored) |
  | `team-access-tab.spec.ts` | E4 (+ legacy tab redirect) |
  | `team-create-wizard.spec.ts` | E5 |
  | `users-teams-access-column.spec.ts` | E6 |
  | `agent-files-mounted-by.spec.ts` | F1–F2 (read-only; no PVC seeding) |
  | `recipe-scope-copy.spec.ts` | G1–G2 |
  | `token-budget-scope-label.spec.ts` | G3 |
  | `global-no-context-vocab.spec.ts` | Global negative check across 7 routes |

  Seeding goes through new `controlApi` helpers in `helpers/api-client.ts` (`createContext`, `createMcpServer`, user/team context GET/PUT, `createTeam`, `createBudget`, SFS list). Run with `make minikube-pf-all` then `cd tests/e2e/playwright && npx playwright test --project=control-ui <spec>`; env: `CONTROL_UI_URL` (default `:3000`), `CONTROL_API_URL` (default `:8090`), `TEST_ADMIN_USERNAME`/`TEST_ADMIN_PASSWORD` (default `admin`/`changeme123!`). Typecheck gate: `npx tsc -p tsconfig.typecheck.json` (added config — the package tsconfig lacks node types/rootDir for a clean standalone `tsc` run).
- **QA-recorder video-evidence journeys** (`control-ui/e2e/qa-recorder-*.spec.ts`, built 2026-08-27) — one journey = one video (WebM) + named PNGs under `.local-notes/qa-recorder/runs/control-ui/`, each with its own `npm run qa:recorder:<name>` script:

  | Script | Covers (§12) | Mutating |
  | --- | --- | --- |
  | `qa:recorder:context-redirects` | A1–A5 | yes (seeds throwaway ctx+host) |
  | `qa:recorder:agent-connectors` | B1, B2, B4 | yes |
  | `qa:recorder:connectors-agent-access` | C1–C4 incl. shared-scope confirm | yes |
  | `qa:recorder:connector-create-access` | C5–C6 incl. silent private-scope capture | yes |
  | `qa-recorder-connector-edit` (extended) | C7–C9 incl. legacy `/edit/context` redirect | yes |
  | `qa:recorder:marketplace-install` | D1–D3 incl. post-install grant | yes (skips when no registry entry) |
  | `qa:recorder:member-access` | E1–E3 + E6 column checks | yes (restores original mappings) |
  | `qa:recorder:team-access` | E4 + legacy tab redirect | yes |
  | `qa:recorder:agent-files-mounted-by` | F1–F2 | no |
  | `qa:recorder:recipe-scope-copy` | G1–G2 | yes |
  | `qa:recorder:token-budget-scope` | G3 | yes |
  | `qa:recorder:context-vocab-sweep` | Global negative check, 8 routes | no |
  | `qa:recorder:agent-connectors-conflict` | B4 error path: out-of-band 409 → "This agent's connectors changed…" banner + reload-recover | yes |
  | `qa:recorder:member-removed-access` | "Removed access" section for a mapping whose scope was deleted | yes |
  | `qa:recorder:connectors-search-agent` | Connectors search filters by agent display name | yes |

  Prerequisites for video evidence: `npm run qa:recorder:install` (once), `make minikube-pf-all`, and a repo-root `.env.qa-recorder` copied from the committed `.env.qa-recorder.example` containing the admin identity (`E2E_ADMIN_USER`/`E2E_ADMIN_PASSWORD`) and `QA_RECORDER_CONFIRM_MUTATIONS=1` for the mutating journeys. Journeys follow the recorder contract (`docs/testing/optional-playwright-qa-recorder.md`): loopback-only target guard, explicit opt-in before any write, and full API cleanup in `finally`. Output per journey: a WebM video (1280×720, Playwright native format) + full-page PNGs under `.local-notes/qa-recorder/runs/control-ui/`. For MP4 evidence run `npm run qa:recorder:convert-mp4` (`scripts/qa-recorder/convert-videos-mp4.sh [--replace]` — H.264 + faststart via ffmpeg; verified working with ffmpeg 7.x).
- Verification per phase: `cd control-ui && npx tsc --noEmit && npm test` (no lint script exists in control-ui; typecheck via `tsc --noEmit`).

## 10. Progress log (append-only)

| Date | Phase | Entry |
| --- | --- | --- |
| 2026-08-26 | — | Document created; baseline verified at `a584c259a`; research inventories completed (surfaces + test impact) |
| 2026-08-26 | 0 | E1/E2/E3 implemented: hover card shows neutral "Connectors" heading (no slug), click opens the agent's own Connectors tab (`onOpenConnectors`), wizard failure copy reworded, error mapping verified interceptor-covered. CSS family renamed (`cu-agent-connectors-summary*`, `cu-host-connectors-*`; dead `cu-host-context-select` removed). Tests: `HostTable.test.tsx` (+slug-never-renders invariant, +click-navigation), `HostWizard.test.tsx` copy. `tsc --noEmit` + full vitest green (1743 passed). No backend changes. |
| 2026-08-26 | 1 | Category B implemented. **B1** connectors list: expanded row now has one write-capable **Agents** group (per-binding remove, shared-scope confirm when a context backs >1 agent, "Add agents" modal picking agents); Teams/Users stay read-only; orphan contexts (no owning agent) are invisible; `McpServerTable` props reworked (`agentBindingsByConnectorName`, `agentTargets`, `onAdd/RemoveFromAgents`, `updatingAgentAccessKey`). **B2** connector edit: tab `context`→`access` ("Access"), section "Agent access", redirect added for `/connectors/:name/edit/context`. **B3** create connector: steps `['Connector','Access','Secrets']`, optional agent multi-select with access preview; no-selection path creates a private scope (CRD requires `spec.contextRef`, so the connector gets its own invisible scope — same as installs); partial-failure copy names agents. **B4** install page form: steps `['Package','Credentials','Install']`, silent private scope per install via new `lib/privateContext.ts` (also adopted by HostWizard); success copy reworded. **B5** CSS renames (`cu-entity-access*`, `cu-connector-agent-access*`). Dead `RegistryInstallModal` + test deleted (zero production importers; documented dead in self-hosted-registry-ux-redesign.md). New shared helper `lib/privateContext.ts` (create-POST with one collision retry; wire shape identical to wizard's). Tests updated: McpServerTable, ConnectorEditContext, CreateMcpServerForm, RegistryInstallForm. Full vitest green (1718 passed), `tsc --noEmit` clean. **No backend changes** (verified: registry install API still receives `contextRef`; McpServer CRD still gets a valid `spec.contextRef`). |
| 2026-08-26 | 2 | Category C implemented. Member + team detail "Contexts" tabs → route `access` / label **"Access"**; rows show resolved labels (owning agent name(s) → context `displayName` → muted raw id), no `/contexts` links; confirm/toast/error copy reworded ("Access updated.", "Removed access"); add-modal relabeled with resolved-label picker, writing context IDs unchanged. Team wizard step "Contexts" → **"Access"**. Legacy `ProfileAdminPanel.tsx` deleted (zero importers). `ProfileAdminHome` "Contexts" column → **"Access"** (same sort/count source). Redirects for `/users-and-teams/{users,teams}/:id/contexts` → `…/access`. No backend changes (GET/PUT `/admin/{users,teams}/:id/contexts` payloads byte-identical). |
| 2026-08-26 | 3 | Category A implemented + e2e migration for phases 0–3. Deleted: `/contexts` pages (`page`, `new`, `[name]`, `[name]/[tab]`), `components/ContextTable.tsx`, sidebar item/type/order, `DashboardLayout` branch, `CONTROL_ROUTES.contexts` builders, `createFlowLoading.createContext`, stale `/contexts/:name/shared-files` redirect. Added `app/contexts/[[...slug]]/page.tsx` legacy resolver (slug → owning agent's Connectors tab via `spec.contextRef` join; unknown/`new`/failures → `/agents`). Tests: contexts suites + `ContextTable.test.tsx` deleted; **spec-preservation contract re-homed** to `HostDetailsPage.connectors.test.tsx` (unknown `spec.gfs` + `resourceVersion` survive agent-side connector PUTs); RFC1123 generation stays covered by `lib/__tests__/agentContext.test.ts`; `Sidebar.test.tsx` order, `AuthContext.test.tsx` URL fixture updated. E2e: main `contexts.spec.ts` rewritten as redirect/no-sidebar regression; `auth.spec.ts`, `channels.spec.ts`, `mcp-servers.spec.ts`, `helpers/selectors.ts` cleaned. QA-recorder: 4 context specs deleted + their npm scripts; connector-edit/navigation/onboarding-combo/team-create/create-form-smoke/connectors/shared-fs-upload migrated to agent-access flows (API-created contexts where a context fixture is needed). Full vitest + `tsc` green. No backend changes. |
| 2026-08-26 | 4 | Category D + close-out. SFS list column → "Mounted by" with mount refs resolved to owning agent names (failure-tolerant hosts/contexts enrichment); SFS create subtitle + loading-skeleton copy reworded; SFS detail chip "not mounted by any agent" / "mounted by <agents>" (invisible scopes don't count); recipe editor L1 banner speaks "shared connector scope" (JSON keys untouched); workflow-run infra error → "connector access"; workflow access panel description reworded; dead `ResourceTable.tsx` deleted. New shared `lib/accessScopeLabels.ts` (scope id → agent/display label join) now backs users/teams Access tabs and SFS surfaces. Residual sweep: missed "Contexts:" meta line on connector egress tab removed; `createFlowLoading` SFS copy fixed; verified remaining "context" strings are all §3 exclusions (LLM prompt "User context", guardrail `may_add context`, service name `host-context-controller`, internal identifiers). **Verification:** full vitest 1700/1700, `tsc --noEmit` clean, `next build` compiles with `/contexts/[[...slug]]` as the only contexts route. No backend changes. |
| 2026-08-26 | 4 | Product e2e `control-ui/e2e/registry-install.spec.ts` migrated: install flows drop the removed Context step (one fewer Continue; access scope is provisioned silently); J1 manual-create flows rewritten to the current form (egress via "Advanced options" disclosure on the Connector step, optional Access step passed through, "No credentials required" radio before submit). API-level sections (contextRef payloads, context1 allowlist assertions) intentionally unchanged — the backend contract is untouched. Full vitest 1700/1700 + `tsc` green after migration. |
| 2026-08-27 | audit | Fresh-eyes residual audit (independent pass) + fixes. **Backend re-verified untouched**: `git diff --name-only a584c259a..HEAD` contains zero files outside `control-ui/`, `docs/`, `tests/e2e/` (an apparent `host-context-controller` diff was `origin/dev` moving forward under us mid-run — PR #471, someone else's lane; our branch never touched it). Leaks fixed: (1) RecipeEditor L1 Option B still said "a private Context \"wf-<recipeName>\"" (earlier scripted replace had silently missed it) → "a private connector scope"; (2) `lib/recipeValidator.ts` INFO hint same reword; (3) `lib/contextMutation.ts` default messages neutralized ("A required version is unavailable…", "This access changed since it was loaded…") + `hosts/[name]` regex updated + connectors page now also intercepts the version-unavailable path; (4) token-budget dimension label `context_ref` "Context" → "Connector scope"; (5) "Stored context and provenance" trace-detail heading → "Stored details and provenance"; (6) stale qa-recorder-connector-edit assertion on the removed context-slug meta now asserts it does NOT render. Tests updated (RecipeEditor, GovernedTraceDetails). Remaining "context" words verified as §2.5 exclusions: kubectl `--context` flags in recipe-status hints (kubeconfig syntax), manifest `contextRef` prose (wire format), raw-id fallback labels (by design, muted), `host-context-controller` service label, LLM "User context" (USER.md), guardrail `may add context`, plus intentional legacy redirects in `next.config.js`. Full vitest 1700/1700, `tsc` clean. No backend changes. |
| 2026-08-27 | docs | Source-of-truth restructured after the audit: added §11 (audit report: backend-untouched proof incl. the `origin/dev`-moved warning, leak/fix table, verified intentional remnants), §12 (full click-by-click manual tester walkthrough, tables A–G + global negative check), renumbered open questions to §13; extended the §2.5 exclusion list to the complete audited set; corrected §4 E1 (hover card shows a neutral "Connectors" heading, not the agent name) and the §6.4 heading typo. |
| 2026-08-27 | e2e | Built the full e2e regression catalog for the §12 flows: 15 new specs + `contexts.spec.ts` extended with the real-slug resolver case (112 tests / 24 files listed for the control-ui project). Extended `helpers/api-client.ts` with context/mcp-server/user-team-contexts/team/budget seeding + teardown helpers (all against the unchanged wire API). Added `tests/e2e/playwright/tsconfig.typecheck.json` so the package typechecks standalone (`npx tsc -p tsconfig.typecheck.json` → clean; the shipped tsconfig lacks node types + a covering rootDir). No specs executed here (no cluster) — they run under the normal `make test-playwright-control-ui` / T2 lane. control-ui unit suite re-verified 1700/1700. No backend changes. |
| 2026-08-27 | e2e | Built the QA-recorder video-evidence journeys: 11 new `qa-recorder-*` specs + `qa-recorder-connector-edit` extended with the legacy-tab redirect, each with a dedicated `qa:recorder:<name>` npm script (62 tests / 45 files listed under the recorder config). Journeys follow the recorder contract (loopback guard, `QA_RECORDER_CONFIRM_MUTATIONS` opt-in for mutating journeys, `screenshotAndLog` at every step, full API cleanup in `finally`). Committed the previously-missing `.env.qa-recorder.example` (referenced by the recorder doc but never tracked) with the exact keys the journeys need. Verification: control-ui `tsc --noEmit` clean, recorder `--list` clean, unit suite 1700/1700. No backend changes. |
| 2026-08-27 | e2e | Added 3 gap journeys for error/degraded paths: `agent-connectors-conflict` (out-of-band context PUT stales the page → 409 banner "This agent's connectors changed since they were loaded." → reload + retry succeeds), `member-removed-access` (mapping whose scope was deleted renders under "Removed access" with the agent label + Deleted marker), `connectors-search-agent` (search-by-agent-name filtering + empty state). Recorder catalog now 65 tests / 48 files listed; `tsc` clean. **Execution status: no Playwright spec (main or recorder) has been executed in this lane — no runnable cluster exists in the dev session** (both minikube profiles Stopped, no branch.mk ownership record → fail-closed per repo rules; the live `:3000` server belongs to the unrelated `feat/desktop-home` worktree and `:8090` is a dead forward). Verified-only: unit suite 1700/1700 (three clean full runs; one intermediate run under heavy parallel load showed 4 flakes that did not reproduce), `tsc --noEmit` everywhere, both Playwright configs `--list` clean, `next build` green. First cluster run should budget for small selector polish. |
| 2026-08-27 | e2e | Video-format answer + MP4 pipeline: Playwright/Chromium records **WebM** natively (not MP4) — `qa:recorder:convert-mp4` added (`scripts/qa-recorder/convert-videos-mp4.sh`, ffmpeg H.264 + faststart, `--replace` to drop originals; round-trip verified against a synthetic clip). Recorder doc + §9 updated. **No video evidence exists yet anywhere in `.local-notes/` — zero journeys have been executed in this lane; videos are produced only when a journey runs against a live cluster.** |
| 2026-08-28 | e2e | **Execution campaign (mock-backed).** Full T2 bootstrap was ruled out on this host (7 GB RAM, ~3 available → OOM risk; both minikube profiles Stopped, stale branch.mk ownership → fail-closed per repo rules). Instead: built `scripts/qa-recorder/mock-control-api.mjs` — an in-memory control-api implementing the audited wire contract (auth cookie, resourceVersion/409 semantics, users/teams contexts mappings with deleted-history, hosts/contexts/mcp-servers CRUD, registry entries + install, budgets, recipes, rotation `DeploymentReady` simulation) — and ran the REAL control-ui dev server against it. Environment fights solved along the way: mock must bind dual-stack (`localhost` → `::1` first for Playwright's request context); Next dev daemon ignores env/port and grabs its own port (verify + set `CONTROL_UI_URL` per run); each playwright invocation wipes the outputDir (run batches in ONE invocation, copy evidence out after). Spec fixes found by real rendering: connectors rows use `role="button"` (kills `row` role; target `Expand/Collapse connector <name>`), team Access rows are `listitem`s, sort headers expose `Sort by access …` aria-names, tombstone rows persist after removal (assert actionability, not absence), toasts stack (`.last()`), 10s auto-refresh detaches click targets (retry), journeys must re-navigate after seeding (login pre-seed landing makes sidebar clicks no-ops). |
| 2026-08-28 | e2e | **Two REAL production bugs found by the journeys, fixed in `f2eebbc8a`:** (1) member detail page crashed wholesale — `accessLabeler` useMemo was declared after its consumer in `availableContextOptions` (TDZ ReferenceError; no unit tests covered those pages); (2) connectors-page search-by-agent silently broke in the Phase-1 rework (`summary.agents` emptied while the search haystack still reads it). Both fixed; search-by-agent locked with a new unit regression test (`McpServerTable.test.tsx`); unit suite now **1701/1701**, `tsc` clean. |
| 2026-08-28 | D8 | **Access tabs = agents** (operator-approved design): member + team Access tabs rebuilt as agent tables with the shared Connectors column (extracted `components/ConnectorCountCell.tsx`, now also used by the Agents list — same pill, same hover, same click-through); separate "Agents" tabs folded in with legacy redirects; team wizard collapsed to 3 steps with an agent picker; writes are composite (`agents` + `contexts` mappings synced, legacy scope-only mappings preserved). Verified: `tsc` clean, unit suite green (2 known load flakes pass solo), and all 7 affected recorder journeys re-executed green against the mock stack (member-access ×3, team-access ×2, team-create, onboarding-combo). Spec fallout updated incl. api-client agent-mapping helpers and restore-agentNames hygiene. |
| 2026-08-28 | D7 | **Connector access grid now rides agent grants** (operator decision after flow review): connectors list + connector-edit Access tab fetch Teams/Users via `GET /admin/agents/:name/{users,teams}` merged across each connector's agents, replacing the legacy scope-centric `GET /admin/contexts/:id/{users,teams}` reads. Wire untouched (both endpoints already existed); `getContextUsers/getContextTeams` no longer called from the connectors surfaces. Mock control-api gained the agent-grant endpoints (reverse of the Users & Teams mappings). Verified: `tsc` clean, unit suite 1701/1701 (one unrelated 5s-timeout flake re-run green), and the affected recorder journeys re-executed green against the live mock stack (connectors-agent-access, connector-edit ×2 incl. the rotation journey). Canonical chain documented as: connector → agent (scope allowlist) → user/team (grants). |
| 2026-08-28 | ops | Operator stopped the machine mid-run (commit `3daf915d8` preserved the in-flight spec fixes — thank you). The interrupted final invocation still produced **37 passing journeys / 51 WebM videos + 132 PNG proofs**, preserved in `.local-notes/qa-recorder/evidence-final/`. Two core journeys (marketplace-install, recipe-scope-copy) were environment-killed mid-flight and re-queued; their root causes were fixed (recipe fixture needed `spec.triggers`; the L1 banner fires at the deploy step, not review — verified via validator probe: `validateRecipe` excludes the L1 check by design). Pre-existing journeys needing real cluster depth (rotation-demo, cost-usage/governance, llm-lifecycle/price, invitations, gfs) fail against the mock by design — they belong to the cluster/T2 lane. |

## 11. Post-implementation audit (2026-08-27)

An independent fresh-eyes pass over every rendered surface (JSX text, aria-labels, titles, tooltips, placeholders, toasts, confirms, table headers, step arrays, loading skeletons, e2e copy assertions) after all phases landed.

### 11.1 Backend-untouched proof

- `git diff --name-only a584c259a..HEAD` (our true merge base) contains **zero files outside `control-ui/`, `docs/`, `tests/e2e/`** — no backend service, chart, or CRD was modified.
- All wire contracts byte-identical: `contextRef` / `contextIds` / `mcpServers` payloads, `GET/PUT /admin/{users,teams}/:id/contexts`, `POST /admin/contexts`, `POST /admin/registry/install` (still receives a `contextRef`; the install endpoint's 400-on-missing-`contextRef` and the McpServer CRD's required `spec.contextRef` are why the frontend silently provisions private scopes — decisions D3 and §5.3).
- ⚠️ Diff-hygiene note: `origin/dev` moved forward **while this branch was being implemented** (PR #471, `feat/460-hcc-networkpolicy-noop-gates`, touching `host-context-controller`). Diffing against a freshly-fetched `origin/dev` makes those files appear — they are **not part of this lane**. Always diff against the recorded base `a584c259a`.

### 11.2 Leaks found and fixed (commit `734fba71a`)

| # | Leak | Where it surfaced | Fix |
| --- | --- | --- | --- |
| 1 | Recipe editor L1 error, Option B still said `a private Context "wf-<recipeName>"` — the phase-4 scripted replace had silently missed this one string (indentation mismatch) | `components/RecipeEditor.tsx` "Cannot deploy: policy violation" banner + deploy-block reason | → "a private connector scope" |
| 2 | `recipeValidator` INFO hint with the same wording | Rendered issue list for every transport recipe omitting `spec.contextRef` (the common case) | Same reword |
| 3 | `contextMutation.ts` default messages ("Context version is unavailable…", "This Context changed…") could surface on the connectors page via `error.message` passthrough when `buildContextUpdatePayload` throws without a `resourceVersion` | Connectors list error banner | Defaults neutralized ("A required version is unavailable…", "This access changed since it was loaded…"); `hosts/[name]` interceptor regex updated; connectors page now also intercepts the version-unavailable path |
| 4 | Token-budget dimension label `context_ref` rendered as **"Context"** in scope chips/search | Cost & Usage ▸ Token Budgets, for budgets scoped on `context_ref` | → "Connector scope" |
| 5 | Trace-detail heading "Stored context and provenance" (audit-event payload, not the CRD — but ambiguous to a tester hunting the word) | Traces ▸ Administrative ▸ event detail | → "Stored details and provenance" |
| 6 | Stale e2e assertion expecting the context slug in the connector-edit meta block (UI removed in phase 4, spec migrated in phase 3) | `e2e/qa-recorder-connector-edit.spec.ts` | Now asserts the slug does **not** render |

Tests updated alongside: `RecipeEditor.test.tsx` (new wording), `GovernedTraceDetails.test.tsx` (new heading). Post-fix verification: **vitest 1700/1700, `tsc --noEmit` clean**.

### 11.3 Verified intentional remnants

Everything below was checked in context and is a §2.5 exclusion, not a leak: kubectl `--context=` hints, manifest `contextRef` prose, `host-context-controller` service label, LLM "User context" (USER.md), guardrail "May add context", raw-id muted fallbacks, `next.config.js` legacy redirects, internal identifiers/comments, and the negative-guard tests (asserting "Context" does *not* appear in the wizard/summary).

## 12. Manual tester flows (click-by-click walkthrough)

**Prerequisites:** a running Control UI deployment, at least one existing agent, logged in as admin. Expected strings are quoted exactly; anything else is a bug.

### A. Navigation & legacy links

| # | Navigate to | Do this | Expected |
| --- | --- | --- | --- |
| A1 | Left sidebar | Look at the items | **No "Contexts" entry.** Order: Users & Teams, Agents, Marketplace, Installed Connectors, Installed Plugins, Installed Guardrails, Files, External Channels, LLM Models, Secrets, Cost & Usage (Settings in footer) |
| A2 | URL bar ▸ `/contexts` | Enter | Brief "Taking you to the right place…" → lands on **/agents** |
| A3 | URL bar ▸ `/contexts/new` | Enter | Lands on **/agents** |
| A4 | URL bar ▸ `/contexts/total-nonsense-xyz` | Enter | Lands on **/agents** |
| A5 | URL bar ▸ `/contexts/<private-slug>` (get one via `kubectl get host <agent> -o jsonpath='{.spec.contextRef}'`) | Enter | Lands on **that agent's detail ▸ Connectors tab** |

### B. Agents

| # | Navigate to | Do this | Expected |
| --- | --- | --- | --- |
| B1 | **Agents** list | Hover the number in the **Connectors** column | Tooltip titled **"Connectors"** + count + connector names; the private slug **never** appears (test-locked) |
| B2 | Same | Click the count number | Opens that agent's detail ▸ **Connectors tab** |
| B3 | Agents ▸ **Create agent** | Walk the whole wizard | Steps: Agent → Model & Credentials → Access → Add Connectors. No context step or context name anywhere; finish with connectors selected — the agent works |
| B4 | Agent detail ▸ **Connectors** tab | Add a connector, then remove one | Writes succeed; toast "Connectors updated."; even error paths stay agent-flavored (open the tab in two windows and save both — the second says "This agent's connectors changed since they were loaded. Reload the agent and try again.") |

### C. Connectors

| # | Navigate to | Do this | Expected |
| --- | --- | --- | --- |
| C1 | **Installed Connectors** | Read the section subtitle | "Browse connector deployments and **agent access**." |
| C2 | Same | Click a row to expand ▸ **Access** section | Three groups: **Agents** (one row per agent, each with a ✕), read-only **Teams** and **Users**. Raw context names/slugs never render; scopes with no owning agent are invisible |
| C3 | Expanded row | Click ✕ next to an agent | Connector removed for that agent ("Connector X removed from agent Y."). If several agents share one connector set, a confirm explains the change applies to all of them |
| C4 | Expanded row | **Add agents** → pick 1–2 agents → **Add to agent(s)** | Toast "Connector X added to agent Y." / "…added to N agents."; agents appear in the group |
| C5 | Connectors ▸ **Create Connector** | Walk the form | Steps: **Connector → Access → Secrets**. Access step = optional "Agents" multi-select with an "Access preview" (who can already use the selected agents) |
| C6 | Same | Select **no** agents and finish | Connector is created successfully; info copy explains no agent can use it yet |
| C7 | Connectors ▸ row kebab ▸ **Edit** | Look at the tabs | Tabs: **Credentials / External Egress / Access** (no "Context") |
| C8 | Edit ▸ **Access** tab | Read | Heading **"Agent access"**, read-only Agents/Teams/Users; empty case: "No agents have access to this connector yet." |
| C9 | URL bar ▸ `/connectors/<name>/edit/context` | Enter | Redirects to `…/edit/access` |

### D. Marketplace install

| # | Navigate to | Do this | Expected |
| --- | --- | --- | --- |
| D1 | **Marketplace** ▸ pick a connector ▸ **Install** | Walk the flow | Steps: **Package → Credentials → Install**. No context selection anywhere |
| D2 | Same | Finish the install | Success dialog: "…is installed. **Give agents access from the Installed Connectors list**…" — no context mentioned |
| D3 | **Installed Connectors** | Find the just-installed connector | Shows "No agents have access yet." until granted via C4 |

### E. Users & Teams

| # | Navigate to | Do this | Expected |
| --- | --- | --- | --- |
| E1 | **Users & Teams** ▸ Users ▸ a member | Look at the tabs | Tab is **"Access"** (URL `…/users/<id>/access`), not "Contexts" |
| E2 | Member ▸ **Access** tab | Read the rows | Each row shows the **owning agent's name** (or shared set), not a slug; ✕ = "Remove access" with confirm "Remove <member>'s access to <agent>?" |
| E3 | Same | **Add access** | Picker lists agent names; submit → toast "Access updated." |
| E4 | Users & Teams ▸ Teams ▸ a team | Tabs + subtitle | Tab **"Access"**; subtitle "Members, connector access, and agents."; same add/remove behavior; old URL `…/teams/<id>/contexts` redirects to `…/access` |
| E5 | Users & Teams ▸ Teams ▸ **New team** | Walk the wizard | Steps: Team → Members → **Access** → Agents. Access step says "Choose the agents and connector scopes this team can use." and lists agent names |
| E6 | Users & Teams ▸ Teams table | Look at the columns | Column header **"Access"** (was "Contexts"); sorting still works |
| E7 | Team ▸ kebab ▸ Delete team | Read the warning | "…all memberships, pending invitations, and team access/agent mappings…" |

### F. Agent Files (SharedFileSystems)

| # | Navigate to | Do this | Expected |
| --- | --- | --- | --- |
| F1 | **Files ▸ Agent Files** | Look at the table | Column **"Mounted by"** showing **agent names** (or —); subtitle "Workspace volumes that agents can mount read-only into their pods." |
| F2 | Agent Files ▸ open one | Look at the metadata chip | "mounted by <agent names>" or "not mounted by any agent" — never a context slug |

### G. Plugins / workflows / budgets (copy checks)

| # | Navigate to | Do this | Expected |
| --- | --- | --- | --- |
| G1 | **Installed Plugins** ▸ create/edit an agentic recipe that sets `spec.contextRef` | Read the validation banner | "…shared **connector scope**… WRC will auto-create a **private connector scope**…" — no "Context" word |
| G2 | Recipe with a transport workload and `contextRef` omitted | Read the INFO issue | "Omitted — WRC will auto-create a private connector scope…" |
| G3 | Cost & Usage ▸ Token Budgets | Open a budget scoped on `context_ref` (if one exists) | Chip reads "**Connector scope**: \<id\>", not "Context" |
| G4 | Run a workflow before its infra is ready | Read the error toast | "…MCP server, **connector access**, and ready endpoints…" |

**Global negative check:** a full-page text search for "Context" in the rendered UI should only ever match the §2.5 exclusions (kubectl `--context` hints in recipe status, "User context" in the agent Identity tab, "May add context" guardrail permission, "host-context-controller" in traces).

## 13. Open questions / follow-ups (non-blocking)

- Lint rule against reintroducing user-facing "context" copy (CI grep with §2.5 exclusions) — proposed, not yet implemented.
- Support/debug visibility of an agent's private context slug (collapsed "Advanced" row) — rejected for now; fully invisible.
- Multi-agent GFS mount surface replacement (D6) — product follow-up.
