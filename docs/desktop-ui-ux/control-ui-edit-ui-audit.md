# Control UI Edit UI Audit and Standardization Proposal

> As-built inventory of edit-oriented UI surfaces in Control UI, followed by a
> proposal for reducing visual and interaction variation. This document is a
> reference for frontend engineering, product, and design work; it does not
> itself implement the redesign.

## Audit metadata

| Field | Value |
| --- | --- |
| Product surface | control-ui authenticated admin experience |
| Project | Edit Modals |
| Repository snapshot | 0c8551cf3 |
| Audit date | 2026-09-02 |
| Primary audience | Frontend engineering, product, and design |
| Intended use | Establish a source of truth before standardizing edit surfaces |
| Audit method | Static inspection of Control UI routes, React components, API mutation handlers, and shared UI/CSS primitives |
| Document status | As-built inventory plus proposed target taxonomy |

## Executive summary

Control UI already has several good shared building blocks, but edit behavior
is distributed across route-level forms, embedded detail editors, modal forms,
inline controls, credential panels, and live access managers. The same visual
concept is often implemented with different markup, CSS classes, controls, and
save semantics.

The recommended end state is:

1. One EditModal shell with three size variants.
2. One full-page EditPage composition for complex forms and wizards.
3. One InlineEdit pattern for single-value changes.
4. One AccessEditor pattern for memberships, grants, and relationships.
5. One dedicated secret/credential behavior layered onto the modal or page
   shell.
6. One ConfirmDialog for destructive confirmation.

This is intentionally a small family, not one universal editor. A recipe
authoring wizard, a write-only credential rotation, and a single-field rename
have different interaction requirements even when their visual language should
be shared.

The highest-value first migration targets are the true record-edit modals:

- LLM secret updates
- Context metadata
- Settings password
- SDK grants
- ChatGPT subscriptions
- Team and user permission edits

## How to read this document

### Terminology

- **Edit surface** means UI that changes an existing persisted resource,
  configuration record, credential, relationship, or grant.
- **Editor** means the form or control that changes data.
- **Shell** means the surrounding placement, panel, header, body, footer,
  overlay, and close behavior.
- **Draft save** means changes remain local until the user explicitly saves.
- **Immediate save** means an individual field or action writes as soon as the
  user commits that field or action.
- **Live relationship mutation** means Add/Revoke/Attach/Detach writes a
  relationship independently of a surrounding form.
- **Adjacent flow** means create, install, upload, reveal, delete, revoke,
  connect, or read-only UI that is relevant to the broader design system but
  is not an edit of an existing record.

### Evidence conventions

The file and line references in this document describe the audited snapshot.
Line numbers will move as implementation changes. The source path is the
durable reference; the line is an orientation aid.

- **Observed** means the component or behavior was found directly in source.
- **Inferred** means the grouping follows composition or route usage.
- **Active** means the component is reachable from the current route tree.
- **Legacy/source-only** means the file exists but no active import was found
  outside tests during this audit.

## 1. Current edit surface taxonomy

The categories below describe interaction families. A surface may appear in
more than one category because placement and data semantics are separate
dimensions. For example, the LLM secret editor is both a modal and a
write-only credential editor.

| Family | What it covers | Typical save behavior | Current examples |
| --- | --- | --- | --- |
| Full-page draft editor | Resource forms that need several sections, tabs, or a wizard | One final Save/Update/Deploy action | Channels, connectors, recipes, model prices, budgets |
| Detail-page embedded editor | A detail page switches one section from read-only to edit mode | Section Save/Cancel or full-resource update | Host configuration, user contact, identity Markdown |
| Modal record editor | A focused edit form over the current page | Draft Save/Cancel | Context metadata, password, permissions, SDK grants |
| Inline micro-editor | One label, row, or value becomes editable in place | Immediate or row-level Save/Cancel | Host name, team name, username, environment variable |
| Access/relationship editor | Memberships, grants, associations, and permissions | Usually immediate Add/Revoke/Attach/Detach | Workflow access, host access, GFS grants |
| Credential/secret editor | Write-only values, credential slots, rotation, and retirement | Transactional, field-level, or merge/delete | LLM secrets, connector credentials, recipe secrets |
| Structured specialist editor | A domain-specific editor embedded in another surface | Usually parent-controlled draft | Egress policy, Markdown, LLM fallback policy |
| Immediate toggle/review editor | Enablement or preference changes without a form | Immediate mutation | LLM discovery review, subscription model availability |

## 2. Full-page draft editors

Full-page editors are appropriate when the operator must understand multiple
sections together, when a form can become tall, or when the operation has a
deployment or validation step. These should converge on the existing
CreatePageHeader/CreateFlowPanel family rather than being converted into
modals solely for visual consistency.

### 2.1 Active route inventory

