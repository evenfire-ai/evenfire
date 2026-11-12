# Control UI Header and Table Layout Inventory

> As-built inventory for the Control UI header, section, tab, and table patterns.
> This is an evidence document for standardization work; it does not prescribe or implement a redesign.

## Audit metadata

| Field | Value |
| --- | --- |
| Product surface | `control-ui` authenticated experience |
| Repository snapshot | `4341bca13` (`feat(control-ui): overview — show member/team names in right access card`) |
| Audit date | 2026-08-19 |
| Primary audience | Frontend engineering, product, and design |
| Intended use | Choose a small set of parent and child layout families before changing code |
| Audit method | Static inspection of routes, React components, and `app/globals.css` |

## How to read this document

This inventory describes what the source currently renders and styles. It does not claim that every legacy selector is reachable in the current route tree, and it does not replace browser-level visual QA.

- **Observed** means the component/class and its values were found directly in source.
- **Inferred** means the grouping follows composition or route usage rather than an explicit design-system declaration.
- **Parent** means a sidebar-level landing surface or a sibling collection view, such as Agents, Marketplace, or Cost & Usage.
- **Child** means a resource detail, create/edit flow, nested panel, or subsection inside a parent.
- **Header width** means the width of the header’s containing surface. There is no independent `TablePanelHeader` width token; it fills its card or panel.
- **Viewport fill** means `cu-card--viewport-fill`: a flex column card whose body/table can fill the available height and whose panel header/table header can remain sticky.

The measurements below are CSS values, not measurements taken from a screenshot. Values expressed in `rem` resolve from the browser root size; values expressed as percentages or `min()` depend on the containing surface.

## Executive summary

The Control UI already has a strong reusable center of gravity, but it is surrounded by several local variants:

1. **Parent collection surfaces mostly share one header primitive.** `TablePanelHeader` is used for Agents, Contexts, connectors, guardrails, plugins, Marketplace, files, outputs, users/teams, cost, LLM models, secrets, settings, and traces.
2. **The parent header is visually stable but not geometrically uniform.** The header itself is always full-width within its surface, while the containing surface ranges from the normal `1120px` app column to full-height route shells, `72rem` settings, and `74rem` create/detail panels.
3. **There are two real tab controls, not six.** `TabBar` is the default underline tab pattern. `SegmentedControl` is the filled, compact alternative. Most apparent tab variation comes from placement modifiers such as `flush`, `compact`, and Marketplace’s extra indentation.
4. **Child/detail surfaces have a preferred shell, but adoption is incomplete.** `DetailPageShell` composes `CreateFlowPanel`, `CreatePageHeader`, and an optional `TabBar`. Context, shared-filesystem, and several other detail routes compose the pieces manually; guardrail detail and workflow-run detail bypass the family entirely.
5. **Tables have one base treatment with meaningful density variants.** The shared table typography, padding, borders, sticky behavior, and hover color are consistent. Header bands, expandable rows, profile tables, sticky analytical tables, and plain nested tables create the visible variation.
6. **The biggest standardization risk is nested content, not parent list headers.** Parent tables usually use `cu-table--header-band`; child tables frequently use plain `cu-table`, raw `<th>`/`<td>` styling, and inline widths.

### Candidate taxonomy for the next phase

This is a grouping of existing patterns, not a final visual recommendation:

| Candidate family | What it covers | Current status |
| --- | --- | --- |
| **P1 — Parent data surface** | A sidebar-level collection with card, `TablePanelHeader`, search/actions, and table or body | The dominant pattern; should be the baseline parent family |
| **P2 — Parent analytical/tabbed surface** | Same parent header with filters, metrics, route tabs, or multiple table bodies | Cost, Outputs, LLM Models, Secrets, Traces, Marketplace Org |
| **C1 — Child detail shell** | Resource title, subtitle, actions/back control, optional tabs, and connected content card | Preferred through `DetailPageShell`; not universal |
| **C2 — Child section/table** | A subsection inside a detail or parent body | Many local implementations; currently the largest source of drift |
| **C3 — Create/edit wizard** | Create header, optional step rail, form sections, footer/actions | A distinct flow pattern, not a parent-list header |
| **S1 — Dense/specialized data** | Expandable, fixed-layout, wide analytical, profile, or responsive trace tables | Keep as table behavior variants under the parent/child families |

## 1. Shared frame and layout primitives

### 1.1 Application frame

| Layer | Current values | Visual treatment | Evidence |
| --- | --- | --- | --- |
| Desktop sidebar | `16rem` wide, sticky, `100vh`, vertical scroll | Surface gradient, right border, `1.5rem 1rem` padding | `control-ui/app/globals.css:9917-9935` |
| Sidebar parent item | `.65rem .85rem` padding, `.875rem` text, `8px` radius | Muted text; active item uses `--cu-accent-muted` and `--cu-text` | `control-ui/app/globals.css:10017-10047` |
| Sidebar child item | `--cu-space-1 .85rem` padding, `.875rem` text | Softer text, same small radius; `18px` icon box with `14px` icon | `control-ui/app/globals.css:10117-10146` |
| Main desktop column | Flex sibling of sidebar; default bottom padding `3rem` | Route-specific full-height shells remove or replace the default padding | `control-ui/app/globals.css:10190-10242` |
| Normal app content | `max-width: 1120px`; centered; `1.5rem 1rem 3rem` padding | Used by ordinary content that does not opt into a viewport shell | `control-ui/app/globals.css:678-682` |
| Narrow app content | `max-width: 420px` | Auth/small utility layout | `control-ui/app/globals.css:684-686` |
| Viewport card | `min-height: 100%`, flex column; child body/table flexes | Header and table headers become sticky; table body scrolls within card | `control-ui/app/globals.css:938-999` |
| Mobile header | `4rem` high, fixed, full width | Surface background and bottom border; sidebar becomes a fixed drawer below it | `control-ui/app/globals.css:10514-10582` |
| Mobile content | `1rem` app padding; main gets `4rem` top padding | Standard search expands to full width | `control-ui/app/globals.css:10630-10644` |

### 1.2 Shared color and shape tokens

The two themes use the same semantic names. Most headers, cards, borders, tabs, and tables consume these tokens rather than defining route-specific colors.

