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

### Placeholder prices are kept

The 8 placeholder prices stay as they are: the migration does not change,
disable or delete them, whether or not an admin edited them. The pairs
concerned are:

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

They are approximations, not reviewed prices, and some are below the vendor's
list price (for example `openai/gpt-5.4-mini` is seeded at 0.15/0.60 USD per
1M input/output tokens, while models.dev lists it at 0.75/4.50). The catalog
sync does not replace them: it never writes a price for a pair that already
has a price row, enabled or disabled. If you use `cost` budgets or the per-task cost brake, review
them under **Cost → LLM prices** after the upgrade and correct the ones you
serve. Until then, `cost` budgets keep counting their usage at the placeholder
rate.

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

### Models discovered before the upgrade stay as they are

Earlier catalog syncs inserted every discovered model disabled. Those rows
already exist, and auto-enable only decides when a row is inserted, so they
stay disabled after the upgrade even when their provider's policy is ON and
the model is eligible. Only models the catalog lists for the first time after
the upgrade can start enabled. Review the disabled discovered models under
`/llm-models` and enable the ones you want to serve.

### Models removed before the upgrade

Migration `0136_llm_catalog_dismissed_backfill` marks every model deleted
through `/llm-models` before the upgrade as removed, from the allowlist audit,
so the sync re-adds it disabled rather than enabled. A model renamed before the
upgrade is different: the audit records only its new name, so the old name is
not marked, and the sync may re-add it, enabled if its provider's policy is ON
and it is eligible. After the first live sync, review `/llm-models` for models
you had renamed away and disable or delete them.

## New installations

A new installation starts with an empty allowlist and no prices.

New and upgraded installations intentionally end up with different data. The
release removes the seeds from the migrations that wrote them instead of
adding a migration that deletes them, because such a migration would also
delete rows that Hosts on upgraded installations may be serving. An upgraded
installation therefore keeps the seeded pairs and the placeholder prices
described above, while a new one never gets them.

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