| Surface | Source evidence | Current interaction | Save and failure behavior |
| --- | --- | --- | --- |
| Communication channel | control-ui/app/communication-channels/[name]/edit/page.tsx:418 | Provider tabs, agent selector, provider settings, credentials, access, and conversations | Main channel values are buffered and saved by one full PUT. Credential fields use a nested field-level editor. Conversation deletion confirms and then persists the updated draft. |
| Connector/MCP server | control-ui/app/mcp-servers/[name]/edit/page.tsx:304 | URL-tabbed editor for egress, credentials, and context summary | Egress is local until Save. Credential updates use a nested rotation/set flow and wait for deployment readiness. The context tab is intentionally read-only. |
| Marketplace entry metadata | control-ui/app/registry/entries/[name]/[version]/edit/page.tsx:127 | Description, tags, and optional local-connector egress | Local draft is diffed on Save. Remote entries show read-only egress information. |
| Recipe secret | control-ui/app/secrets/recipe/[name]/edit/page.tsx:176 | Key rows with write-only values, saved/unset state, add/remove rows | Save sends changed values plus explicit remove keys. Existing stored values are never read back. |
| Allowed LLM model | control-ui/app/llm-models/[id]/edit/page.tsx:126 | Shared LLM model form with model, metadata, and enabled state | Full update. A model-in-use conflict opens an impact confirmation before a forced retry. |
| LLM price | control-ui/app/cost/llm-prices/[id]/edit/page.tsx:85 | Shared price form with model, price fields, and settings | Full update. Dependency information is shown when a price is referenced by budgets. |
| Token budget | control-ui/app/cost/token-budgets/[id]/edit/page.tsx:85 | Budget, period, thresholds, and scope form | Full update with structured validation and unpriced-model handling. |
| Workflow recipe/plugin | control-ui/app/workflow-recipes/[namespace]/[name]/page.tsx:497 and control-ui/components/RecipeEditor.tsx:1565 | Multi-step plugin editor for manifest, approval, egress, defaults, access, credentials, and deployment | Final Update & redeploy action. Workflow access in edit mode is persisted live by the access panel rather than by the final recipe update. |

### 2.2 Shared full-page form center of gravity

The LLM model, LLM price, and token budget editors are the closest current
reference for a consistent full-page form:

- Shared FormSection, Field, TextInput, SelectInput, TextAreaInput,
  CheckboxField, and Button primitives.
- A CreateFlowPanel/CreatePageHeader page shell.
- A consistent bottom cu-create-actions area.
- Inline validation and dependency/error messaging.

Evidence:

- control-ui/components/ui/index.tsx:81
- control-ui/components/LlmModelForm/index.tsx:69
- control-ui/components/LlmPriceForm/index.tsx:97
- control-ui/components/TokenBudgetForm/index.tsx:229

This family should be treated as the baseline for route-sized editors. The
standardization goal is to align the remaining forms to it, not to make every
large editor fit into a modal.

## 3. Modal record editors

These are the primary candidates for the Edit Modals standardization effort.
They should use one shell and differ only by size and content composition.

| Surface | Source evidence | Current shell | Notes |
| --- | --- | --- | --- |
| Context metadata | control-ui/app/contexts/[name]/page.tsx:1271 | cu-modal-backdrop + narrow cu-modal-panel | Uses a real h3, shared modal head/body/footer, and a full-resource update that preserves unknown fields and resource version. |
| Settings password | control-ui/components/ControlSettingsPanel/index.tsx:489 | cu-modal-backdrop + narrow cu-modal-panel | Best current reference for a form modal using shared fields and buttons. |
| LLM secret | control-ui/components/LlmSecretUpdateModal.tsx:126 | Custom overlay behavior around a cu-modal-panel | Uses a styled strong instead of the modal heading convention and contains write-only credential semantics. |
| ChatGPT subscription | control-ui/components/CodexSubscriptionHub/index.tsx:528 | cu-modal-overlay + cu-modal-panel | Combines buffered name/default-model changes with immediate model availability changes and an OAuth/device-code flow. |
| Plugin workload SDK grant | control-ui/app/plugin-workload-sdk/page.tsx:772 | cu-modal-backdrop + cu-modal-panel | Draft form with recipe binding, provider/model targets, callers, users, and quotas. The same modal supports create and edit. |
| Team member permissions | control-ui/app/profile-admin/teams/[teamId]/page.tsx:1132 | Narrow standard panel | Shared role/permission editor with Save/Cancel. |
| User team permissions | control-ui/app/profile-admin/users/[userId]/page.tsx:1322 | Narrow custom panel | Same domain as team member permissions, but duplicated in another detail route. |
| Shared filesystem rename | control-ui/app/shared-filesystems/[name]/page.tsx:695 | Local ModalShell wrapper | Single-field rename with native input and custom shell wrapper. |
| GFS resource rename | control-ui/components/GfsBrowser.tsx:1152 | Inline form inside a larger manage dialog | Not an independent modal; it is a title-row editor nested in the GFS management dialog. |

### 3.1 What should be shared

The shell should own:

- Overlay and panel placement.
- Panel size.
- Header title, optional description, close button, and heading semantics.
- Body scrolling and footer positioning.
- Escape handling and outside-click behavior.
- Focus entry and focus restoration.
- Dirty-close handling.
- Saving and disabled-state behavior.
- Error presentation.