| Semantic role | Dark theme | Light theme | Used by |
| --- | --- | --- | --- |
| Page background `--cu-bg` | `#0e0f10` | `#f7f9ff` | App background |
| Elevated background `--cu-bg-elevated` | `#141517` | `#ffffff` | Forms, nested sections, dialogs |
| Surface `--cu-surface` | `#141518` | `#fbfdff` | Cards and header base |
| Surface hover `--cu-surface-hover` | `#1b1d21` | `#eef4ff` | Table header band, hover controls |
| Border `--cu-border` | `#303338` | `#cfdaf2` | Card and control outlines |
| Subtle border `--cu-border-subtle` | `#272a2f` | `#dfe7f8` | Table row/header separators |
| Primary text `--cu-text` | `#f2f2ef` | `--cu-brand-dark-blue` (`#02123c`) | Titles and body text |
| Muted text `--cu-text-muted` | `#c6c8cc` | `#405175` | Secondary labels and table headers |
| Soft text `--cu-text-soft` | `#92969e` | `#667593` | Descriptions, metadata, local headings |
| Accent `--cu-accent` | `#4377fa` | `#4377fa` | Active tabs, primary actions, focus |
| Accent hover | `#6a94ff` | `#2f5fea` | Hover/active emphasis |
| Link | `#8faeff` | `#2f5fea` | Inline navigation |
| Success | `#66b88f` | `#2f8a66` | Ready/healthy/complete states |
| Warning | `#e8c27a` | `#a16b2b` | Warning/pending states |
| Danger | `#f87171` | `#bf4d47` | Error/destructive states |
| Card radius `--cu-radius` | `12px` | `12px` | Cards, create panels, dialogs |
| Small radius `--cu-radius-sm` | `8px` | `8px` | Controls, form sections, nested panels |
| Pill radius | `999px` | `999px` | Chips/badges/round controls |
| Card shadow | `0 8px 24px rgba(5,8,12,.32)` | `0 8px 24px rgba(2,18,60,.1)` | Cards and dialogs |

Source: `control-ui/app/globals.css:1-110`.

### 1.3 Spacing scale

| Token | Value |
| --- | --- |
| `--cu-space-1` | `.35rem` |
| `--cu-space-2` | `.5rem` |
| `--cu-space-3` | `.75rem` |
| `--cu-space-4` | `1rem` |
| `--cu-space-5` | `1.25rem` |

Source: `control-ui/app/globals.css:47-64`.

## 2. Header pattern catalog

### H1 — Parent `TablePanelHeader`

> `H1` is an inventory label for the first header family, not a claim about the DOM heading level. The current component intentionally renders a title span.

This is the default parent/list header and the most reusable header in the app.

| Property | Current implementation |
| --- | --- |
| Component | `components/TablePanelHeader/index.tsx` |
| DOM title semantics | Wrapper is a `div`; title is a `span.cu-panel-title`, not an `h1`/`h2` |
| Header width | `100%` of the containing card/panel; no independent max-width |
| Height | Content-driven; base padding is `.85rem 1rem` (`~13.6px` vertical, `16px` horizontal) |
| Layout | Flex, start-aligned, space-between, wrapping; gap `.65rem` |
| Title row | Flex, centered, gap `--cu-space-1` (`.35rem`) |
| Header type | `.9375rem` (`15px`), weight `600` |
| Subtitle | `.75rem` (`12px`), weight `500`, `--cu-text-soft`; `0.2rem` grid gap below title |
| Background | Vertical gradient from `rgba(var(--cu-edge-rgb), .2)` to `--cu-surface`, layered over `--cu-surface` |
| Separator | `1px solid --cu-border-subtle` |
| Actions | Flex, start-aligned, gap `.4rem`; can receive a route modifier |
| Default search | `width: min(13rem, 100%)`, `min-width: 9rem` |
| MCP search | `width: min(11rem, 100%)`, `min-width: 8.5rem` |
| Registry search | Fixed `13rem` on desktop; full-width on mobile |
| Sticky behavior | Direct child of a viewport-fill card is sticky at `top: 0`, `z-index: 4` |

Evidence: `control-ui/components/TablePanelHeader/index.tsx:7-27` and `control-ui/app/globals.css:2351-2408`.

**Typical content:** icon + title/count on the left; search, refresh, and a primary action on the right. Examples include `HostTable`, `ContextTable`, `McpServerTable`, `RegistryCatalog`, `ProfileAdminHome`, `LlmModelTable`, `UsageDashboard`, and `GovernedTraceSurface`.

### H2 — Child/detail `CreatePageHeader` inside `DetailPageShell`

This is the preferred resource-detail header, although several routes compose it manually or bypass it.

| Property | Create/edit default | Detail-flow override |
| --- | --- | --- |
| Component | `components/CreatePageHeader/index.tsx` | Same component under `.cu-detail-flow-panel` |
| DOM title semantics | `<h2 class="cu-title cu-heading-with-icon cu-create-title">` | Same markup |
| Header width | `74rem` max inside `.cu-agent-create-panel--with-header`; detail flow becomes `100%` | `100%` of the main content column |
| Title size | `.cu-create-title` `1.125rem` | `.9375rem`, line-height `1.2` |
| Subtitle | Normal `.cu-subtitle` style | `.75rem`, `--cu-text-soft` |
| Header layout | Two flex regions: title/meta on left, actions/back on right; wraps | Same, but tabs can sit below in the panel |
| Panel border/radius | `1px --cu-border`, `12px` radius, shadow | Bottom border/radii removed so content card visually joins below |
| Header background | `rgba(var(--cu-edge-rgb), .08)` | Transparent |
| Header padding | `1rem 1rem .95rem` | Inherited header padding; detail tab row adds `.75rem 1rem .5rem` |
| Actions | Wrap, right-justified, `.5rem` gap; back control is a small ghost button | Same |

Evidence: `control-ui/components/CreatePageHeader/index.tsx:6-44`, `control-ui/components/DetailPageShell/index.tsx:11-75`, and `control-ui/app/globals.css:4918-4953`, `5594-5716`.

The canonical composition is:

```text
DashboardLayout(isDetailPage)
└── CreateFlowPanel.cu-detail-flow-panel
    ├── CreatePageHeader
    └── optional TabBar
└── notice/error
└── connected content card or detail content stack
```

The following routes currently use this family or its equivalent: host detail, user detail, team detail, workflow recipe detail, context detail, connector edit, shared filesystem detail, registry entry detail/edit, communication channel edit, and most create/install flows.

### H3 — Create/install wizard header and step rail

This is a flow-specific family and should not be treated as a third parent header.

| Property | Current value |
| --- | --- |
| Outer width | `min(74rem, 100%)` for `.cu-create-panel`; `min(74rem, calc(100% - 2 * 1.25rem))` for `.cu-agent-create-panel` |
| Outer shape | `12px` radius, `1px --cu-border`, surface/panel gradient, shared shadow |
| Header | `.cu-agent-create-panel__header`, `1rem 1rem .95rem` padding, `rgba(var(--cu-edge-rgb), .08)` background |
| Wizard columns | Step rail `minmax(13.5rem, 15rem)` plus flexible content |
| Step rail | `1.9rem 1.6rem` padding, right border, `rgba(var(--cu-edge-rgb), .08)` background |
| Step number | `1.95rem` square/circle, `12px` text; accent halo for current, success color for complete |
| Step panel | `1.9rem 2.35rem 1.1rem` padding |
| Step title | `1.15rem`, weight `600` |
| Step subtitle | `.875rem`, `--cu-text-soft` |
| Form section | `8px` radius, `1rem` padding, elevated background; title `.95rem`, description `.8125rem` |

