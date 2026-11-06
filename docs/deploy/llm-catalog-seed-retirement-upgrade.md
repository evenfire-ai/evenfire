# LLM Catalog Seed Retirement Upgrade Note

Control API no longer seeds a default LLM model catalog. Earlier releases
inserted 44 allowlist pairs (`llm_allowed_models`, `source='manual'`, enabled)
and 8 placeholder prices (`llm_model_prices`) in their migrations. The model
catalog now comes from the catalog sync against models.dev, which runs at boot
and enables new models according to each provider's auto-enable policy (see
[LLM providers](llm-providers.md)). Migration
`0135_llm_retire_seeded_catalog` hands the old seed over to that sync on
installations that applied it.

## Upgrading an existing installation

### Placeholder prices are removed

A placeholder price is deleted only if nobody touched it since the seed wrote
it: it still has the four values and the `USD` currency the seed wrote, it is
still enabled, and it was never saved again. A price an admin edited, re-saved
(even with the same values) or disabled is kept. A kept disabled price also
stops the catalog sync from pricing that pair. The pairs concerned are:

| Provider  | Model               |
| --------- | ------------------- |
| `openai`  | `gpt-5.4-mini`      |
| `openai`  | `gpt-4o`            |
| `openai`  | `gpt-4o-mini`       |
| `claude`  | `claude-sonnet-4-6` |
| `claude`  | `claude-3-5-sonnet` |
| `claude`  | `claude-3-5-haiku`  |
| `zai`     | `glm-5.1`           |
| `bailian` | `qwen3-coder-plus`  |

The catalog sync does not price them again: it loads a price only when it
inserts a model, and these rows already exist. Until an admin prices them
under **Cost → LLM prices**:

- `cost` budgets count their usage as $0, **retroactively for the current
  period**. Spend is recomputed with the current price on every read, so a
  budget that was blocked by usage of these pairs is released.
- The per-task cost brake is inactive for them.
- A new `cost` budget that pins one of these models is refused.

Those with recorded usage are listed as unpriced in the Control UI. If you use
`cost` budgets, re-price every pair in the table that you serve, before the
upgrade or right after it. Pay attention to the ones the seed enabled
(`claude/claude-sonnet-4-6`, `openai/gpt-5.4-mini`, `zai/glm-5.1`,
`bailian/qwen3-coder-plus`), and to `openai/gpt-4o` and `openai/gpt-4o-mini`
if a catalog sync already added them: their placeholder may match the real
price, but it is still removed unless someone saved it. Saving a price under
**Cost → LLM prices** before the upgrade, even unchanged, is enough for the
migration to keep it.

### 28 seeded pairs become catalog-managed

The seeded pairs that models.dev lists change from `source='manual'` to
`source='discovery'`. Nothing is deleted or disabled, and the enabled state is
never changed. On an enabled pair the display name and context window are left
as they are; on a disabled one the sync fills them from the catalog if they are
empty. From the first live sync on,
the sync records when it last saw them, marks them stale if they leave the
catalog, and records the catalog's lifecycle status. Expect new
`/admin/attention` items after that first run: enabled models the catalog
calls deprecated, and enabled catalog models that went stale. They are
warnings. Nothing is disabled automatically.

The seeded pairs models.dev does not list (for example `zai/glm-5.1` or the
Bedrock Claude ids) stay `manual`, and the sync leaves them alone.

## New installations

A new installation starts with an empty allowlist and no prices.

- The allowlist comes only from the boot catalog sync. It needs egress to
  models.dev. Without it, the sync falls back to the vendored snapshot, which
  enables nothing on policy-ON providers (they get no rows until a live run
  succeeds). Policy-OFF providers get disabled rows.
- Providers whose auto-enable policy is off start with nothing enabled, even
  after a live run. An operator enables their models, or creates them, under
  `/llm-models`.
- Models are priced from the catalog's `cost` when the sync inserts them.
  Models without a catalog cost, and models an operator adds by hand, have no
  price until an admin adds one.