The feature should own:

- Domain fields.
- Domain validation.
- API mutation and concurrency handling.
- Domain-specific confirmation, when required.
- Whether the operation is draft, immediate, or transactional.

## 4. Detail-page embedded editors

These editors keep the surrounding detail page mounted. They are visually
different from modals but should still use the same form primitives, field
spacing, button variants, error treatment, and save-state language.

| Detail surface | Editor | Source evidence | Current behavior |
| --- | --- | --- | --- |
| Host overview | Display name | control-ui/components/HostOverviewTab/index.tsx:121 | Pencil replaces the value with an input; Enter saves and Escape cancels. The parent writes the full Host resource. |
| Host model tab | Provider/model/fallback configuration | control-ui/app/hosts/[name]/page.tsx:1102 and control-ui/components/LlmProviderConfig/index.tsx:88 | Local model draft is saved through a full Host update. LLM secret editing opens a separate modal. |
| Host advanced tab | Per-tool approvals | control-ui/components/HostApprovalSection/index.tsx:186 | Native select/input controls compose a local draft and save through the parent Host update. |
| Host advanced tab | Environment variables | control-ui/components/HostEnvTable.tsx:320 | Add/edit uses an always-visible form card beneath the table; key identity is locked during edit. |
| Host identity tab | Identity, soul, agents, and user Markdown | control-ui/components/HostIdentityTab/index.tsx:151 | Dirty state is tracked across the active document; Save updates the identity payload and Discard restores the server state. |
| User contact tab | Email and contact channels | control-ui/app/profile-admin/users/[userId]/page.tsx:601 | One embedded draft editor manages email, Slack handles, Telegram IDs, and contact-email chips, with a bottom Save/Cancel bar. |
| Team detail header | Team name | control-ui/app/profile-admin/teams/[teamId]/page.tsx:602 | Header label becomes an input with check/cancel actions. |
| Settings | Username and email | control-ui/components/ControlSettingsPanel/index.tsx:270 | Each field has its own inline edit state and saves independently. |

## 5. Inline and micro-editors

Inline editing is appropriate for a single value or a row whose context is
important. It should not be used as a substitute for a multi-section form.

### Current inline patterns

1. **Header label replacement**
   - Host display name.
   - Team name.
   - Pencil/check/X affordances.

2. **Settings row replacement**
   - Username and email.
   - Shared TextInput and Button primitives.
   - Immediate field-level request on Save.

3. **Token/chip collection editing**
   - User contact email, Slack, and Telegram values.
   - Enter-to-add, removable chips, and one enclosing Save/Cancel action.

4. **Table row or card editor**
   - Host environment variables.
   - Add and edit use the same embedded form area.

5. **Credential field replacement**
   - Communication channel credentials.
   - Stored values display as masked placeholders; an Edit action reveals a
     write-only input and a field-level Save/Delete action.

6. **Nested title editing**
   - GFS resource rename inside the manage dialog.

### Recommended inline contract

- Use the same shared TextInput and button variants everywhere.
- Use a consistent pencil action label and focus behavior.
- Support Enter to save and Escape to cancel.
- Preserve the original display value until the save succeeds.
- Show field-level errors next to the editor, not only in a transient toast.
- Prevent multiple unrelated inline editors from being active in the same
  small surface unless the parent explicitly supports a multi-field draft.
- Use the page or modal form pattern once the edit has more than one logically
  related field.

## 6. Relationship and access editors

Relationship editors are not ordinary record forms. They manage membership,
grants, or associations. They need a consistent visual language, but their
live mutation semantics should remain explicit.

### 6.1 Active relationship surfaces

| Domain | Relationships edited | Source evidence | Current save behavior |
| --- | --- | --- | --- |
| Contexts | Connectors, shared filesystems, agents, teams, and members | control-ui/app/contexts/[name]/page.tsx:473, :505, :882 | Add/remove operations issue immediate full-spec or association updates. Some adds use selection overlays. |
| Hosts | Connectors, members, teams, and hooks | control-ui/components/HostAccessTab/index.tsx:406 and host detail tabs | Selection and revoke operations are immediate, with confirmation for destructive actions. |
| Workflow recipes | Trigger users, trigger teams, and approval-target teams | control-ui/components/WorkflowAccessPanel/index.tsx:482 | Add/revoke operations persist immediately in edit mode. The create mode keeps selections local until deployment. |
| Communication channels | Members and teams allowed to access the channel | control-ui/components/CommunicationChannelAccessSelector/index.tsx:104 and control-ui/app/communication-channels/[name]/edit/page.tsx:877 | Selections are local to the channel draft and persist with the channel Save action. |
| Connector/context membership | Contexts assigned to a connector | control-ui/components/McpServerTable.tsx:668 | Selection modal confirms the batch and immediately updates context membership. |
| Profile users | Contexts, teams, and agents | control-ui/app/profile-admin/users/[userId]/page.tsx:1385 | Custom selection overlays add associations immediately; removals use confirmation. |
| Profile teams | Members, contexts, and agents | control-ui/app/profile-admin/teams/[teamId]/page.tsx:1213 | Add/remove membership and associations are immediate; member roles use a separate draft modal. |
| GFS | Direct grants and URI shares | control-ui/components/GfsGrantPanel.tsx:347 | Grant/share actions confirm and write immediately; existing access can be revoked immediately after confirmation. |