Evidence: `control-ui/app/globals.css:5683-5764`, `5866-6004`, and `control-ui/components/ui/index.tsx:56-65`.

### H4 — Local subsection/form headers

These are child-level headers, not alternatives for a parent route header.

| Pattern | Size and spacing | Surface treatment | Examples |
| --- | --- | --- | --- |
| `FormSection` | Title `.95rem`/`600`; description `.8125rem`; `1rem` padding; `.75rem` internal gap | `1px --cu-border`, `8px` radius, `--cu-bg-elevated` | Create/edit forms, guardrail detail, SDK panels |
| Settings section | Title `1rem`/`600`; section top padding `1rem`; sections separated by subtle top border | No individual card border; lives inside `cu-settings-card__body` | Settings |
| Profile section label | `.8125rem`/`600`, uppercase, `.04em` tracking, soft text | No enclosing header surface | Users, teams, admins tabs |
| Workflow access section | Local bold title and `.875rem` description | `12px` radius, subtle border, elevated background, `1rem` padding | Recipe detail access panel |
| Host identity section | Title `1.125rem`; metadata `.8125rem` | Subtle border, `8px` radius, elevated background, `1rem` padding | Host Identity tab |
| Trace detail section | Section heading `.9375rem`; description and metadata `.75rem` | Full-width section with `1rem` padding and bottom separator | Trace detail pages |

Evidence: `control-ui/app/globals.css:290-350`, `587-613`, `4156-4223`, and the local component styles for `WorkflowAccessPanel`, `HostIdentityTab`, and profile admin.

### H5 — Specialized/operator headers

These are legitimate special cases, but they should be tracked explicitly rather than allowed to become accidental parent variants.

- **Trace surfaces:** use H1 `TablePanelHeader`, then add a filter row, summary metrics, and a wide table. The title/header remains shared; the body is analytical and dense.
- **GFS current browser:** uses H1 in `GfsBrowser`, followed by a breadcrumb/action toolbar. Older `.cu-gfs__header` styles still define a more prominent hero-icon/title header with a `2.75rem` icon, description max width `46rem`, and a two-column explorer (`14rem–18rem` tree plus flexible content). Current route composition should be verified before deleting either family. Evidence: `control-ui/components/GfsBrowser.tsx:749-837`, `control-ui/app/globals.css:11261-11364`, `11562-11617`.
- **GFS dialogs:** image/Markdown preview dialogs are `min(60rem, viewport minus 2 * 1rem)` by `min(47.5rem, viewport minus 2 * 1rem)`, with `1rem` title text and `1rem .75rem` header padding. Manage dialogs use a three-column header, `1rem 1.25rem` padding, a `2.25rem` icon, and a `1.375rem` title. Evidence: `control-ui/app/globals.css:11906-11940`, `12154-12279`.

## 3. Parent-section inventory

All rows below are parent-level unless marked as a nested parent/tab surface. The header family column describes the route-specific delta from H1; values not repeated are inherited from H1.

