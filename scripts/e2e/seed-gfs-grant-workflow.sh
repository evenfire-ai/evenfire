#!/usr/bin/env bash

# Sourced by seed-e2e-data.sh after its shared configuration and helpers load.
# This function reuses the existing authenticated recipe API and kubectl context.
render_gfs_grant_plugin_fixture() {
  RUBYOPT=--disable=gems ruby -ryaml -rjson -e '
    document = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
    abort "fixture must contain one YAML object" unless document.is_a?(Hash)
    puts JSON.generate(document)
  ' "$1"
}

normalize_gfs_grant_plugin_contract() {
  jq -S -c \
    '.spec
     | (.agent.provider |= type)
     | (.agent.model |= type)
     | ((.steps[] | select(
          .id == "approval-held-gfs-read"
          or .id == "approval-held-gfs-probe"
        )
        | .requiresApproval.target.userId) |= type)'
}

superseded_gfs_grant_plugin_contract() {
  normalize_gfs_grant_plugin_contract | jq -S -c \
    '.steps = [
       (.steps[] | select(.id == "approval-held-gfs-read")),
       (.steps[] | select(.id == "read-back-gfs-probe"))
     ]
     | .steps[0].id = "approval-held-gfs-probe"
     | .steps[0].instruction = "After the seeded user approves this E2E run, exercise the exact GFS file resource {{inputs.resourceId}} through this run-scoped host. Call clerum__gfs_read first and retain its exact content. Call clerum__gfs_stat next and retain its gfsUri and numeric version. Call clerum__gfs_write with drive \"main\", resourceId \"{{inputs.resourceId}}\", content \"{{inputs.updatedContent}}\", and ifMatch equal to the stat version. Do not claim success unless all three calls succeed. Return one concise JSON object containing resourceId, initialContent, gfsUri, statVersion, writeVersion, and updatedContent."
     | .steps[0].allowedTools.include = [
         "clerum__gfs_read",
         "clerum__gfs_stat",
         "clerum__gfs_write"
       ]
     | .steps[0].maxIterations = 6
     | .steps[1].dependsOn = ["approval-held-gfs-probe"]'
}

legacy_gfs_grant_plugin_contract() {
  normalize_gfs_grant_plugin_contract | jq -S -c \
    'del(.inputContract)
     | .steps = [.steps[] | select(.id == "approval-held-gfs-read")]
     | .steps[0] |= (
         .id = "approval-held-gfs-probe"
         | del(.allowedTools, .toolChoice)
         | .instruction = "Use the mock-tools MCP server only after the seeded user approves this E2E run."
         | .maxIterations = 5
       )'
}

previous_gfs_grant_plugin_contract() {
  normalize_gfs_grant_plugin_contract | jq -S -c \
    '.steps = [.steps[] | select(.id == "approval-held-gfs-read")]
     | .steps[0] |= (
         .id = "approval-held-gfs-probe"
         | .allowedTools.include = [
             "clerum__gfs_read",
             "clerum__gfs_stat",
             "clerum__gfs_write"
           ]
         | .instruction = "After the seeded user approves this E2E run, exercise the exact GFS file resource {{inputs.resourceId}} through this run-scoped host. Call clerum__gfs_read first and retain its exact content. Call clerum__gfs_stat next and retain its gfsUri and numeric version. Call clerum__gfs_write with drive \"main\", resourceId \"{{inputs.resourceId}}\", content \"{{inputs.updatedContent}}\", and ifMatch equal to the stat version. Finally call clerum__gfs_read again and verify its exact content equals \"{{inputs.updatedContent}}\". Do not claim success unless all four calls succeed. Return one concise JSON object containing resourceId, initialContent, gfsUri, statVersion, writeVersion, updatedContent, and readBackContent."
         | .maxIterations = 50
       )'
}

current_previous_gfs_grant_plugin_contract() {
  previous_gfs_grant_plugin_contract | jq -S -c \
    '(.steps[] | select(.id == "approval-held-gfs-probe") | .maxIterations) = 5'
}