### 6.2 Shared picker infrastructure

The current reusable picker foundation is:

- control-ui/components/SelectionDropdown/index.tsx
- control-ui/components/SelectionModal/index.tsx:32
- control-ui/components/GfsSubjectPicker/index.tsx
- control-ui/components/GfsPermissionDropdown/index.tsx

The application also contains several hand-built selection overlays in context,
profile user, and profile team pages. They repeat the same structure:

1. Backdrop.
2. Selection panel.
3. Title and close action.
4. Searchable selection control.
5. Cancel and Add/Attach action.

These should share the same shell as edit modals while keeping a distinct
picker/relationship footer and live-mutation explanation.

### 6.3 Recommended access-editor rules

- Use Add or Grant for creation of a relationship.
- Use Remove, Revoke, or Detach for the inverse action; choose one
  domain-appropriate term and keep it stable.
- Make immediate persistence explicit in helper text or status feedback.
- Confirm destructive removal with ConfirmDialog.
- Do not show a Save button for actions that have already persisted.
- If a relationship is part of a larger draft, keep it local and show it in
  the parent form’s Save contract.
- After a mutation, refresh or reconcile the displayed list rather than
  assuming the optimistic state is authoritative.

## 7. Credential and secret editors

Credential editing is a special domain because the UI must never display
stored secret values. It needs consistent visual treatment plus domain-specific
copy and state.

| Component/surface | Source evidence | Behavior |
| --- | --- | --- |
| LLM secret modal | control-ui/components/LlmSecretUpdateModal.tsx:46 | Adds/replaces credential slots, supports key retirement, and uses a confirmation for removal. |
| Channel credentials panel | control-ui/components/ChannelCredentialsPanel/index.tsx:277 | Existing fields are masked; each field has its own Edit, Save, and Delete state. Mutations are immediate. |
| Connector credential updater | control-ui/components/UpdateConnectorCredentials/index.tsx:615 | Supports set/rotate modes, pre-save confirmation, API mutation, and deployment readiness polling. |
| Shared LLM credential fields | control-ui/components/LlmCredentialFields/index.tsx:91 | Progressive provider sections, canonical slots, extra slots, and per-key retirement. |
| Host provider credentials | control-ui/components/LlmProviderConfig/index.tsx:629 | Nested credential fields are controlled by the host model draft and saved with the Host resource. |
| Recipe secret page | control-ui/app/secrets/recipe/[name]/edit/page.tsx:250 | Write-only key/value rows with saved/unset state and explicit remove-key semantics. |

### Credential standard

All credential editors should:

- State clearly that values are write-only.
- Show stored key names or presence chips, never plaintext values.
- Use password-type inputs for secret values.
- Distinguish unset, stored, replacing, rotating, and retiring states.
- Make destructive key removal explicit and confirm it when appropriate.
- Prevent accidental clearing when a blank value means “keep existing”.
- Preserve provider-specific validation.
- Show transaction/rollout progress for credential rotation.
- Never log or surface secret values in errors, toasts, or diagnostics.

## 8. Structured and specialist editors

Specialist editors should be reusable content controls inside the standard page
or modal shells. They should not introduce their own outer dialog style.

| Specialist editor | Used by | Source evidence | Local state |
| --- | --- | --- | --- |
| Egress policy | Connector edit, Marketplace metadata edit, RecipeEditor, registry install | control-ui/components/EgressEditor.tsx:21 | Controlled by the parent; changes remain local until the parent commits, except install/update flows with their own mutation contract. |
| LLM provider configuration | Host model tab and related credential paths | control-ui/components/LlmProviderConfig/index.tsx:88 | Controlled draft containing primary provider/model, credentials, allowed models, and fallback policy. |
| LLM fallback policy | LLM provider configuration | control-ui/components/LlmPolicyEditor/index.tsx:49 | Controlled ordered rows with model/provider selection, cooldown, triggers, reorder, and remove behavior. |
| Markdown editor | Host identity tab | control-ui/components/MarkdownEditor/index.tsx:14 | Dirty content is owned by the identity tab until Save or Discard. |
| Recipe manifest/approval editor | Workflow recipe edit | control-ui/components/RecipeEditor.tsx:2129 | Multi-step draft with JSON/manifest validation, approval, egress, defaults, access, and deployment. |
| Recipe defaults | Workflow recipe edit | control-ui/components/RecipeDefaultsPanel/index.tsx:8 | Controlled subform with local changes passed to the parent editor. |
| Token budget scope selector | Token budget edit | control-ui/components/TokenBudgetForm/ScopeSelector.tsx | Multi-value picker with add/remove chips, owned by the budget draft. |
| Environment variable editor | Host advanced tab | control-ui/components/HostEnvTable.tsx:320 | Row-level draft; secret kind and key identity are protected during edit. |