| Parent surface / route | Outer surface and width | Header and tabs | Table/body layout | Key width and color evidence |
| --- | --- | --- | --- | --- |
| **Users & Teams** `/profile-admin/users` | `cu-card cu-card--viewport-fill`; current component adds inline `margin-bottom: 1.25rem` | H1 with Users & Teams icon/title, explanatory subtitle, search, refresh, create/invite actions; one flush-top `TabBar` for Users/Teams/Admins | Profile tables use `cu-table--profile cu-table--header-band`; multiple sections in one scrolling card | Profile table is `100%`; reusable role/date/action columns are `5.5rem`, `9rem`, `11rem`, and `14rem`; section labels uppercase soft text. Evidence: `ProfileAdminHome.tsx:432-584`, `globals.css:8916-8992`. |
| **Agents** `/hosts` | Viewport-fill card; inline `margin-bottom: 1.25rem` | H1: icon, `Agents` plus count, “Manage available agents and their host mappings.”, search, refresh, Create agent | Header-band table; clickable rows; shared `TableHeaderRow` | Name intrinsic; Context `20%`; Providers `min-width: 8rem`; actions `3.5rem`. Evidence: `HostTable.tsx:16-21`, `166-224`. |
| **Contexts** `/contexts` | Viewport-fill card; inline `margin-bottom: 1.25rem` | H1: icon, count, “Group connectors into reusable access scopes.”, search, refresh, create | Header-band clickable table | Connectors `7rem`; actions `8rem`; name intrinsic. Evidence: `ContextTable.tsx:16-20`, `84-140`. |
| **Installed connectors** `/mcp-servers` | Viewport-fill card plus `cu-section-card` (`margin-bottom: 1.25rem`) | H1 with connector-specific action class; search is narrower (`11rem` max, `8.5rem` min); title actions include overflow/create affordances | Header-band, fixed-layout, expandable rows and detail insets | Minimum table width `48rem`; expand column `3rem`; name `45%` max; enabled `8rem`; status `10rem`; action column `max(7rem, calc(55% - 21rem))`. Evidence: `McpServerTable.tsx:25-31`, `406-490`; `globals.css:1884-1928`. |
| **Installed Guardrails** `/guardrails` | Viewport-fill card plus `cu-section-card` | H1 with guardrail icon/count, search, refresh, install action | Header-band, fixed-layout, expandable rows | Minimum table width `52rem`; expand `3rem`; name `30%`; order `5rem`; fail mode `8rem`; status `9rem`; actions `6rem`. Evidence: `GuardrailHooksTable.tsx:20-28`, `130-186`; `globals.css:1930-1974`. |
| **Installed plugins** `/plugins` | Viewport-fill card plus `cu-section-card` | H1 with workflow icon/count and search/refresh/action controls | Header-band, fixed-layout installed-plugin table | Minimum table width `44rem`; columns `20% / 15% / 15% / 50%`. Evidence: `RecipesTab.tsx:17-25`, `67-132`; `globals.css:2253-2273`. |
| **Shared filesystems** `/shared-filesystems` | Viewport-fill card | H1 with shared-files icon, search, refresh, New action | Header-band table; ordinary horizontal overflow | Actions `8rem`; other columns intrinsic. Evidence: `app/shared-filesystems/page.tsx:23-30`, `158-216`. |
| **External channels** `/communication-channels` | Viewport-fill card; inline `margin-bottom: 1.25rem` | H1 with broadcast icon/count, “Route channel messages to the selected agent.”, search, refresh, Add channel | Header-band table | Agent `18%`; Type `18%`; actions `7rem`. Evidence: `CommunicationChannelsTable.tsx:31-36`, `162-234`. |
| **Marketplace connectors** `/marketplace/connectors` | `cu-registry-layout`; child viewport-fill card fills the route shell | H1 with Marketplace icon, discovery subtitle, search, category/agent filter, Connect action; `MarketplaceTabs` below header | Header-band, fixed-layout, expandable catalog table | Minimum table width `52rem`; expand `3rem`; category/status columns `7rem`, `7rem`, and `4.75rem`; registry search fixed `13rem`, controls `38px` tall on desktop. Evidence: `RegistryCatalog.tsx:273-338`; `globals.css:2424-2584`. |
| **Marketplace organization** `/marketplace/org/*` | Full viewport-fill rounded card inside a detail-ish route; nested panels may also be cards | H1 “Marketplace” with org-owned subtitle; outer `MarketplaceTabs` for Connectors/organization, then inner flush `TabBar` for Entries/Images/Credentials/Connection | Body varies by inner tab; child API-key/image tables are usually plain `.cu-table`, not header-band | Outer H1 inherits `12px` card/radius and gradient. Organization area evidence: `MarketplaceOrgArea/index.tsx:57-119`; nested image table: `MarketplaceOrgImages/index.tsx:67-130`; tabs: `MarketplaceTabs.tsx:15-43`. |
| **Agent Outputs** `/outputs` | Viewport-fill card; inline `margin-bottom: 1.25rem` | H1 with output icon/count and subtitle; search/refresh; flush-top output `TabBar` inside body | Multiple header-band tables selected by tab; body also contains notices/empty states | Table cells include local inline format colors (`pdf #ef4444`, `xlsx #22c55e`, `html #f59e0b`, with other values using tokens). Evidence: `app/outputs/page.tsx:116-124`, `129-318`. |
| **Global File System** `/gfs` | `cu-gfs` full-height flex inside `cu-gfs-card cu-card cu-card--viewport-fill` | Current route uses H1; inner breadcrumb/action toolbar is a second horizontal control row | Explorer/list body; current panel is transparent inside the card; legacy hero header also exists in CSS | Current toolbar uses `padding .75rem 1rem`; breadcrumb has `8px` radius, subtle border, elevated background. Legacy explorer tree is `minmax(14rem,18rem)` plus flexible panel. Evidence: `GfsBrowser.tsx:749-837`; `globals.css:11562-11658`, `11261-11364`. |
| **Cost & Usage — Usage** `/cost/usage` | `.cu-cost-layout`; viewport-fill card gets available height; route shell has `.75rem .75rem 0` padding and `.75rem` gap | H1 with usage icon/title and tracking subtitle; refresh action | Analytics body: filter panel, metric cards, charts, inner panels; no primary table | Cost shell is full available width/height rather than normal `1120px` page padding. Stats cards use `min-width: 9.5rem`; inner panels use `1rem`-scale spacing. Evidence: `CostShell/index.tsx:8-15`, `UsageDashboard/index.tsx:386-409`; `globals.css:2424-2440`, `1073-1156`. |
| **LLM Prices** `/cost/llm-prices` | Cost shell + viewport-fill card + `cu-section-card` | H1 with LLM icon/count, per-model pricing subtitle, search, refresh, Add price | Header-band table | Provider `10%`; Model `min-width 10rem`; Currency/Enabled `6rem`; Actions `5rem`; numeric columns right-aligned. Evidence: `LlmPriceTable.tsx:18-37`, `102-160`. |
| **Token Budgets** `/cost/token-budgets` | Cost shell + viewport-fill card | H1 with budget icon/count, budget subtitle, search, refresh, Add budget | Header-band table with progress cell | Name `min-width 9rem`; Scope `min-width 12rem`; Unit `6rem`; Period `7rem`; Progress `min-width 12rem`; Limit `5.5rem`; Enabled `6rem`; Actions `8rem`. Evidence: `TokenBudgetTable.tsx:22-35`, `71-127`. |
| **LLM Models** `/llm-models` | `.cu-llm-models-layout`, vertical scroll with `.75rem .75rem .75rem 0` padding; each section card is viewport-fill | H1 for model table; route-level `TabBar` for management/discovery; Discovery uses the same H1 family | Sticky header-band model table; grouped rows; discovery review table is another fixed/sticky table | Model table minimum width `68rem`, fixed layout; Model `min-width 15rem`; Vendor `10rem`; capability/metadata columns include `10rem`, `9rem`, `6rem`, `7rem`, Actions `5rem`. Evidence: `LlmModelTable.tsx:218-234`, `237-330`; `globals.css:10711-10734`. |
| **Secrets** `/secrets` | Viewport-fill card; inline `margin-bottom: 1.25rem` | H1 with secrets icon/count, search/refresh; flush-top tabs for secret scopes | Several header-band tables in one card; tables use local inline width definitions | Repeated actions `8rem`; attached connector/source tables `36% / 34% / 8rem`; recipe-use tables `32% / 32% / 8rem`. Evidence: `SecretsTable.tsx:482-575`, `606-846`. |
| **Traces — operations, administrative, infrastructure** `/traces/*` | `.cu-trace-layout`; full-height flex shell with `.75rem .75rem 0` padding and `.75rem` gap | H1 with time-window/filter/search/refresh controls; summary row sits between header and table | Sticky header-band trace table with filter/summary content; route-specific dense variants | Explorer table minimum width `76rem`; detail table minimum width `58rem`; trace state chips use success/danger/warning token RGB backgrounds. Evidence: `GovernedTraceSurface/index.tsx:310-450`, `GovernedEventExplorer/index.tsx:126-204`, `globals.css:3020-3032`, `4090-4092`, `4124-4142`, `4221-4223`. |
| **Settings** `/settings` | Viewport-fill `cu-settings-card`; max width `72rem`, centered | H1 with settings icon and account/theme subtitle; no table-specific toolbar | Scrollable body made of separated settings sections and rows | `max-width: 72rem`; section title `1rem`; section top padding `1rem`; subtle top separators. Evidence: `ControlSettingsPanel/index.tsx:244-255`, `globals.css:290-350`. |
| **Plugin workload SDK** `/plugin-workload-sdk` (hidden/utility) | Viewport-fill card | H1 with SDK-specific controls | Plain tables rather than header-band in the SDK views | Utility surface, not a sidebar parent; evidence: `app/plugin-workload-sdk/page.tsx:296-320`, `app/plugin-workload-sdk/Views.tsx:119-143`, `272-279`. |

### Parent inventory findings

- The **header implementation is more consistent than the outer spacing**. Several cards use inline `marginBottom: '1.25rem'`; others use `cu-section-card`; viewport-fill itself force-resets margin-bottom to `0 !important`.
- The **parent width policy is route-driven**, not parent-driven: normal pages use `1120px`, while registry, cost, LLM, traces, and GFS intentionally use full-height layouts. This is the main reason identical H1 headers can appear to have different widths.
- The most meaningful parent differences are **body behavior**: ordinary list, expandable list, wide analytical table, profile administration, tabbed multi-table body, analytics dashboard, and file explorer.

## 4. Child and detail inventory

### 4.1 Detail routes using the preferred shell