interim_gfs_grant_plugin_contract() {
  previous_gfs_grant_plugin_contract | jq -S -c \
    '(.steps[] | select(.id == "approval-held-gfs-probe") | .maxIterations) = 7'
}

two_iteration_gfs_grant_plugin_contract() {
  normalize_gfs_grant_plugin_contract | jq -S -c \
    '.steps |= map(.maxIterations = 2)'
}

seed_gfs_grant_plugin_if_enabled() {
  local enabled="$SEED_GFS_GRANT_PLUGIN"
  local rendered probe code desired_spec current_spec desired_contract desired_superseded_contract desired_legacy_contract desired_previous_contract desired_current_previous_contract desired_interim_contract desired_two_iteration_contract current_contract phase message trigger_ready eager_pods deadline grant_ids

  if [ -z "$enabled" ]; then
    if is_minikube_context; then enabled="true"; else enabled="false"; fi
  fi
  if [ "$enabled" != "true" ]; then
    log "Skipping third-party GFS plugin seed for context $CONTEXT"
    return 0
  fi
  if ! is_minikube_context; then
    die "Refusing to seed the third-party GFS plugin outside minikube context '$CONTEXT'"
  fi
  case "$GFS_GRANT_PLUGIN_WAIT_SECONDS" in
    ''|*[!0-9]*) die "E2E_GFS_GRANT_PLUGIN_WAIT_SECONDS must be a positive integer" ;;
  esac
  [ "$GFS_GRANT_PLUGIN_WAIT_SECONDS" -gt 0 ] \
    || die "E2E_GFS_GRANT_PLUGIN_WAIT_SECONDS must be a positive integer"
  [ -f "$GFS_GRANT_PLUGIN_FIXTURE" ] \
    || die "Third-party GFS plugin fixture not found: $GFS_GRANT_PLUGIN_FIXTURE"
  [ -n "$USER_ID" ] || die "Cannot seed the third-party GFS plugin before the E2E user exists"
  [ -n "$GFS_GRANT_PLUGIN_MODEL_PROVIDER" ] \
    || die "Cannot seed the third-party GFS plugin without a workflow model provider"
  [ -n "$GFS_GRANT_PLUGIN_MODEL_NAME" ] \
    || die "Cannot seed the third-party GFS plugin without a workflow model name"
  printf '%s' "$USER_ID" \
    | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' \
    || die "Cannot seed the third-party GFS plugin with a non-UUID E2E user id"

  rendered="$(render_gfs_grant_plugin_fixture "$GFS_GRANT_PLUGIN_FIXTURE" | jq \
    --arg provider "$GFS_GRANT_PLUGIN_MODEL_PROVIDER" \
    --arg model "$GFS_GRANT_PLUGIN_MODEL_NAME" \
    --arg userRef "$USER_ID" \
    '.spec.agent.provider = $provider
     | .spec.agent.model = $model
     | (.spec.steps[] | select(.id == "approval-held-gfs-read")
        | .requiresApproval.target.userId) = $userRef' \
    )"

  printf '%s' "$rendered" | jq -e \
    --arg provider "$GFS_GRANT_PLUGIN_MODEL_PROVIDER" \
    --arg model "$GFS_GRANT_PLUGIN_MODEL_NAME" \
    --arg userRef "$USER_ID" \
    '.spec.agent == {provider: $provider, model: $model}
     and (.spec.steps | length == 4)
     and (.spec.steps[0].requiresApproval.target.userId == $userRef)
     and (.spec.inputContract.required | sort == ["resourceId", "updatedContent"])
     and (.spec.inputContract.properties.resourceId.type == "string")
     and (.spec.inputContract.properties.updatedContent.type == "string")
     and (.spec.steps[0].id == "approval-held-gfs-read")
     and (.spec.steps[0].allowedTools.include == ["clerum__gfs_read"])
     and (.spec.steps[0].toolChoice == "required")
     and (.spec.steps[0].maxIterations == 3)
     and (.spec.steps[1].id == "gfs-stat-probe")
     and (.spec.steps[1].dependsOn == ["approval-held-gfs-read"])
     and (.spec.steps[1].allowedTools.include == ["clerum__gfs_stat"])
     and (.spec.steps[1].toolChoice == "required")
     and (.spec.steps[1].maxIterations == 3)
     and (.spec.steps[2].id == "gfs-write-probe")
     and (.spec.steps[2].dependsOn == ["gfs-stat-probe"])
     and (.spec.steps[2].allowedTools.include == ["clerum__gfs_write"])
     and (.spec.steps[2].toolChoice == "required")
     and (.spec.steps[2].maxIterations == 3)
     and (.spec.steps[2].instruction | contains("{{gfs-stat-probe:output}}"))
     and (.spec.steps[3].id == "read-back-gfs-probe")
     and (.spec.steps[3].dependsOn == ["gfs-write-probe"])
     and (.spec.steps[3].allowedTools.include == ["clerum__gfs_read"])
     and (.spec.steps[3].toolChoice == "required")
     and (.spec.steps[3].maxIterations == 3)
     and (.spec.workloads | any(
       .id == "mock-tools"
       and .image == "clerum/mock-mcp-server:test"
       and .transport == {type: "streamableHttp", path: "/mcp"}
     ))
     and (.spec.gfs.mounts | any(
       .drive == "main"
       and .target == "e2e/gfs-grant-e2e-plugin"
       and (.scopes | sort == ["gfs.read", "gfs.write"])
     ))
     and (.spec | has("pluginWorkloadSdk") | not)
     and (.spec | has("contextRef") | not)' >/dev/null \
    || die "Rendered third-party GFS plugin fixture violates the standard WorkflowRecipe contract"
  if printf '%s' "$rendered" | grep -Eq 'PLACEHOLDER_[A-Z0-9_]+'; then
    die "Rendered third-party GFS plugin fixture still contains unresolved placeholders"
  fi

  probe="$(curl -sS -w '\n%{http_code}' \
    "$CAPI_BASE/admin/recipes/$GFS_GRANT_PLUGIN_RECIPE_NAME" "${AUTH_CURL[@]}" || true)"
  code="$(echo "$probe" | tail -n1)"
  case "$code" in
    200)
      desired_spec="$(printf '%s' "$rendered" | jq -S -c '.spec')"
      current_spec="$(echo "$probe" | sed '$d' | jq -S -c '.spec')"
      if [ "$current_spec" = "$desired_spec" ]; then
        ok "WorkflowRecipe $GFS_GRANT_PLUGIN_RECIPE_NAME already matches the standard seed"
      else
        # The canonical admin recipe API intentionally strips author-supplied
        # labels. Compare the complete spec while normalizing only the three
        # environment-seeded values; any other drift remains fail-closed.
        desired_contract="$(printf '%s' "$rendered" | normalize_gfs_grant_plugin_contract)"
        desired_superseded_contract="$(printf '%s' "$rendered" | superseded_gfs_grant_plugin_contract)"
        desired_legacy_contract="$(printf '%s' "$rendered" | legacy_gfs_grant_plugin_contract)"
        desired_previous_contract="$(printf '%s' "$rendered" | previous_gfs_grant_plugin_contract)"
        desired_current_previous_contract="$(printf '%s' "$rendered" | current_previous_gfs_grant_plugin_contract)"
        desired_interim_contract="$(printf '%s' "$rendered" | interim_gfs_grant_plugin_contract)"
        desired_two_iteration_contract="$(printf '%s' "$rendered" | two_iteration_gfs_grant_plugin_contract)"
        current_contract="$(echo "$probe" | sed '$d' | normalize_gfs_grant_plugin_contract)"
        if [ "$current_contract" != "$desired_contract" ] \
          && [ "$current_contract" != "$desired_superseded_contract" ] \
          && [ "$current_contract" != "$desired_legacy_contract" ] \
          && [ "$current_contract" != "$desired_previous_contract" ] \
          && [ "$current_contract" != "$desired_current_previous_contract" ] \
          && [ "$current_contract" != "$desired_interim_contract" ] \
          && [ "$current_contract" != "$desired_two_iteration_contract" ]; then
          die "Refusing to replace WorkflowRecipe $GFS_GRANT_PLUGIN_RECIPE_NAME without an exact recognized E2E fixture contract"
        fi
        put_json "$CAPI_BASE/admin/recipes/$GFS_GRANT_PLUGIN_RECIPE_NAME" "$rendered" \
          "PUT /admin/recipes/$GFS_GRANT_PLUGIN_RECIPE_NAME"
      fi
      ;;
    404)
      admin_post "$CAPI_BASE/admin/recipes" "$rendered" \
        "POST /admin/recipes ($GFS_GRANT_PLUGIN_RECIPE_NAME)"
      ;;
    *) die "GET /admin/recipes/$GFS_GRANT_PLUGIN_RECIPE_NAME failed with status=$code" ;;
  esac

  put_json \
    "$CAPI_BASE/admin/workflows/$GFS_GRANT_PLUGIN_RECIPE_NS/$GFS_GRANT_PLUGIN_RECIPE_NAME/grants" \
    "$(jq -cn --arg userId "$USER_ID" '{userIds:[$userId]}')" \
    "PUT /admin/workflows/$GFS_GRANT_PLUGIN_RECIPE_NS/$GFS_GRANT_PLUGIN_RECIPE_NAME/grants"
  admin_get \
    "$CAPI_BASE/admin/workflows/$GFS_GRANT_PLUGIN_RECIPE_NS/$GFS_GRANT_PLUGIN_RECIPE_NAME/grants" \
    "GET /admin/workflows/$GFS_GRANT_PLUGIN_RECIPE_NS/$GFS_GRANT_PLUGIN_RECIPE_NAME/grants"
  grant_ids="$(printf '%s' "$ADMIN_GET_BODY" | jq -c '[.items[]?.id] | sort')"
  [ "$grant_ids" = "[\"$USER_ID\"]" ] \
    || die "Third-party GFS plugin grant seed mismatch: expected only $USER_ID, got $grant_ids"
  ok "WorkflowRecipe $GFS_GRANT_PLUGIN_RECIPE_NAME trigger/approval grant seeded for $DEV_EMAIL"

  deadline=$((SECONDS + GFS_GRANT_PLUGIN_WAIT_SECONDS))
  phase=""; message=""; trigger_ready="false"
  while [ "$SECONDS" -lt "$deadline" ]; do
    admin_get "$CAPI_BASE/admin/recipes/$GFS_GRANT_PLUGIN_RECIPE_NAME" \
      "GET /admin/recipes/$GFS_GRANT_PLUGIN_RECIPE_NAME"
    phase="$(echo "$ADMIN_GET_BODY" | jq -r '.status.phase // empty')"
    message="$(echo "$ADMIN_GET_BODY" | jq -r '.status.message // empty')"
    trigger_ready="$(echo "$ADMIN_GET_BODY" | jq -r \
      '(.spec.triggers.onDemand != null)
       and (.status.workflowExecution == null)
       and ((.status.message // "") | startswith("Workflow trigger infrastructure registered"))')"
    if [ "$phase" = "active" ] && [ "$trigger_ready" = "true" ]; then break; fi
    sleep 2
  done
  if [ "$phase" != "active" ] || [ "$trigger_ready" != "true" ]; then
    die "WorkflowRecipe $GFS_GRANT_PLUGIN_RECIPE_NAME did not become trigger-ready (phase=${phase:-unknown}, message=${message:-missing})"
  fi
  ok "WorkflowRecipe $GFS_GRANT_PLUGIN_RECIPE_NAME is active with trigger infrastructure registered"

  eager_pods="$($KC -n "$GFS_GRANT_PLUGIN_RECIPE_NS" get pods \
    -l "clerum.io/recipe=$GFS_GRANT_PLUGIN_RECIPE_NAME,clerum.io/component=workflow-mcp-host" \
    -o name)"
  [ -z "$eager_pods" ] \
    || die "Standard WorkflowRecipe $GFS_GRANT_PLUGIN_RECIPE_NAME unexpectedly created an eager parent mcp-host: $eager_pods"
  ok "No eager parent mcp-host exists; a recipe-local host will be created only for a triggered run"
}
