# Design records

Point-in-time design notes, mini-specs, and inventories written while a feature
was being built. They explain _why_ something is shaped the way it is, but they
are **not user documentation** and are not kept up to date: the code is the
source of truth. For how to use or operate evenfire, start at the
[docs index](../README.md).

| Record                                                                                      | What it is                                                                               | Status note                                                                                     |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [AI Recipe Builder app architecture](ai-recipe-builder-app-architecture.md)                 | Architecture of the sandbox app that drafts WorkflowRecipes through an LLM conversation  | —                                                                                               |
| [Agent models and LLM Secrets UX](agent-models-credentials-ux.md)                           | UX decision record for agent creation and the agent **Models & creds** tab               | Marked "Proposed" in the record                                                                 |
| [Control UI contract test hardening](control-ui-contract-test-hardening.md)                 | Test-methodology mini-spec for Control UI fixtures (PR #298)                             | Pre-implementation record                                                                       |
| [Control UI header and table layout inventory](control-ui-header-table-layout-inventory.md) | As-built inventory of Control UI headers, tabs, and tables used for standardization work | Snapshot dated in the record (2026-08-19)                                                       |
| [Desktop embedded notification rail](desktop-embedded-notification-rail.md)                 | Layout decision for the notification drawer next to an embedded app                      | —                                                                                               |
| [Self-hosted registry UX redesign](self-hosted-registry-ux-redesign.md)                     | Implementation map for the Marketplace / Publisher redesign                              | The Publisher fold into **Marketplace › your org** has shipped; the record still says "planned" |