| Child surface | Header composition | Tabs | Content/table treatment | Current family |
| --- | --- | --- | --- | --- |
| Agent detail `/hosts/[name]` | `DetailPageShell` → detail-flow `CreatePageHeader`; title `Agent: <name>`, subtitle “Configuration and access for this agent.” | Compact tabs; child tabs include Overview, Access, Identity, Advanced depending on route state | Overview is card-based; Access uses local section header + header-band table; Advanced uses static header-band table; Identity uses local identity section | C1 shell + C2 local tab sections |
| Context detail `/contexts/[name]` | Manually composed detail-flow panel + `CreatePageHeader`; title/display name and route name; subtitle about connectors, agents, teams, members | Compact tabs | Multiple local description/action rows and plain `.cu-table` tables; column widths are inline or component-defined | C1-equivalent shell, but child tables drift to plain style |
| Connector edit `/mcp-servers/[name]/edit` | Detail-flow `CreatePageHeader`; “Edit Connector: …” | Compact connector-edit tabs | Form sections (`FormSection`) and wizard/form content | C1 + C3/C2 |
| Shared filesystem detail `/shared-filesystems/[name]` | Manually composed detail-flow `CreatePageHeader`; no detail tabs | None | Connected detail card with metadata toolbar and plain file table; file table uses `Name min-width 14rem`, `Size 9rem`, `Modified 14rem`, Actions `17rem` | C1-equivalent shell + wide child table |
| User detail `/profile-admin/users/[userId]` | `DetailPageShell`; member title/subtitle and actions | Detail tabs | Several local section headings/actions and plain tables; inline widths commonly `10rem`, `6rem`, `4rem` | C1 shell + C2 local tables |
| Team detail `/profile-admin/teams/[teamId]` | `DetailPageShell`; team title/actions | Detail tabs; nested existing/invite tab control | Multiple plain child tables with local inline action columns (`4rem`, `6rem`, `8rem`, `10rem`, `12rem`) | C1 shell + nested C2 |
| Workflow recipe detail `/workflow-recipes/[namespace]/[name]` | Detail-flow/create header; recipe title, subtitle, actions | Detail tabs/recipe navigation as applicable | Nested Workloads, Conditions, Integrations, Secrets, and access panels; many tables are plain `.cu-table` inside nested cards | C1 shell + many C2 variants |
| Marketplace entry detail `/marketplace/entries/[name]/[version]` | Detail-flow `CreatePageHeader`; entry title and version/author/type subtitle | Usually no detail tab row | Connected content card; overview uses subtle-border, `8px` radius, `rgba(edge,.06)` nested surface | C1 shell + C2 nested overview |
| Communication channel edit `/communication-channels/[name]/edit` | Detail-flow `CreatePageHeader`; edit title and subtitle | No standard detail tab row | Create/edit form sections and local channel configuration sections | C1 + C3 |

Evidence for the shared shell: `control-ui/components/DetailPageShell/index.tsx:35-74` and `control-ui/app/globals.css:4895-4982`. Representative route evidence: host `app/hosts/[name]/page.tsx:814-845`, context `app/contexts/[name]/page.tsx:844-877`, connector `app/mcp-servers/[name]/edit/page.tsx:300-327`, shared filesystem `app/shared-filesystems/[name]/page.tsx:319-411`, and registry entry `app/registry/entries/[name]/[version]/page.tsx:255-304`.

### 4.2 Child/detail routes that bypass or partially bypass the shell

| Child surface | Current implementation | Why it matters for standardization |
| --- | --- | --- |
| Guardrail detail `/guardrails/[name]` | Plain `DashboardLayout`; top ghost back button; then `FormSection` titled with the guardrail name and a second `FormSection` containing a header-band table | No `CreatePageHeader`, no connected detail header, and no consistent detail title/subtitle region. This is the clearest full-shell outlier. Evidence: `app/guardrails/[name]/page.tsx:170-287`. |
| Recipe secret edit `/secrets/recipe/[name]/edit` | Direct `CreatePageHeader` followed by a separate `.cu-create-panel`; it is not wrapped by `CreateFlowPanel` | Header, panel, radius, and width are siblings rather than one connected create/detail surface. Evidence: `app/secrets/recipe/[name]/edit/page.tsx:176-206`. |
| Workflow run detail `/workflow-recipes/.../runs/[runId]` | Direct `CreatePageHeader` under `DashboardLayout`; breadcrumbs include local inline styles; no `DetailPageShell` or detail-flow panel | A second child title pattern with different spacing and no connected header/content relationship. Evidence: `app/workflow-recipes/[namespace]/[name]/runs/[runId]/page.tsx:48-75`. |
| Recipe nested panels | `RecipeIntegrationsPanel`, `RecipeSecretsPanel`, and recipe page panels use nested cards with H1-style `TablePanelHeader`, but tables are generally plain `.cu-table` | Child panels visually borrow the parent header while retaining a different table treatment; action widths are inline (`12rem`, `8rem`, `50%`, etc.). Evidence: `RecipeIntegrationsPanel/index.tsx:215-257`, `RecipeSecretsPanel/index.tsx:160-211`, `app/workflow-recipes/[namespace]/[name]/page.tsx:804-1100`. |
| Registry publisher legacy path | `PublisherView` uses a card, H1, and flush tabs for Owned Entries/Granted to Me/Docker Credentials | Parallel implementation to current Marketplace organization area; should be classified as current, legacy, or dead before standardization. Evidence: `components/PublisherView/index.tsx:66-89`. |

### 4.3 Create/edit surfaces

Most create and edit routes use H3 and should remain a distinct family from parent collection headers. Current examples include:

- Agents, Contexts, connectors, shared filesystems, users, teams, control admins, LLM models, cost prices, token budgets, secrets, communication channels, registry install/publish/edit, and Marketplace entry edit.
- Form-heavy child sections generally use `FormSection`, which is the most consistent nested form container in the codebase.
- Some create/edit surfaces use the full step rail; others use a single form body inside the same outer panel. The outer width/radius family is shared, but vertical density varies with the route.

Evidence: `control-ui/components/CreateFlowPanel/index.tsx:4-9`, `control-ui/app/globals.css:5683-5764`, and the route-level `CreatePageHeader` usages listed by `rg` across `control-ui/app`.

## 5. Tab and sub-tab inventory

### 5.1 Default tab control

`TabBar` emits `.cu-tabs` and `.cu-tab`.

| Property | Current value |
| --- | --- |
| Container | Flex/wrap, `2px` gap, `2px` bottom padding |
| Default margin | `1.25rem 0 1rem` |
| Tab height | `min-height: 32px` |
| Tab horizontal padding | `10px` |
| Tab type | `.8125rem`, weight `600` |
| Shape | No radius; transparent background; `2px` bottom border |
| Inactive | `--cu-text-muted` |
| Hover | `--cu-text`, edge-colored bottom border |
| Active | `--cu-text` and `rgba(var(--cu-accent-rgb), .72)` bottom border |
| Compact modifier | `margin-top: .25rem` |
| Flush-top modifier | `margin-top: 0` |
| Flush modifier | `margin: 0` |
| Tight modifier | `margin: 0 0 1rem` |
| Marketplace modifier | `margin-inline-start: 1rem` |