## 9. Immediate toggle and review editors

Not every persisted edit has a text field or modal. These controls should use
the same status, disabled, error, and toast conventions as forms.

### Current examples

- **LLM discovery review:** control-ui/components/LlmDiscoveryPanel/index.tsx:161
  selects one or many discovered models, then immediately calls
  updateLlmModel to enable them.
- **ChatGPT subscription model availability:**
  control-ui/components/CodexSubscriptionHub/index.tsx:711 toggles models
  immediately while name and default-model changes use the modal footer.
- **Settings appearance:** control-ui/components/ControlSettingsPanel/index.tsx:403
  applies preference changes immediately.
- **Verified approval-DM preference:**
  control-ui/components/UserApprovalMediumsPanel.tsx:38 changes the preferred
  account immediately; revoke is confirmed and immediate.

These controls should not be wrapped in a fake draft modal. Their standard
should be an explicit immediate-action pattern with a visible pending state and
reliable refresh/reconciliation.

## 10. Shared primitives already available

| Primitive | Source | Current role | Standardization opportunity |
| --- | --- | --- | --- |
| Form controls | control-ui/components/ui/index.tsx | Button, Field, TextInput, SelectInput, TextAreaInput, CheckboxField, and FormSection | Make them the default inside every new editor and migrate native controls where behavior is equivalent. |
| Full-page flow shell | control-ui/components/CreateFlowPanel/index.tsx, CreatePageHeader, CreateStepFlow | Create, edit, install, and wizard layouts | Formalize the edit-page composition without changing existing create flows. |
| Detail shell | control-ui/components/DetailPageShell/index.tsx | Resource detail pages with tabs and actions | Use for detail pages and keep embedded editors visually consistent. |
| Confirmation | control-ui/components/ConfirmDialog/index.tsx | Destructive and impact confirmations | Make it the only destructive confirmation shell. |
| Selection | control-ui/components/SelectionModal/index.tsx, SelectionDropdown | Multi-select and picker overlays | Consolidate repeated add/attach/grant overlays. |
| Table actions | control-ui/components/RowActionsMenu/index.tsx, RowActions | Edit/delete/inspect entry points | Keep row action behavior separate from the editor shell. |
| Credential controls | LlmCredentialFields, LlmSecretSelect, UpdateConnectorCredentials | Secret selection, replacement, and rotation | Layer write-only semantics onto the shared modal/page form contract. |

## 11. Proposed target component system

### 11.1 EditModal: one shell, three sizes

Create a reusable control-ui/components/EditModal/ component with a narrow
behavioral API and CSS owned by control-ui/app/globals.css.

Recommended size variants:

| Size | Use for | Examples |
| --- | --- | --- |
| compact | One to four fields or one focused action | Rename, password, context metadata |
| standard | A normal multi-field record form | Team permissions, SDK grant |
| wide | Multiple sections, credential groups, or complex configuration | LLM secrets, ChatGPT subscriptions, advanced grant/configuration flows |

The size should be a visual width/layout variant, not a separate implementation.
Avoid feature-specific outer classes such as --shared-files, --selection,
or one-off inline widths unless an exception is documented.

Recommended conceptual API:

~~~tsx
<EditModal
  open={open}
  title="Edit context"
  description="Update the context metadata."
  size="compact"
  dirty={isDirty}
  saving={saving}
  error={error}
  onClose={handleClose}
  onSubmit={handleSave}
>
  ...
</EditModal>
~~~

The exact TypeScript API can be decided during implementation. The important
contract is that the shell owns behavior and the feature owns domain state.

### 11.2 Modal anatomy

Every edit modal should render the same conceptual structure:

~~~text
cu-modal-backdrop
└── cu-edit-modal.cu-edit-modal--compact|standard|wide
    ├── cu-edit-modal__head
    │   ├── h3 title
    │   └── close button
    ├── cu-edit-modal__body
    │   ├── persistent error/warning region
    │   └── form sections and fields
    └── cu-edit-modal__foot
        ├── Cancel
        └── Save/Update
~~~

The existing cu-modal-panel classes can be retained as the initial CSS
foundation, but the new component should provide one stable API and prevent
each feature from reimplementing the outer structure.

### 11.3 Modal behavior contract

The shared shell should provide:

- role=dialog and aria-modal=true.
- A stable aria-labelledby connected to the h3.
- Optional aria-describedby for modal descriptions.
- Escape-to-close when not saving.
- Outside-click close when the modal is clean; a dirty-close confirmation or
  explicit dirty-state decision when it is not.
- Focus entry on the first meaningful control or close action.
- Focus restoration to the triggering element.
- Body scrolling when content exceeds the viewport.
- A stable footer that remains visible while the body scrolls.
- Disabled close and submit actions while a mutation is in progress.
- Inline persistent error presentation.
- A single primary submit action.
- No hardcoded inline typography or overlay colors.

