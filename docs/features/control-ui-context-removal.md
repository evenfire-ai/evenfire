# Removing "Context" from the Control UI — Implementation Run

**Status:** In execution. This document is the source of truth for the change.
**Branch:** `feat/context-removal` (base: `origin/dev` @ `a584c259a`, which includes `feat/ux-improvements-29`).
**Scope:** `control-ui/**` only. **No backend, CRD, or API-contract changes.** Every existing API call keeps its exact endpoint, payload, and field names.
**Audience:** Engineers executing/reviewing the change, and human testers validating it.

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

Old `/contexts/*` bookmarks are redirected (see §6.3), not 404'd.

---

## 2. Guardrails (frontend-only contract)

1. **Wire format frozen.** `lib/api.ts` context functions, payload shapes, and internal keys are untouched. Only labels, copy, routes, and component composition change.
2. **Additive-spec discipline preserved.** Every context `PUT` still goes through `buildContextUpdatePayload()` with the loaded `resourceVersion`; unknown spec fields (e.g. `spec.gfs`) still survive edits. The spec-preservation contract tests were re-homed (see §7.3).
3. **Redirect, don't strand.** Every removed route shape has a redirect (§6.3).
4. **Labels resolved client-side.** Private contexts are displayed via the owning agent (`host.spec.contextRef` join); fallback chain: owning agent(s) → `spec.displayName` → raw id (muted).
5. **Out-of-scope "context" words stay:** LLM context window, guardrail `may_add_context` permission, React contexts, `context.params` in route handlers, JSON keys (`security.allowContextRef`, `contextRef`, `contextIds`, `mountedByContexts`).
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

**Backend changes required:** none. (Explicitly verified per phase; any backend need would be listed here.)

---

## 4. Phase 0 — Category E: leaks inside the already-abstracted agent experience

**Goal:** the agent section never shows a context slug or the word "context".

| Item | Surface | Change | Status |
| --- | --- | --- | --- |
| E1 | Agents list ▸ Connectors column hover card (`components/HostTable.tsx`) | Header shows the **agent's name** + "Connectors" heading instead of the raw private-context slug; clicking navigates to that agent's own Connectors tab (`/agents/<name>/connectors`), never `/contexts/<slug>` | ✅ Done |
| E2 | Create-agent failure copy (`components/HostWizard/index.tsx`) | "The agent connector context could not be created…" → "We couldn't finish setting up this agent's connectors — please try again." | ✅ Done |
| E3 | Agent connectors tab error mapping (`app/hosts/[name]/page.tsx`) | `agentConnectorMutationError()` already intercepts the 409/"version unavailable" cases with agent-flavored copy; final fallback now passes a connector-flavored message so `contextMutationError()` defaults can never surface | ✅ Done |

Tests updated in the same commit: `HostTable.test.tsx` (hover card now asserts agent-name heading + agent connectors navigation).

**Flow after Phase 0 (new):** Agents list ▸ hover Connectors count ▸ card titled "`<agent name>` · Connectors" listing server names ▸ click → agent detail ▸ Connectors tab.

## 5. Phase 1 — Category B: connector flows stop speaking "Context"

### 5.1 Connectors list (`/connectors`)

**Before:** expanded row shows a "Contexts" group with raw context-name links into `/contexts/<name>/connectors`, per-context remove icons, "Add contexts" modal ("Add connector to contexts").
**After (new flow):**
- The write group is now **"Agents"**: one row per *agent that can use this connector*, resolved client-side via `host.spec.contextRef` join. Raw context names are never rendered.
- Remove icon per agent removes the connector from that agent's private context (`PUT /contexts/:name`, additive spec + `resourceVersion`). If several agents share one context, the row lists them together and removal confirms the shared effect.
- Contexts with **no owning agent** (e.g. per-install or workflow-recipe private contexts) are intentionally invisible here — they are not user-managed scopes.
- "Add contexts" → **"Add agents"** modal: multi-select of *agents* (by display name) that don't already have the connector; submit writes the connector into each selected agent's private context.
- Subtitle "Browse connector deployments and context bindings." → "Browse connector deployments and agent access."
- The Agents/Teams/Users read-only summary groups stay exactly as they are (they were already context-free).

### 5.2 Connector edit page (`/connectors/<name>/edit`)

- Tab `context`/"Context" → tab `access`/"Access" (redirect added for old `/connectors/<name>/edit/context`).
- Section "Context access" → **"Agent access"**: read-only Agents/Teams/Users groups (same data calls: `getContexts` + `getContextUsers/Teams` per binding + hosts join). The `Contexts: <names>` line is gone; agents are the resolved truth.
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