Evidence: `control-ui/components/TabBar/index.tsx:8-49` and `control-ui/app/globals.css:1569-1695`.

### 5.2 Filled segmented control

`SegmentedControl` is visually different enough to remain a separate control: width `min(100%, 24rem)`, `8px` outer radius, elevated background, `34px` options, and an accent-filled active option with inverse text. It is not a parent header and should not be merged with underline tabs merely because both switch views. Evidence: `control-ui/app/globals.css:1613-1662`.

### 5.3 Nested tab compositions

| Surface | Tab hierarchy | Current placement |
| --- | --- | --- |
| Marketplace | Outer Connectors/organization tabs → inner Org entries/images/credentials/connection tabs | Outer tabs sit after H1; inner tabs sit at the top of the body, usually flush-top |
| Users & Teams | Users/Teams/Admins | One flush-top tab row inside the parent card body |
| Outputs | Recipe artifacts/Desktop app artifacts | One flush-top tab row inside the parent body, followed by tab-specific table |
| Secrets | Secret scope tabs | One flush-top tab row, then several table sections |
| LLM Models | Management/discovery route tabs | Route-level tab row around the section/table; discovery has its own filter/navigation bar |
| Host detail | Overview/Access/Identity/Advanced | Compact tabs in the detail-flow header; Access and Identity add another local tab row |
| Context detail | Context-specific sections | Compact tabs in detail-flow header; body still uses local action headers |
| Connector edit | Connector edit sections | Compact detail tabs in the detail-flow header |
| Recipe access | Access tab plus Existing/Invite inner switch | Outer detail tabs plus local workflow access tabs |
| Sidebar parent/child navigation | Cost, Files, and hidden Traces have nested sidebar items | Sidebar subitems use separate padding/icon treatment, not content tabs |

The visible complexity in Marketplace and detail routes is therefore mostly **hierarchy depth**, not a proliferation of tab CSS. The standard underline tab primitive has several placement modifiers.

## 6. Table layout inventory

### 6.1 Shared base table

| Property | Current value |
| --- | --- |
| Width | `100%` |
| Font size | `.875rem` body |
| Table layout | Browser default unless a specialized class sets fixed layout |
| Header padding | `.65rem .85rem` |
| Header type | `.7rem`, weight `600`, uppercase, `.05em` letter spacing |
| Header color | `--cu-text-muted` |
| Header background | `--cu-surface` |
| Cell padding | `.7rem .85rem` |
| Row separator | `1px --cu-border-subtle` on cells |
| Vertical alignment | `middle` |
| Row hover | `rgba(var(--cu-accent-rgb), .1)` |
| Horizontal overflow | `.cu-table-wrap { overflow-x: auto }` |

Evidence: `control-ui/app/globals.css:1697-1755`.

### 6.2 Table variants

| Variant | Classes/behavior | Current users | Width/spacing evidence |
| --- | --- | --- | --- |
| Standard header band | `.cu-table--header-band` changes header background to `--cu-surface-hover` and removes gradient image | Most parent collection tables and many trace/profile tables | Same base table dimensions; band is a color variant, not a new header height |
| Sticky viewport table | Viewport-fill selector or `.cu-table-wrap--sticky-header` makes `<th>` sticky at `top: 0`, `z-index: 2` | Parent viewport cards, LLM models, traces, profile admin | Depends on scroll container; header can remain while rows scroll |
| Expandable fixed table | `.cu-expandable-table { table-layout: fixed }` plus row-detail inset CSS | Connectors, guardrails, Marketplace catalog | Connector min `48rem`; guardrail min `52rem`; Marketplace min `52rem` |
| Installed-plugin fixed table | `.cu-installed-plugins-table` | Installed plugins | Min `44rem`; `20% / 15% / 15% / 50%` |
| LLM model fixed table | `.cu-llm-model-table` | LLM model allowlist | Min `68rem`; columns use explicit width/min-width values |
| Profile table | `.cu-table--profile` plus profile-specific column classes | Users, teams, admins | Full width; reusable action columns `11rem`/`14rem`, dates `9rem`, count `5rem` |
| Static rows | `.cu-table--static-rows` disables hover background | Host Advanced and other non-interactive status tables | Same base dimensions; behavioral variant only |
| Plain nested table | `.cu-table` without `header-band` | Context detail, user/team detail, recipe panels, Marketplace child panels, SDK | Uses base surface header and often raw/inline column widths |
| Trace explorer table | Header band + sticky wrapper + special responsive rules | Session replay, administrative/infrastructure explorers | Min `76rem` on desktop; below `720px`, cells become block/grid with `data-label` labels |
| Trace detail table | Header band + detail section wrappers | Trace detail pages | Min `58rem`; detail facts use `minmax(12rem, 1fr)` grid |
| Loading table | Same table class with skeleton rows and sometimes inline widths | Most list surfaces | Skeleton widths are often inline and can make loading geometry differ from loaded geometry |

### 6.3 Table column width evidence by parent

| Table | Explicit column policy |
| --- | --- |
| Agents | Context `20%`, Providers `min-width 8rem`, Actions `3.5rem` |
| Contexts | Connectors `7rem`, Actions `8rem` |
| Shared filesystems | Actions `8rem` |
| External channels | Agent `18%`, Type `18%`, Actions `7rem` |
| Connectors | CSS fixed layout; `3rem`, `45%`, `8rem`, `10rem`, remaining action formula |
| Guardrails | CSS fixed layout; `3rem`, `30%`, `5rem`, `8rem`, `9rem`, `6rem` with omitted columns intrinsic |
| Plugins | CSS fixed layout; `20%`, `15%`, `15%`, `50%` |
| Marketplace | CSS fixed layout; `3rem`, two `7rem` columns, `4.75rem`, action inset |
| LLM models | Model `min-width 15rem`, Vendor `10rem`, capability column `min-width 10rem`, metadata `9rem/6rem/7rem`, Actions `5rem` |
| LLM prices | Provider `10%`, Model `min-width 10rem`, Currency/Enabled `6rem`, Actions `5rem` |
| Token budgets | `9rem / 12rem / 6rem / 7rem / 12rem / 5.5rem / 6rem / 8rem` across named fields |
| Profile admin | Shared semantic classes: narrow `6rem`, count `5rem`, role `5.5rem`, date `9rem`, actions `11rem`, wide actions `14rem` |
| Trace explorer | Column definitions use mostly `8rem–14rem` minimums; rendered table min `76rem` |
| Trace detail | Column definitions use `6rem–14rem` minimums; rendered table min `58rem` |
| Shared filesystem detail | Name `min-width 14rem`, Size `9rem`, Modified `14rem`, Actions `17rem` |

