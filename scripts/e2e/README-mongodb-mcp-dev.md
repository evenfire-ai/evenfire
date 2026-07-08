# MongoDB MCP Stack — clerum-dev E2E Scripts

Helper scripts to set up, verify, diagnose, and exercise the `mongodb-mcp-stack`
WorkflowRecipe on the `clerum-dev` GKE cluster
(`gke_${GCP_PROJECT}_us-central1-a_clerum-dev`).

All scripts respect `KUBECONTEXT` env var; default is clerum-dev. Each script
wraps `kubectl` with `--context "$KCTX"` so the shell's current-context is
never load-bearing.

## Topology recap

```
WorkflowRecipe mongodb-mcp-stack (namespace: sandbox-recipes)
 ├─ StatefulSet mongodb            (sandbox-recipes ns, PVC 1Gi, UID 999)
 └─ Deployment mongodb-mcp-server  (mcp-server ns, StreamableHTTP :3000)

chatllm (mcp-host ns) ──▶ discovers via contextRef="context1"
                         ├─ airtable-server (16 tools)
                         └─ mongodb-mcp-server (24 tools)
```

## Scripts

| Script | Purpose | Idempotent |
|---|---|---|
| [`setup-mongodb-stack-dev.sh`](./setup-mongodb-stack-dev.sh) | Full end-to-end setup: mirror images to AR, apply recipe, patch security (UID 999 + fsGroup + capabilities), allowlist, restart chatllm, verify discovery. | Yes |
| [`verify-mongodb-stack-dev.sh`](./verify-mongodb-stack-dev.sh) | 5-stage health check: StatefulSet, MCP Deployment, McpServer CRD + allowlist, WorkflowRecipe phase, chatllm discovery logs. | Yes |
| [`diag-mongodb-pod.sh`](./diag-mongodb-pod.sh) | Diagnose `mongodb-0` crash loop. With `FIX_PVC=1`, deletes PVC+pod for fresh fsGroup ownership (workaround for stale root-owned files from pre-security-patch attempts). | Yes |
| [`fix-mongodb-probes-dev.sh`](./fix-mongodb-probes-dev.sh) | Patches StatefulSet probes from `exec: mongosh` (timeoutSeconds:1) to `tcpSocket:27017`. Workaround for issues [#154](https://github.com/your-org/evenfire/issues/154) + [#155](https://github.com/your-org/evenfire/issues/155). | Yes |
| [`bounce-chatllm-dev.sh`](./bounce-chatllm-dev.sh) | Rolling restart `chatllm` and surface MCP-discovery log lines. Useful after any context1 allowlist change. | Yes |
| [`playwright-dev.sh`](./playwright-dev.sh) + [`playwright-preflight-dev.sh`](./playwright-preflight-dev.sh) | Run Desktop App Playwright E2E against clerum-dev. Preflight ensures Airtable MCP is deployed + allowlisted before running. | Yes |

## Typical workflows

### First-time stack bring-up
```bash
bash scripts/e2e/setup-mongodb-stack-dev.sh
bash scripts/e2e/verify-mongodb-stack-dev.sh
```

### Stack is broken — diagnose
```bash
bash scripts/e2e/verify-mongodb-stack-dev.sh           # what's missing?
bash scripts/e2e/diag-mongodb-pod.sh                   # see pod logs + events
bash scripts/e2e/diag-mongodb-pod.sh FIX_PVC=1         # nuke stale PVC (last resort)
bash scripts/e2e/fix-mongodb-probes-dev.sh             # re-apply probe workaround if WRC reverted it
```

### Validate Desktop App against the stack
```bash
# ensure port-forwards are running first (make gcp-dev-pf-desktop)
bash scripts/e2e/playwright-dev.sh chat.test.ts -g "MongoDB"

# ── Visual debug modes ──
VISUAL=1 bash scripts/e2e/playwright-dev.sh chat.test.ts -g "MongoDB"   # Playwright Inspector (step-by-step)
UI=1     bash scripts/e2e/playwright-dev.sh                             # Playwright UI mode (interactive)
```

On macOS/Linux the Electron window is always visible — `VISUAL=1` adds the
Playwright Inspector which lets you step through each action.

## Known quirks (documented workarounds)

| Symptom | Root cause | Workaround |
|---|---|---|
| `mongodb-0` CrashLoopBackOff: `Permission denied` on `/data/db/journal` | PVC created during pre-security-patch attempt has root-owned files. `fsGroup:999` doesn't retroactively chown. | `FIX_PVC=1 bash diag-mongodb-pod.sh` deletes PVC so StatefulSet re-provisions it with fresh fsGroup. |
| `mongodb-0` probe timeouts under memory pressure (`mongosh … timed out after 1s`) | WRC auto-generates `exec: mongosh` probe with `timeoutSeconds:1`. Mongosh cold-start > 1s on 512Mi pods. | `bash fix-mongodb-probes-dev.sh` replaces with `tcpSocket:27017` probe. Upstream fix tracked in [#154](https://github.com/your-org/evenfire/issues/154) + [#155](https://github.com/your-org/evenfire/issues/155). |
| MCP pod missing `MDB_MCP_CONNECTION_STRING` env | Stale pod from pre-setup-script state. Spec is correct, pod wasn't rolled. | `kubectl rollout restart deployment/mongodb-mcp-server` — usually handled automatically by `setup-mongodb-stack-dev.sh` step 7. |
| `{{mongodb:host}}` template literal appears in MCP pod env | WRC in clerum-dev doesn't resolve cross-workload template vars for this recipe version. | `setup-mongodb-stack-dev.sh` performs a `sed` on the recipe YAML to substitute the explicit FQDN (`mongodb.sandbox-recipes.svc.cluster.local`) before applying. |
| WorkflowRecipe stuck in `phase: failed` on re-apply | WRC marks failed recipes as non-reconcilable and does not retry on spec change. | `setup-mongodb-stack-dev.sh` step 4 detects `phase: failed` and performs delete+recreate. |

## Related

- **Issues filed**: [#154](https://github.com/your-org/evenfire/issues/154), [#155](https://github.com/your-org/evenfire/issues/155)
- **Test**: `desktop-app/test/e2e-playwright/chat.test.ts::test("5. agent uses MongoDB tool to list databases")`
- **Recipe source**: `workflow-recipes/samples/mongodb-mcp-stack.yaml`
