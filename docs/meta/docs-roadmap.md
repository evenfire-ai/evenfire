# Docs & README roadmap (adapted 2026-07-13)

> **Status of main:** `4a13afd` — includes Diátaxis tree (PR #1 lineage) and
> **minikube-first onboarding + capability tour** (PR #3 `docs/minikube-first`).
>
> This document **supersedes** the worktree-only
> `docs/superpowers/readme-improvement-plan.md` (Wave 1 README rewrite plan).
> Claim rules still live in [claims-guardrails.md](claims-guardrails.md).

---

## 1. What changed on main (relative to the old plan)

| Old plan assumption                              | Current main                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Compose quickstart as primary path               | **Removed** `docker-compose.yml`, `.env.quickstart.example`, `quickstart-chat.sh` |
| ~230-line README, features list                  | **~434-line** README with **capability tour** + architecture depth                |
| Optional full K8s later                          | **Minikube is the only first-class get-started**                                  |
| Audience: AI/app developers, K8s as deploy story | Audience still “agents you own,” but **entry barrier is full cluster**            |
| Competitive naming: none                         | Still category-only (`when-to-use-evenfire.md`) ✅                                |
| Never-overclaim checklist                        | Committed + tightened (edge headers, digest pinning nuance) ✅                    |

**Decision to lock in:** the product’s public demo is **the real platform**, not a
slim dev runtime. That is a deliberate trade: higher trust / higher time-to-first-success.

---

## 2. Evaluation snapshot (main @ 4a13afd)

### Root README — grade **A-** (launch-ready front door)

| Criterion              | Score | Notes                                                                                 |
| ---------------------- | ----- | ------------------------------------------------------------------------------------- |
| 30s value prop         | A     | “Build multi-channel LLM agents you own” + real actions                               |
| Differentiator clarity | A     | Capability tour + approvals + NetworkPolicy story                                     |
| Time-to-first-success  | B     | Real success (desktop + JWT API), but **≥10 GB / 6 CPU / 5–10 min**                   |
| Trust / honesty        | A-    | Security caveats improved; CLA still draft; LICENSE provisional (since resolved — §9) |
| Code-backed claims     | A-    | Tools tied to `nativeToolRegistry.ts`; seed default zai called out                    |
| Competitor silence     | A     | No product names                                                                      |
| Length / skim          | B     | 434 lines — rich but long for GitHub fold; capability tour is the win                 |
| Visual proof           | C     | Still no screenshots / GIF of desktop approval                                        |

**Strengths**

- “What agents can do” is best-in-class for this repo (shell, browser, docs,
  MCP, memory, workflows, approval wire format).
- Get started uses **production JWT path** — rare honesty among agent OSS.
- Architecture section (ports, token flows, L0–L3 networking) matches platform depth.
- Security model aligns with [claims-guardrails.md](claims-guardrails.md).

**Gaps / risks**

1. **No lightweight path** — developers without Docker Desktop resources bounce.
2. **Test aggregates** — “10,000+ / ~880 files” is **verified** (10,260
   `it()`/`test()` cases across 882 `*.test.ts` files, excl. node_modules /
   tests/e2e / dist; recounted 2026-07-12 and 2026-07-13; the ~950 figure adds
   `*.spec.ts` Playwright specs). Remaining ask: automate the count (see P2)
   so it never drifts.
3. **CLA.md still DRAFT** while `signatures/cla.json` has a signature — the
   document itself says counsel review must precede any signing. Legal
   inconsistency; highest-priority human item.
4. **LICENSE use grant still PROVISIONAL** — resolved: the 2026-07-13 MPL
   migration was **executed** the same day (see §9 status; LICENSE is now
   canonical MPL-2.0, no additional restriction).
5. **Default host model `zai`** is correct to document; still a footgun if users
   only set `OPENAI_API_KEY` (mitigated by README warning).
6. Capability table implies broad enablement; some tools need flags
   (`CLERUM_DESKTOP_BROWSER`, `CLERUM_DESKTOP_X11`, memory flags) — mostly noted.

### Docs hub (`docs/`) — grade **A-**

Diátaxis skeleton is live and consistent with minikube-first:

- Get started / learning path / FAQ
- Concepts (why, when-to-use, code-names)
- How-tos (Telegram, approvals, MCP)
- CRD index (8 CRDs)
- Production notes, claims guardrails, `llms.txt`

**Minor drift:** learning path / when-to-use still good; no Compose path left to
document (correct). Feature hubs still contain design-depth docs (OK if index
warns — it does).

### Service READMEs — grade **B-** (uneven)

| Status              | Components                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Solid / long        | mcp-host, channel-reader, control-api, host-context-controller, desktop-app, rpc-proxy                                           |
| Thin / stale risk   | control-ui (README lists ~4 tabs; app has ~15 route groups; says “no login” but AuthGate + admin JWT exist)                      |
| Missing entirely    | gfs-controller, workspace-files-controller, webhook-gateway, webhook-proxy, nginx-egress-proxy, workflow-approval-request-reader |
| Undersells security | host-context-controller NetworkPolicy section still reads simpler than 4-layer model in root README                              |

---

## 3. Goals (adapted)

### Primary (next 1–2 weeks)

1. **Keep minikube-first** as the public path — do not reintroduce Compose as
   equal peer without product decision.
2. **Optional “dev slice” later** only if product wants sub-5-min try-without-K8s;
   if added, label clearly as **incomplete security**.
3. Finish **trust surfaces**: CLA counsel pass (still open); **license
   migration to MPL-2.0 executed 2026-07-13** (see §9 status);
   `security@evenfire.ai` mailbox confirmed 2026-07-12, GH private reporting
   to verify.
4. **Service README backlog** (§2 table, §6 P1 rows) — six missing edge/file
   READMEs + control-ui / HCC accuracy pass.
5. **Visual assets** — 3–5 screenshots (desktop chat + approval, Control UI,
   Telegram approve) in README or `docs/assets/`.
6. **Test number hygiene** — script or Makefile target that prints unit
   file/case counts so the verified README numbers (10,260 cases / 882 files)
   never drift silently.

### Secondary (post-launch polish)

7. Docs site (Mintlify/Docusaurus) from existing `docs/` tree + `llms.txt`.
8. README length: superseded in part on 2026-07-13 — the repo-layout table
   was deliberately upgraded to a detailed **Components map** (per-component
   distillation of every folder README) so first-time readers get real depth
   on the front page. Any future length pass trims architecture/ports
   duplication, never the capability tour, get-started, or the Components map.
9. Community channel + badge when ready.
10. Production deploy guide beyond checklist (real cloud walkthrough).

---

## 4. Explicit non-goals (for now)

- Competitor comparison pages naming products (keep categories only).
- Retaining “source-available” / “not open source” language anywhere — the repo
  is MPL-2.0 open source since 2026-07-13.
- Restoring Compose as the default first-run without a product owner decision.
- Publishing internal phase plans / `docs/superpowers` audits.

---

## 5. README structure to preserve (current main)

Do **not** regress these sections without a new decision:

1. Tagline + badges + nav
2. What is evenfire (+ naming)
3. **What agents can do** (capability tour — crown jewel)
4. **Get started (minikube)** with provider warning + desktop + JWT API
5. Architecture (mermaid + ports + tokens + NetworkPolicy layers)
6. Security model (4 pillars, claims-aligned)
7. Beyond the agent
8. CRDs (8) + providers
9. Components map (per-component distillation of all folder READMEs, added
   2026-07-13) + testing + docs + community + license

If length becomes a problem, **trim 5** first — not 3, not 4, and not the
Components map in 9 (explicit decision, 2026-07-13).

---

## 6. Prioritized backlog

| P   | Item                                                                                                                                           | Owner type       | Depends on          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------- |
| P0  | Legal: license migration to MPL-2.0 **executed 2026-07-13** (§9); remaining: CLA counsel pass + align with cla.json                            | Human / counsel  | —                   |
| P0  | Verify GH private vulnerability reporting enabled (security@ mailbox confirmed)                                                                | Human            | —                   |
| P1  | Six missing service READMEs (purpose, ports, env, security) — **done** (PR #7, merged 2026-07-13)                                              | Docs eng         | —                   |
| P1  | control-ui README: real route groups + auth story — **done** (PR #7)                                                                           | Docs eng         | —                   |
| P1  | HCC README: document 4-layer NetworkPolicy model — **done** (PR #7)                                                                            | Docs eng         | code already exists |
| P1  | Screenshots / short demo GIF                                                                                                                   | Design / product | running minikube    |
| P1  | Cut post-Compose release — **done**: v0.2.0 (2026-07-13) supersedes v0.1.0                                                                     | Eng              | —                   |
| P2  | Automate test counts — **done**: `make test-counts` (PR #7); README cites it                                                                   | Eng              | —                   |
| P2  | e2e-guide internal debt (CLAUDE.md-era test tables) — **done** 2026-07-13                                                                      | Docs eng         | —                   |
| P2  | Four undocumented `mcp-servers/` dirs — **done** 2026-07-13: READMEs + Status column in “Available Servers”                                    | Docs eng         | —                   |
| P2  | Optional README length pass (move ports table to docs; the Components map is exempt — deliberate 2026-07-13 decision)                          | Docs eng         | —                   |
| P2  | Docs website                                                                                                                                   | Eng              | —                   |
| P3  | Fix the zai-default footgun in code — **done**: full-setup.sh infers the provider from the single set API key                                  | Eng              | —                   |
| P3  | Resolve or strip TBD placeholders in `docs/crds/workflowrecipe.md` (registry spec “TBD”, unmigrated comparison doc — lines ~177, ~3075, ~4121) | Docs eng         | —                   |
| P3  | platform-topology.md namespace count — **done**: now documents 12 namespaces                                                                   | Docs eng         | —                   |
| P3  | Lightweight non-K8s path (product decision required)                                                                                           | Product          | decision            |
| P3  | Cloud production tutorial                                                                                                                      | Eng              | production env      |

> In flight: PR #4 (`fix/minikube-docs-followups`) fixes the pf-mcp-host
> service name, the e2e-approval-flow default email, canonical bootstrap in the
> e2e-guide, two stale code comments — and commits this roadmap.
>
> Also in flight: `docs/service-readmes` (this branch) — the three P1
> service-README rows above, plus `make test-counts` (P2 test-count
> automation), the e2e-guide CLAUDE.md-era unit-test tables (P2), and the
> platform-topology namespace count (P3).

---

## 7. Definition of done for “docs launch”

- [x] Diátaxis index + learning path + FAQ
- [x] Minikube-first quickstart with felt success (desktop + JWT API)
- [x] Capability tour code-anchored in README
- [x] Claims guardrails committed
- [x] 8 CRDs documented at index level
- [ ] Legal surfaces not marked draft — LICENSE ✅ MPL-2.0 (2026-07-13); CLA.md still DRAFT (counsel)
- [ ] All platform services have a minimal README
- [ ] At least one visual proof in README
- [ ] No known broken public links (currently OK on root README)
- [x] Test claims verified by reproducible count (10,260 cases / 882 files, 2026-07-13) — CI automation still open (P2)
- [x] Release matches main (v0.2.0 on e805f47, 2026-07-13)

---

## 8. Process

- **Source of truth for public docs:** `main`
- **Claim edits:** run [claims-guardrails.md](claims-guardrails.md) checklist
- **Working notes:** `docs/superpowers/` remains local/gitignored
- **This roadmap:** update in place when major onboarding decisions change

### Superseded documents

| Document                                           | Disposition                                       |
| -------------------------------------------------- | ------------------------------------------------- |
| Worktree `readme-improvement-plan.md` (2026-07-11) | Historical; Wave 1 Compose-era decisions obsolete |
| Compose-first quickstart narrative                 | Removed on main via PR #3                         |

---

## 9. License migration — Apache-2.0 + use grant → MPL-2.0

> **Status: EXECUTED 2026-07-13** (same-day decision by Jose). LICENSE swapped
> to the canonical mozilla.org MPL-2.0 text (16,726 bytes, verified); all 33
> `package.json` license fields set to `MPL-2.0` (killing the 2× MIT
> mislabels); 30 lockfiles synced; every doc surface below flipped from
> “source-available” to open source. **Pure MPL-2.0 — no additional
> restriction.** Remaining from this motion: CLA counsel pass only.

**Decision (Jose, 2026-07-13):** replace the current provisional
“Apache-2.0 + additional use grant” with the **latest Mozilla Public License
(MPL-2.0)**. Executed as a **later step** with counsel — not part of the
current docs waves.

**Why it matters for docs:** MPL-2.0 is an **OSI-approved** license
(file-level copyleft). If adopted without any additional restriction, every
“source-available, **not** OSI open source” statement flips to genuinely open
source — a materially better trust story. If any use-grant-style restriction
is retained on top, the source-available language must stay. **Counsel decides
which; docs follow.**

**Touch list when it lands** (single PR, run the claims-guardrails gate):

- `LICENSE` (full text swap; remove provisional addendum)
- Root `README.md` — License section + license badge
- `docs/faq.md` — “Is it open source?” answer
- `docs/meta/claims-guardrails.md` — “OSI open source” row and license lines
- `CONTRIBUTING.md` (source-available phrasing), `GOVERNANCE.md`
  (“source-available / open-core style”), `docs/deploy/production.md`
  (license-boundary section), `docs/README.md` community table,
  `docs/get-started/learning-path.md` (Path E “source-available terms”)
- `CLA.md` — counsel pass in the same motion (CLA scope depends on final license)
- Per-service `package.json` `license` fields — **audit; currently mixed**
  (2026-07-13 census): 10× `"SEE LICENSE IN LICENSE"`, 2× **`"MIT"`
  (gfs-controller, packages/image-policy — wrong under the CURRENT license
  too, reconcile regardless of MPL timing)**, 7× field absent (control-api,
  control-ui, desktop-app, external-rest-api, rpc-proxy, profile-ui,
  workflow-approval-request-reader). Lockfile `license` fields follow
- `TRADEMARK.md` — unchanged (trademarks are independent of MPL)

**Done:** the former §4 non-goal (“no OSI claims”) is inverted — §4 now
forbids retaining any “source-available” / “not open source” language.