`TableHeaderRow` centralizes the first group of width values by emitting inline `width`, `minWidth`, and `textAlign` styles. Evidence: `control-ui/components/TableHeaderRow/index.tsx:6-24` and `types.ts`. Raw tables still define widths directly in JSX, which creates a second width system.

## 7. Header, table, and width consistency matrix

This matrix is the practical starting point for deciding what to standardize.

| Dimension | Shared baseline | Common variants | Drift / risk |
| --- | --- | --- | --- |
| Header component | `TablePanelHeader` for parents | `CreatePageHeader`, local section headers, legacy GFS header | Some child routes do not use the preferred detail shell |
| Header title element | `.cu-panel-title` span | `<h2>` create/detail; local `h3`/`h2` | Different semantics and title sizes for visually similar surfaces |
| Parent title size | `.9375rem` inherited by panel head | Route-specific title classes or nested panel headers | Usually consistent visually, but not semantically |
| Detail title size | `.9375rem` in detail-flow | `1.125rem` create default, `1.375rem` GFS manage dialog | Resource detail, create, and dialog contexts are distinct but adjacent |
| Subtitle | `.75rem`, soft | Local `.8125rem` or `.875rem` descriptions | Child local headers often choose their own size |
| Parent header background | Edge-to-surface gradient | Transparent detail header; edge `.08` create header; local elevated sections | Same information hierarchy can have different surface contrast |
| Card radius | `12px` | `8px` nested section; no radius at detail seam; dialog radius `12px` | Intentional for seams, but local cards can look unrelated |
| Parent width | Header fills card; normal card in `1120px` app | Full-height registry/cost/LLM/traces/GFS; settings `72rem` | No single parent content-width rule |
| Create/detail width | `74rem` max; detail flow becomes `100%` | Direct header + separate panel outliers | Header/content connection breaks on bypass routes |
| Table header background | Surface or surface-hover band | Plain nested tables use surface; trace/LLM use sticky wrappers | Band is consistent for parents, inconsistent for child tables |
| Table body density | `.7rem .85rem` cells | Inline local padding/widths and specialized rows | Child tables may not match parent density |
| Table column sizing | `TableHeaderRow` width/minWidth | CSS nth-child rules, CSS semantic classes, raw inline JSX | Three concurrent sizing mechanisms |
| Search control | `13rem` default, `9rem` minimum | MCP `11rem/8.5rem`, Registry fixed `13rem`, mobile full width | Header height can change when actions wrap |
| Responsive table behavior | Horizontal overflow | Trace tables convert rows/cells to block/grid below `720px` | Special responsive behavior is not shared by ordinary child tables |

## 8. Observed inconsistencies and consolidation candidates

These are source-backed observations for the next design/implementation pass. They are ordered by likely leverage, not by severity of visual impact.

### 8.1 Standardize parent outer spacing before changing parent headers

The dominant parent header is already `TablePanelHeader`. The outer cards use several spacing approaches:

- Inline `style={{ marginBottom: '1.25rem' }}` in Agents, Contexts, Channels, Users & Teams, Outputs, Usage, Secrets, and Token Budgets.
- `cu-section-card` in connectors, guardrails, plugins, LLM prices, LLM models, and Marketplace catalog.
- Full-height route shells where the card should not have ordinary bottom margin.

This should be resolved as a layout/container rule first. Changing the header itself will not make these routes align if their parent shells still differ.

Evidence: `control-ui/app/globals.css:946-948`, `1880-1886`, `HostTable.tsx:166`, `ContextTable.tsx:84`, `McpServerTable.tsx:407`, `ProfileAdminHome.tsx:434`, `app/outputs/page.tsx:131`.

### 8.2 Make the detail shell the default child classification

The repo already has a coherent C1 composition in `DetailPageShell`. The largest visual outliers are the routes that bypass it:

- Guardrail detail: no detail title shell.
- Recipe secret edit: header and panel are separate.
- Workflow run detail: direct header with local breadcrumb styling.
- Context and shared filesystem detail: correct primitives composed manually, increasing drift risk.

The future choice is likely between one C1 shell and one intentionally simpler C2/utility shell, rather than a new header for every resource type.

### 8.3 Decide whether child tables should be plain or banded

Parent list tables overwhelmingly use `cu-table--header-band`. Nested resource tables frequently use plain `.cu-table`, even when they sit inside a nested card with the same `TablePanelHeader`.

This can be a valid hierarchy signal—parent tables are stronger surfaces, child tables are quieter—but the distinction is currently implicit. It is especially visible in:

- Context detail attached connector/access tables.
- User/team detail tables.
- Recipe Integrations, Secrets, Workloads, and Conditions.
- Marketplace organization images/API keys.
- Plugin SDK tables.

The implementation pass should first make this an explicit child table variant rather than treating each plain table as a one-off.

### 8.4 Collapse width ownership into a deliberate hierarchy

Current width ownership is split between:

1. `TableHeaderRow` inline column styles.
2. CSS selectors such as `.cu-connectors-table th:nth-child(...)`.
3. Semantic CSS classes such as `.cu-table__col-actions`.
4. Raw JSX inline styles on `<th>` and `<td>`.

This is why similar action columns range from `3.5rem` to `17rem`. The difference may be content-driven, but the ownership model is not documented. A standardization pass should decide which columns are semantic primitives and which remain table-specific.

### 8.5 Keep real special cases, but label them as such

The following are not ordinary list tables and should not be flattened into the parent baseline:

- Connector/guardrail/Marketplace expandable rows.
- Wide LLM model and trace tables.
- Trace mobile row-to-grid transformation.
- GFS tree/list explorer and its dialogs.
- Create wizard step rail.
- Marketplace’s two-level organization navigation.

They can still inherit the parent/child header and color language while retaining table behavior needed by their information density.

### 8.6 Remove or classify legacy parallel styles only after runtime confirmation

GFS contains both an older hero/header/explorer style family (`.cu-gfs__header`) and a current card/panel toolbar family (`.cu-gfs-panel__toolbar`). Marketplace also contains current organization components and a `PublisherView` family. This document records both because static source inspection cannot prove reachability.

Before changing either, confirm route usage and whether the old selectors serve a hidden or transitional route.

### 8.7 Normalize semantic heading roles as part of the same pass

The parent component uses a `span` for its title, while detail/create uses `<h2>` and local sections use `<h3>` or arbitrary wrappers. This is not only a visual issue: it affects document outline, accessibility, and automated selectors. Any visual header consolidation should include a deliberate heading-level policy.

## 9. Recommended working groups for implementation planning

These groups are intentionally smaller than the route list. They describe where one future component/variant could plausibly apply.

### Group A — Standard parent collection

**Members:** Agents, Contexts, Shared filesystems, External channels, LLM Prices, Token Budgets, Installed plugins, Settings (with a non-table body option).

**Shared contract already present:** viewport-fill card, H1 header, title/subtitle/actions, standard table or body, common token colors.

