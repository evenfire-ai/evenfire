# AGENTS.md — control-ui

This is one of three frontend projects in the monorepo (Next.js). It follows the **shared frontend UI rules** in [`../docs/agents/control-ui-desktop-app.md`](../docs/agents/control-ui-desktop-app.md).

Read those rules before generating, refactoring, or styling any code in this directory.

## Project-specific notes

- **Token file:** `app/globals.css` — all colors, spacing, radii, shadows, motion, and z-index live here. Consume them as `var(--token-name)`. Never hardcode hex colors or raw px values for these properties.
- **Class prefix:** `cu-` (control-ui) for all shared utility classes.
- **Primitives:** `components/ui/index.tsx` — use the existing primitives (`Button`, `Field`, `TextInput`, `SelectInput`, `TextAreaInput`, `CheckboxField`, `FormSection`) instead of recreating equivalents.
- **Routing:** Sidebar destinations and shareable tab-like sections must use canonical Next App Router paths and child route segments. Do not use `?tab=...`, `profileTab`, `localStorage`, or component-only state as section routing.
- **Control behavior:** Follow the shared control rules from `../docs/agents/control-ui-desktop-app.md`: reuse single-purpose controls before adding native buttons/tabs/menus, and do not add hover `transform`, `translate`, `top`, `margin`, or `filter` effects to interactive controls. Hover states should use background, border, text color, or shadow.
- **Components folder:** `components/` (folder-based, with `index.tsx` + `types.ts`).
- **Project-specific patterns:** Use `TablePanelHeader` + `TableHeaderRow` for every route table/section. The section header must stay visible with icon, title, subtitle, search, refresh, and CTAs while only the content area shows initial loading/empty/error state and scrolls. Disable header CTAs during initial loading. Use `CreatePageHeader` for create/install pages. Wrap auth-gated pages in `<AuthGate>`. Reserve `cu-modal-panel` for overlay/dialog contexts only.

## Outside this directory

These rules are scoped to `control-ui/**`. They do not apply to backend services, deploy manifests, or shared docs.