### 11.4 Form behavior contract

All draft edit forms should:

- Use a real form and onSubmit.
- Use type=submit for the primary action.
- Support Enter submission where it is safe.
- Use shared Field and input primitives.
- Keep a local draft until the mutation is accepted.
- Disable inputs consistently while saving.
- Preserve the original value if a save fails.
- Show validation before the request where possible.
- Show server errors in a persistent, readable location.
- Use a success toast only after the mutation completes.
- Reconcile the page with the server response after success.

### 11.5 EditPage: full-page form contract

Keep full-page editing for:

- Tall forms.
- Multi-step workflows.
- Editors requiring broad context.
- Forms with deployment/reconciliation states.
- Editors that contain several specialist panels.

All such pages should use:

- CreatePageHeader for title, subtitle, and navigation.
- CreateFlowPanel or its detail equivalent.
- FormSection for grouping.
- cu-create-content and cu-form-grid for layout.
- cu-create-actions for Cancel and Save/Update.
- Shared UI primitives for controls.

### 11.6 InlineEdit: micro-edit contract

Create a small reusable inline pattern for single-value edits. It should
standardize:

- Display-to-edit transition.
- Pencil/check/cancel icons.
- Keyboard behavior.
- Pending state.
- Error placement.
- Original-value restoration after failure.

It should not attempt to support multi-section drafts or complex access
selection.

### 11.7 AccessEditor: relationship contract

Use one visual pattern for live relationship management:

- Section title and count.
- Current relationship rows.
- Searchable selection control.
- Explicit Add/Grant/Attach action.
- Pending state while a mutation is in flight.
- Confirmed Remove/Revoke/Detach action.
- Empty, loading, and error states.
- Refresh/reconciliation after mutation.

Create mode may use the same content component with local selections, but the
mode must be explicit so the UI does not imply that changes were already
persisted.

### 11.8 SecretEditor: credential contract

Credential editors should compose the shared modal or page shell and add:

- Write-only copy.
- Stored-key presence indicators.
- Set versus rotate mode.
- Key-level removal/retirement.
- Confirmation for destructive changes.
- Polling/progress when a rotation affects deployment readiness.

## 12. Current inconsistencies to remove

### 12.1 Modal shell variation

The code currently uses multiple outer patterns:

- cu-modal-backdrop + cu-modal-panel
- cu-modal-overlay + cu-modal-panel
- cu-modal for one-time disclosure UI
- Custom fixed overlays with inline styles
- Local ModalShell wrappers

Evidence includes:

- Standard shell: ControlSettingsPanel, Context edit, team role edit,
  SDK grant edit.
- Styled custom heading/overlay: LlmSecretUpdateModal,
  CodexSubscriptionHub, and SelectionModal.
- Repeated custom overlays: context, profile user, and profile team
  selection flows.

Recommendation: use cu-modal-backdrop and one shared EditModal/picker shell.
Keep cu-modal only when the surface is intentionally a non-edit disclosure
or migrate it if it is visually equivalent.

### 12.2 Heading inconsistency

Some modal headers use the canonical h3.cu-modal-panel__title. Others use a
styled strong with inline font size and line height. Modal headings should
always use the canonical heading level and CSS class.

### 12.3 Native controls versus shared primitives

The following edit surfaces still contain native inputs/selects or inline
styles where shared primitives exist:

- Recipe secret editor.
- Communication channel editor.
- Context attach/add flows.
- Profile user and team editors.
- Shared filesystem and GFS file management.
- Some credential and access panels.

Recommendation: migrate when behavior is equivalent. Preserve native controls
only when a domain-specific interaction genuinely requires them, and document
the exception.

### 12.4 Bespoke width and style variants

Current class variants such as --narrow, --selection, and --shared-files,
along with inline overlay colors and inline typography, create visual drift.

Recommendation: define a small size/intent vocabulary in shared CSS:

- compact
- standard
- wide
- optional picker behavior using the same shell

The CSS should consume existing --cu-* tokens from
control-ui/app/globals.css.

### 12.5 Save semantics are not visually obvious

The same-looking Save button can mean different things:

- Full object replacement.
- Field-level immediate update.
- Credential rotation.
- Relationship mutation.
- Deployment/redeploy.

Recommendation:

- Keep Save for buffered draft forms.
- Use Add/Grant/Attach for immediate relationship creation.
- Use Revoke/Remove/Detach for immediate relationship removal.
- Use Rotate/Replace for credential operations.
- Use Update & redeploy for recipe deployment.
- Show persistent helper copy when a field is write-only or a mutation is
  immediate.

### 12.6 Confirmation and conflict handling

Most surfaces use ConfirmDialog, but some pages build custom delete or
selection confirmations. Conflict handling also varies:

- LLM model uses a model-impact confirmation on 409.
- Host/context/identity flows preserve resource-version/concurrency behavior.
- Credential rotation waits for readiness.
- Some immediate relationship flows use only a toast.