### 6.4 New flow ( tester view)

1. Old bookmark `…/contexts/research-agent-48213/connectors` lands on `…/agents/research-agent/connectors` (owning agent resolved).
2. Unknown slug `…/contexts/legacy-thing` lands on the Agents list.
3. The sidebar has no Contexts entry anywhere.

## 7. Phase 2 — Category C: access management rebrand

### 7.1 Member detail (Users & Teams ▸ user)

- Tab `contexts`/"Contexts" → tab `access`/"Access" (redirect for old `/users-and-teams/users/<id>/contexts` → `…/access`).
- Rows: "what this member can reach" — each mapped context rendered by **resolved label**: owning agent display name(s); fallback `displayName`; fallback muted raw id. Row action "Remove access" (confirm reworded, no "Context" wording); the row no longer links into `/contexts`.
- Add modal: "Add access" — searchable multi-select showing resolved labels, submitting **context IDs unchanged** (`updateAdminUserContexts`).
- Deleted-mappings section renamed "Removed access".

### 7.2 Team detail + team wizard

- Team detail tab `contexts` → `access`/"Access"; same relabel/resolve treatment as 7.1.
- Team wizard steps `['Team','Members','Contexts','Agents']` → `['Team','Members','Access','Agents']`; the Access step presents resolved labels, writes context IDs unchanged.
- Subtitles reworded ("Members, access, and agent access." style).

### 7.3 Legacy panel + admin home

- `components/ProfileAdminPanel.tsx`: dead code (zero importers) → **deleted**.
- `components/ProfileAdminHome.tsx`: sortable "Contexts" column → **"Access"** (same underlying count/sort key); org-delete warning reworded to "team access/agent mappings".

## 8. Phase 4 — Category D: peripheral copy sweep

| Item | Surface | Change |
| --- | --- | --- |
| D1 | `/agent-files` list | Column "Mounted by Contexts" → "Mounted by"; mount names resolved to owning agent names where possible; subtitle → "Workspace volumes that agents can mount read-only into their pods." |
| D2 | SFS create subtitle | Same reword |
| D3 | SFS detail mount chip | "not mounted by any Context" → "not mounted by any agent"; "mounted by X" resolves private contexts to agent names |
| D4 | Recipe editor L1 banner | Reworded to "shared connector scope" language; JSON keys (`security.allowContextRef`, `spec.contextRef`) untouched (wire format) |
| D5 | Workflow run modal infra error | "…MCP server, Context allowlist, and ready endpoints…" → "…MCP server, connector access, and ready endpoints…" |
| D6 | Workflow access panel | "…in the matching context." → "…in the matching connector scope." |
| D7 | `components/ResourceTable.tsx` | Dead code (zero importers) → deleted |

## 9. Test strategy

- **Unit/vitest** travel with each phase (same commit). Re-homed contracts:
  - Context spec-preservation on `PUT` (unknown `spec.gfs` survives) → new suite against the agent-side connector writer (`app/hosts/[name]` save path), because that is the only surviving context writer.
  - RFC1123/displayName gating for generated private-context names → suite against `lib/agentContext.ts` (kept/extended for the generalized generator).
- **Playwright e2e** (`tests/e2e/playwright/control-ui/`): specs that walked the Contexts section are rewritten to the user-visible replacement path or deleted when the whole subject is gone (`contexts.spec.ts`). Selector constants updated.
- **QA-recorder specs** (`control-ui/e2e/qa-recorder-*.spec.ts`) + their `package.json` scripts: context-section journeys removed; connector/team journeys rewritten to agent-centric paths.
- Verification per phase: `cd control-ui && npx tsc --noEmit && npm test` (no lint script exists in control-ui; typecheck via `tsc --noEmit`).

## 10. Progress log (append-only)