**Open decisions:** outer spacing, default card width behavior, whether the header title should become a semantic heading, and whether all parent tables use the band variant.

### Group B — Parent collection with dense/expandable table

**Members:** Installed connectors, Installed Guardrails, Marketplace connectors.

**Shared contract already present:** H1 header plus expandable fixed-layout table and horizontal overflow.

**Keep distinct:** row-detail inset geometry, minimum table widths, and action columns. These are behavior/density differences, not separate page-header families.

### Group C — Parent analytical or multi-body surface

**Members:** Usage, Outputs, Secrets, LLM Models, Traces.

**Shared contract already present:** H1 header and full-height card/route shell.

**Keep distinct:** filters, metrics, multiple table bodies, sticky scroll regions, wide columns, and trace mobile behavior.

### Group D — Parent with nested navigation

**Members:** Marketplace organization, Users & Teams, Outputs, Secrets, LLM Models.

**Shared contract already present:** H1 plus `TabBar` hierarchy.

**Open decisions:** which tab row belongs in the header seam versus the body, and whether nested tabs receive the same flush/compact spacing.

### Group E — Standard child detail

**Members:** Host, user, team, workflow recipe, Marketplace entry, context, shared filesystem.

**Target basis already present:** `DetailPageShell` / detail-flow `CreatePageHeader` / optional compact `TabBar` / connected content card.

**Open decisions:** plain versus card content mode, local toolbar placement, and child table treatment.

### Group F — Child forms and wizards

**Members:** Connector edit, communication channel edit, create flows, cost forms, LLM model forms, secrets, registry flows, team/user creation.

**Target basis already present:** H3 outer panel + `FormSection` nested sections.

**Keep distinct:** multi-step rail and form-specific validation/loading states.

### Group G — Operator/special-purpose surfaces

**Members:** GFS explorer/dialogs, trace detail, guardrail detail, workflow run detail, plugin SDK.

**Action before implementation:** classify each as a valid specialized shell or an outlier that should move into Group E/F. Do not infer this from CSS alone.

## 10. Evidence index

### Shared primitives

- Theme tokens, radii, spacing, shadows: `control-ui/app/globals.css:1-110`
- Normal app width and card primitives: `control-ui/app/globals.css:678-682`, `938-999`
- Sidebar and mobile shell: `control-ui/app/globals.css:9917-10146`, `10514-10644`
- `TablePanelHeader`: `control-ui/components/TablePanelHeader/index.tsx:7-27`
- `CreatePageHeader`: `control-ui/components/CreatePageHeader/index.tsx:6-44`
- `DetailPageShell`: `control-ui/components/DetailPageShell/index.tsx:11-75`
- `FormSection`: `control-ui/components/ui/index.tsx:56-65`
- Tabs and tables: `control-ui/app/globals.css:1569-1755`
- Parent panel header: `control-ui/app/globals.css:2351-2408`
- Detail/create shell: `control-ui/app/globals.css:4895-4982`, `5594-5770`

### Parent route/component evidence

- Sidebar taxonomy and parent/subitem relationships: `control-ui/components/Sidebar/constants.tsx:25-128`
- Route list and hidden utility routes: `control-ui/README.md:21-40`
- Agents: `control-ui/components/HostTable.tsx:16-21`, `166-224`
- Contexts: `control-ui/components/ContextTable.tsx:16-20`, `84-140`
- Connectors: `control-ui/components/McpServerTable.tsx:25-31`, `406-490`
- Guardrails: `control-ui/components/GuardrailHooksTable.tsx:20-28`, `130-186`
- Plugins: `control-ui/components/RecipesTab.tsx:17-25`, `67-132`
- Marketplace catalog: `control-ui/components/RegistryCatalog.tsx:25-35`, `273-338`
- Marketplace organization: `control-ui/components/MarketplaceOrgArea/index.tsx:57-119`
- Users & Teams: `control-ui/components/ProfileAdminHome.tsx:432-584`
- Outputs: `control-ui/app/outputs/page.tsx:116-318`
- GFS: `control-ui/components/GfsBrowser.tsx:749-837`
- Cost: `control-ui/components/UsageDashboard/index.tsx:386-409`, `control-ui/components/LlmPriceTable.tsx:102-160`, `control-ui/components/TokenBudgetTable.tsx:71-127`
- LLM Models: `control-ui/components/LlmModelTable.tsx:218-330`, `control-ui/components/LlmDiscoveryPanel/index.tsx:360-487`
- Traces: `control-ui/components/GovernedTraceSurface/index.tsx:310-450`, `control-ui/components/GovernedTraceSurface/GovernedEventExplorer/index.tsx:126-204`, `control-ui/components/GovernedTraceSurface/SessionReplay/index.tsx:110-172`
- Settings: `control-ui/components/ControlSettingsPanel/index.tsx:244-255`

### Child/detail evidence

- Host detail: `control-ui/app/hosts/[name]/page.tsx:814-845`; Access `control-ui/components/HostAccessTab/index.tsx:269-315`; Identity `control-ui/components/HostIdentityTab/index.tsx:195-215`
- Context detail: `control-ui/app/contexts/[name]/page.tsx:844-877`, plus local tables after the detail shell
- Connector edit: `control-ui/app/mcp-servers/[name]/edit/page.tsx:300-350`
- Shared filesystem detail: `control-ui/app/shared-filesystems/[name]/page.tsx:319-411`
- User detail: `control-ui/app/profile-admin/users/[userId]/page.tsx:553-573`, `896-1274`
- Team detail: `control-ui/app/profile-admin/teams/[teamId]/page.tsx:602-877`
- Recipe detail and nested tables: `control-ui/app/workflow-recipes/[namespace]/[name]/page.tsx:588-1100`
- Recipe integrations/secrets panels: `control-ui/components/RecipeIntegrationsPanel/index.tsx:215-257`, `control-ui/components/RecipeSecretsPanel/index.tsx:160-211`
- Marketplace entry detail: `control-ui/app/registry/entries/[name]/[version]/page.tsx:255-304`
- Guardrail outlier: `control-ui/app/guardrails/[name]/page.tsx:170-287`
- Recipe secret edit outlier: `control-ui/app/secrets/recipe/[name]/edit/page.tsx:176-206`
- Workflow run outlier: `control-ui/app/workflow-recipes/[namespace]/[name]/runs/[runId]/page.tsx:48-75`

## 11. Audit limits and follow-up checks

This inventory is intentionally source-based. Before implementation begins, the following should be confirmed in a browser at desktop and mobile widths:

- Which GFS and Marketplace legacy components are reachable.
- Actual rendered widths when action groups wrap.
- Whether every viewport-fill route has the expected scroll owner.
- Whether plain child tables are intentionally quieter or simply unfinished migrations.
- Whether trace responsive tables and GFS explorers need to remain bespoke.
- Whether the current light theme has the same perceived contrast hierarchy as dark mode.

No application code was changed for this inventory.