Recommendation: standardize the shell and state presentation without hiding
domain-specific safety gates. A model-impact confirmation and a credential
rotation confirmation are different messages, but should use the same dialog
component.

### 12.7 Duplicate selection overlays

Context, profile user, profile team, and connector/context flows repeat picker
markup. These should be migrated to a shared picker shell that uses the
existing SelectionDropdown.

## 13. Recommended migration plan

### Phase 0 — Establish the contract

Before changing feature behavior:

1. Agree on the target families in this document.
2. Decide whether EditModal lives under control-ui/components/EditModal/.
3. Decide whether existing cu-modal-panel classes are renamed or wrapped.
4. Define compact, standard, and wide layout tokens in
   control-ui/app/globals.css.
5. Document dirty-close, Escape, focus, loading, and error behavior.

### Phase 1 — Build the shared shell

Implement and test:

- EditModal.
- Modal header/body/footer.
- Size variants.
- Focus and close behavior.
- Dirty-close behavior.
- Form submission/loading/error states.

Use the Settings password modal as the behavioral baseline:
control-ui/components/ControlSettingsPanel/index.tsx:489.

### Phase 2 — Migrate low-risk record modals

Migrate without changing API behavior:

1. Settings password.
2. Context metadata.
3. Team member permissions.
4. User team permissions.
5. Shared filesystem rename.
6. SDK grant edit.

These surfaces make the shell easy to validate across small and medium forms.

### Phase 3 — Migrate complex modal domains

1. LLM secret update.
2. ChatGPT subscription configuration.
3. GFS management/rename behavior where the shell is visually equivalent.

Preserve specialized logic:

- Write-only credential behavior.
- Set/rotate semantics.
- OAuth/device-code progress.
- Immediate model availability mutations.
- GFS grant/share behavior.

### Phase 4 — Consolidate pickers and access surfaces

1. Reuse the shared picker shell for context add flows.
2. Reuse it for profile user/team association flows.
3. Reuse it for connector-to-context membership.
4. Align HostAccessTab and WorkflowAccessPanel spacing and status treatment.
5. Keep live relationship semantics explicit.

### Phase 5 — Normalize inline and full-page editors

1. Introduce InlineEdit.
2. Migrate host/team/settings single-field editors.
3. Align contact chips and environment-variable editors.
4. Normalize full-page action bars and error placement.
5. Replace equivalent native controls with shared primitives.

### Phase 6 — Remove drift and legacy

1. Search for custom modal backdrops and one-off overlay styles.
2. Search for styled modal strong headings.
3. Search for native inputs in edit surfaces.
4. Verify ProfileAdminPanel and GrantsPanel remain unused before removal
   or archival.
5. Update component tests and route-level tests for the new contracts.

## 14. Suggested first implementation batch

The first batch should establish the modal system with minimal domain risk:

| Order | Surface | Why |
| --- | --- | --- |
| 1 | Settings password | Cleanest existing modal and shared primitive usage |
| 2 | Context metadata | Same narrow form shape, with concurrency preservation |
| 3 | Team/member permissions | Repeated domain that benefits from removing duplication |
| 4 | SDK grant | Medium-sized form with shared sections and a real Save lifecycle |
| 5 | Shared filesystem rename | Simple single-field modal and local ModalShell |
| 6 | LLM secret | High-value domain, but requires write-only behavior and removal safety |
| 7 | ChatGPT subscription | Wide modal with mixed save semantics and asynchronous sign-in |

The first five can validate the shell. The final two validate whether the
standard can handle specialized asynchronous and secret-sensitive behavior.

## 15. Acceptance criteria

### Visual consistency

- All edit modals use the shared shell.
- The only modal size differences are documented compact, standard, and wide
  variants.
- Header typography, close affordance, body spacing, and footer actions are
  consistent.
- Overlay, border, radius, shadow, and spacing values come from Control UI
  tokens.
- No feature-specific inline modal typography or overlay colors remain without
  an explicit exception.

### Interaction consistency

- Every draft form supports Save/Cancel and disabled saving states.
- Every immediate mutation labels itself as Add/Grant/Remove/Revoke/Rotate as
  appropriate.
- Dirty forms do not lose changes silently.
- Escape, outside click, focus entry, and focus restoration behave consistently.
- All destructive confirmations use ConfirmDialog.

### Accessibility

- Every modal has role=dialog and aria-modal=true.
- Every modal has an h3 connected through aria-labelledby.
- Inputs have stable labels.
- Errors are exposed through a persistent alert region when necessary.
- Keyboard users can complete and cancel every edit.
- Focus does not escape an active modal.

### Data safety

- Secret values never render from server responses.
- Credential rotation and key retirement remain explicit.
- Optimistic concurrency/resource-version handling is preserved.
- Impact-gated destructive model operations remain gated.
- Successful mutations reconcile visible state with the server.

### Testing

- Shared shell behavior has component tests.
- Each migrated modal retains domain-specific tests.
- Tests cover loading, validation, server error, cancel, dirty close, and
  successful save.