| Date | Phase | Entry |
| --- | --- | --- |
| 2026-08-26 | — | Document created; baseline verified at `a584c259a`; research inventories completed (surfaces + test impact) |
| 2026-08-26 | 0 | E1/E2/E3 implemented: hover card shows neutral "Connectors" heading (no slug), click opens the agent's own Connectors tab (`onOpenConnectors`), wizard failure copy reworded, error mapping verified interceptor-covered. CSS family renamed (`cu-agent-connectors-summary*`, `cu-host-connectors-*`; dead `cu-host-context-select` removed). Tests: `HostTable.test.tsx` (+slug-never-renders invariant, +click-navigation), `HostWizard.test.tsx` copy. `tsc --noEmit` + full vitest green (1743 passed). No backend changes. |
| 2026-08-26 | 1 | Category B implemented. **B1** connectors list: expanded row now has one write-capable **Agents** group (per-binding remove, shared-scope confirm when a context backs >1 agent, "Add agents" modal picking agents); Teams/Users stay read-only; orphan contexts (no owning agent) are invisible; `McpServerTable` props reworked (`agentBindingsByConnectorName`, `agentTargets`, `onAdd/RemoveFromAgents`, `updatingAgentAccessKey`). **B2** connector edit: tab `context`→`access` ("Access"), section "Agent access", redirect added for `/connectors/:name/edit/context`. **B3** create connector: steps `['Connector','Access','Secrets']`, optional agent multi-select with access preview; no-selection path creates a private scope (CRD requires `spec.contextRef`, so the connector gets its own invisible scope — same as installs); partial-failure copy names agents. **B4** install page form: steps `['Package','Credentials','Install']`, silent private scope per install via new `lib/privateContext.ts` (also adopted by HostWizard); success copy reworded. **B5** CSS renames (`cu-entity-access*`, `cu-connector-agent-access*`). Dead `RegistryInstallModal` + test deleted (zero production importers; documented dead in self-hosted-registry-ux-redesign.md). New shared helper `lib/privateContext.ts` (create-POST with one collision retry; wire shape identical to wizard's). Tests updated: McpServerTable, ConnectorEditContext, CreateMcpServerForm, RegistryInstallForm. Full vitest green (1718 passed), `tsc --noEmit` clean. **No backend changes** (verified: registry install API still receives `contextRef`; McpServer CRD still gets a valid `spec.contextRef`). |
| 2026-08-26 | 2 | Category C implemented. Member + team detail "Contexts" tabs → route `access` / label **"Access"**; rows show resolved labels (owning agent name(s) → context `displayName` → muted raw id), no `/contexts` links; confirm/toast/error copy reworded ("Access updated.", "Removed access"); add-modal relabeled with resolved-label picker, writing context IDs unchanged. Team wizard step "Contexts" → **"Access"**. Legacy `ProfileAdminPanel.tsx` deleted (zero importers). `ProfileAdminHome` "Contexts" column → **"Access"** (same sort/count source). Redirects for `/users-and-teams/{users,teams}/:id/contexts` → `…/access`. No backend changes (GET/PUT `/admin/{users,teams}/:id/contexts` payloads byte-identical). |
| 2026-08-26 | 3 | Category A implemented + e2e migration for phases 0–3. Deleted: `/contexts` pages (`page`, `new`, `[name]`, `[name]/[tab]`), `components/ContextTable.tsx`, sidebar item/type/order, `DashboardLayout` branch, `CONTROL_ROUTES.contexts` builders, `createFlowLoading.createContext`, stale `/contexts/:name/shared-files` redirect. Added `app/contexts/[[...slug]]/page.tsx` legacy resolver (slug → owning agent's Connectors tab via `spec.contextRef` join; unknown/`new`/failures → `/agents`). Tests: contexts suites + `ContextTable.test.tsx` deleted; **spec-preservation contract re-homed** to `HostDetailsPage.connectors.test.tsx` (unknown `spec.gfs` + `resourceVersion` survive agent-side connector PUTs); RFC1123 generation stays covered by `lib/__tests__/agentContext.test.ts`; `Sidebar.test.tsx` order, `AuthContext.test.tsx` URL fixture updated. E2e: main `contexts.spec.ts` rewritten as redirect/no-sidebar regression; `auth.spec.ts`, `channels.spec.ts`, `mcp-servers.spec.ts`, `helpers/selectors.ts` cleaned. QA-recorder: 4 context specs deleted + their npm scripts; connector-edit/navigation/onboarding-combo/team-create/create-form-smoke/connectors/shared-fs-upload migrated to agent-access flows (API-created contexts where a context fixture is needed). Full vitest (1700) + `tsc` green. No backend changes. |

## 11. Open questions / follow-ups (non-blocking)

- Lint rule against reintroducing user-facing "context" copy (CI grep with §2.5 exclusions) — proposed, not yet implemented.
- Support/debug visibility of an agent's private context slug (collapsed "Advanced" row) — rejected for now; fully invisible.
- Multi-agent GFS mount surface replacement (D6) — product follow-up.