- Access editors cover immediate Add/Revoke behavior separately from draft
  forms.

## 16. Adjacent flows excluded from the core edit inventory

These flows should use the same visual primitives where appropriate, but they
are not part of the first edit-modal migration:

### Create/install flows

- All /new pages.
- Registry install and publish flows.
- HookInstallForm.
- RegistryInstallForm and RegistryInstallModal.
- NewFolderModal.
- FileUploadModal.
- Credential generation and registry connection flows.

The registry install flow contains an EgressEditor, but it edits an
installation draft before a resource is created. It belongs to the specialist
editor inventory, not the existing-record edit inventory.

### Selection/add/invite flows

- Context Add agent/team/member/connector overlays.
- Host access selection modals.
- Profile user/team Add and Invite flows.
- Publisher GrantAccessModal.
- Connector-to-context Add flow.

These should converge on the picker/access shell, not necessarily the draft
record-edit footer.

### Action, status, and disclosure flows

- Delete, revoke, uninstall, and remove confirmations.
- Workflow run status modal.
- Docker one-time credential disclosure modal.
- Recipe integration connect/disconnect/revoke.
- Verified approval-DM prefer/revoke.

### Read-only flows

- Guardrail detail.
- Connector context summary.
- Read-only workflow access summaries.
- Registry entry detail before entering edit.

### Legacy/source-only candidates

During this snapshot, the following components appeared to have no active
imports outside tests:

- control-ui/components/ProfileAdminPanel.tsx
- control-ui/components/GrantsPanel/index.tsx

They should not be migrated until route reachability is confirmed. The safer
sequence is to verify usage, then archive/remove them separately from the
visual standardization work.

## 17. Source inventory quick reference

### Entry points

- control-ui/components/CommunicationChannelsTable.tsx
- control-ui/components/McpServerTable.tsx
- control-ui/components/ContextTable.tsx
- control-ui/components/LlmModelTable.tsx
- control-ui/components/LlmPriceTable.tsx
- control-ui/components/TokenBudgetTable.tsx
- control-ui/components/RegistryCatalog.tsx
- control-ui/components/PublisherView/OwnedEntries.tsx
- control-ui/app/plugin-workload-sdk/Views.tsx

These components expose Edit actions, but the row action is an entry point,
not itself a distinct editor. The same target editor may be reached through
different labels; for example, the LLM model table can expose “Edit”, “Edit API
key”, or “Edit subscription” while routing into the allowed-model edit path.

### Core editor routes

- control-ui/app/communication-channels/[name]/edit/page.tsx
- control-ui/app/mcp-servers/[name]/edit/page.tsx
- control-ui/app/registry/entries/[name]/[version]/edit/page.tsx
- control-ui/app/secrets/recipe/[name]/edit/page.tsx
- control-ui/app/llm-models/[id]/edit/page.tsx
- control-ui/app/cost/llm-prices/[id]/edit/page.tsx
- control-ui/app/cost/token-budgets/[id]/edit/page.tsx
- control-ui/app/workflow-recipes/[namespace]/[name]/page.tsx with ?edit=1

### Core modal and inline components

- control-ui/components/ControlSettingsPanel/index.tsx
- control-ui/components/LlmSecretUpdateModal.tsx
- control-ui/components/CodexSubscriptionHub/index.tsx
- control-ui/components/SelectionModal/index.tsx
- control-ui/components/HostOverviewTab/index.tsx
- control-ui/components/HostEnvTable.tsx
- control-ui/components/HostApprovalSection/index.tsx
- control-ui/components/HostIdentityTab/index.tsx
- control-ui/components/TeamRolePermissionEditor/index.tsx
- control-ui/components/ChannelCredentialsPanel/index.tsx
- control-ui/components/UpdateConnectorCredentials/index.tsx

### Access and relationship components

- control-ui/components/WorkflowAccessPanel/index.tsx
- control-ui/components/CommunicationChannelAccessSelector/index.tsx
- control-ui/components/HostAccessTab/index.tsx
- control-ui/components/GfsGrantPanel.tsx
- control-ui/components/GfsBrowser.tsx
- control-ui/components/SelectionDropdown/index.tsx
- control-ui/app/contexts/[name]/page.tsx
- control-ui/app/profile-admin/users/[userId]/page.tsx
- control-ui/app/profile-admin/teams/[teamId]/page.tsx

## Conclusion

The Control UI does not need one universal “edit modal.” It needs a small
system with consistent outer behavior and intentionally distinct inner
contracts:

- Use EditModal for focused record edits.
- Use EditPage for complex, tall, or deploy-oriented forms.
- Use InlineEdit for one-value changes.
- Use AccessEditor for live relationships.
- Use SecretEditor behavior for write-only credentials.
- Use ConfirmDialog for destructive confirmation.

The most important implementation principle is to standardize the shell,
spacing, headings, controls, and state feedback without flattening important
differences in persistence, concurrency, credential safety, or deployment
behavior.
