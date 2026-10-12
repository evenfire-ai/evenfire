# AI Recipe Builder App Architecture

The AI Recipe Builder is a Clerum-native sandbox application for designing
`WorkflowRecipe` manifests through a guided LLM conversation. It appears inside
the Desktop App as a custom app, lets the operator talk naturally with an AI
agent, drafts a reviewable plan, and only generates WorkflowRecipe YAML after
the operator confirms that plan.

The app is intentionally conservative. It does not install generated recipes,
publish registry entries, or mutate Kubernetes. Its job is to help an operator
think through the design, produce safer starter YAML, surface required setup
steps, and leave final install/publish decisions to Control UI or Control API.

## What It Is

At a high level, the app is a recipe-design assistant:

- It runs inside Clerum as a `WorkflowRecipe`.
- It exposes a custom UI inside Desktop App -> Apps.
- It has a backend API that can call an OpenAI-compatible LLM provider.
- It chats naturally with the operator before producing YAML.
- It separates planning from creation with an explicit `Confirm plan` button.
- It validates generated YAML locally before showing it to the operator.
- It emits a registry payload and setup checklist for human review.

The main product idea is simple: recipe creation should feel like working with a
technical teammate, not filling out a brittle form. The operator can describe an
app, workflow, MCP tool, webhook integration, OAuth flow, scheduled job, or data
service in natural language. The assistant asks clarifying questions when the
request is vague, drafts a concrete plan when enough detail exists, and generates
YAML only after confirmation.

## Why It Is A WorkflowRecipe

We kept this as a `WorkflowRecipe` instead of a standalone MCP server because
the desired user experience is a custom UI inside the Desktop App. MCP servers
are excellent for exposing tools to agents, but they do not by themselves provide
a rich embedded application surface. A WorkflowRecipe can expose a sandbox UI
while still running a backend workload with controlled secrets and egress.

This gives us the better fit for this use case:

- The user gets a first-class app tile in Desktop.
- The UI can provide chat, plan review, copy buttons, generated YAML, registry
  payloads, validation output, and theme controls.
- The backend can hold the optional LLM secret.
- The recipe remains permission-light and operator-approved.

## Runtime Shape

The deployed app has two workloads:

```text
Desktop App
  -> sandbox-ui/ui workload
       -> internal egress/proxy to sandbox-recipes/api workload
            -> optional exact-host egress to LLM provider
```

The `WorkflowRecipe` custom resource lives in `sandbox-recipes`, following the
repo invariant that all WorkflowRecipe CRDs belong there. The rendered UI
workload runs in `sandbox-ui`, and the backend API workload runs in
`sandbox-recipes`.

The UI workload does not receive AI provider secrets. It proxies API calls to the
backend by using `RECIPE_BUILDER_PROXY_TARGET`, which is rendered from the recipe
template as:

```yaml
value: 'http://{{api:host}}:{{api:port}}'
```

The API workload optionally receives the `ai-recipe-builder-llm` Secret:

```text
RECIPE_BUILDER_API_KEY
RECIPE_BUILDER_BASE_URL
RECIPE_BUILDER_MODEL
```

If the secret is missing, the app still works in deterministic mode. In
deterministic mode it can infer capabilities, create a conservative plan, and
generate starter YAML without calling an external model.

## User Experience

The current UI is a single-page app with these primary areas:

- Header with service health, configured model, and light/dark toggle.
- Natural-language chat panel.
- Plan review panel.
- Generated result panel with assistant notes.
- Capability chips.
- Local validation status.
- Setup checklist.
- Registry payload preview.
- WorkflowRecipe YAML preview and copy button.

The chat behavior is intentionally staged:

1. The user can chat casually or ask what the assistant is.
2. The assistant responds naturally in LLM text mode.
3. If the user asks for a recipe but the request is underspecified, the assistant
   asks focused clarifying questions.
4. Once the request is concrete, the assistant returns a structured plan.
5. The UI shows `Confirm plan`.
6. Only after confirmation does the backend generate YAML.

This avoids the earlier bad behavior where a greeting like "hi bro" generated a
fake recipe. A casual message is now treated as conversation, not as build
intent.

## Feature Summary

The app currently supports:

- Natural language LLM chat.
- Recipe-intent detection.
- Clarifying question mode.
- Plan-first generation.
- Confirm-before-YAML flow.
- OpenAI-compatible LLM configuration.
- Deterministic fallback when AI is disabled or unavailable.
- Local WorkflowRecipe validation.
- Inline secret detection guard.
- Capability inference for UI, database, workflow, MCP, webhook, OAuth, cron,
  and egress.
- Generated setup checklist.
- Generated registry payload.
- Light and dark mode using the Desktop App visual language.
- Embedded Desktop-safe relative API paths.

## Safety Model

The app is a drafting tool, not an installer.

It does not receive Kubernetes write privileges. It does not apply generated
YAML. It does not create Secrets. It does not publish to the registry. This is
intentional.

The generated output still needs operator review because a WorkflowRecipe can
describe workloads, network access, OAuth clients, webhooks, persistent storage,
and external integrations. The app tries to make those requirements explicit
instead of hiding them.

Safety boundaries:

- WorkflowRecipe CRDs are generated for `sandbox-recipes`.
- Secrets are referenced through `envSecret`, not inline values.
- Public internet access is represented through explicit `egressBindings`.
- UI workloads should not receive provider secrets.
- Generated YAML is locally validated before display.
- Human approval is required for install and publish.

## Source Layout

The app lives under:

```text
workflow-recipes/samples/ai-recipe-builder/
  Dockerfile
  README.md
  recipe.yaml
  server.js
  public/
    index.html
    app.js
    styles.css
  test-control-api-permissions.sh
```

Supporting documentation:

```text
docs/features/ai-recipe-builder-minikube-operator-cheatsheet.md
docs/features/ai-recipe-builder-app-architecture.md
docs/features/control-ui-workflow-recipes-and-registry-guide.md
```

## WorkflowRecipe Definition

The installable recipe is:

```text
workflow-recipes/samples/ai-recipe-builder/recipe.yaml
```

Important fields:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ai-recipe-builder
  namespace: sandbox-recipes
spec:
  contextRef: context1
  workloads:
    - id: api
      type: deployment
      image: clerum/ai-recipe-builder:0.1.0
    - id: ui
      type: deployment
      image: clerum/ai-recipe-builder:0.1.0
      dependsOn: [api]
  ui:
    workloadRef: ui
    port: 8080
    title: 'AI Recipe Builder'
```

The `api` workload:

- Runs in `sandbox-recipes`.
- Hosts `/api/*`.
- Reads the optional LLM Secret.
- Has exact-host egress to `api.openai.com` and `api.z.ai`.
- Performs validation and generation.

The `ui` workload:

- Runs in `sandbox-ui`.
- Hosts the static HTML/CSS/JS app.
- Does not receive AI credentials.
- Proxies `api/*` to the backend API using `RECIPE_BUILDER_PROXY_TARGET`.

Both workloads use the same image. The difference is their environment and
namespace placement.

## Docker Image

The image is intentionally small:

```dockerfile
FROM node:20-alpine

USER node
WORKDIR /home/node/app

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

EXPOSE 8080
CMD ["node", "server.js"]
```

There is no `npm install` step because the implementation uses Node built-ins and
the runtime `fetch` available in Node 20.

## Backend API

The backend is:

```text
workflow-recipes/samples/ai-recipe-builder/server.js
```

It uses Node's built-in `http`, `fs`, and `path` modules. It serves static files
and JSON API routes from the same process.

### Environment Variables

```text
PORT
RECIPE_BUILDER_API_KEY
RECIPE_BUILDER_BASE_URL
RECIPE_BUILDER_MODEL
RECIPE_BUILDER_PROXY_TARGET
```

Defaults:

```text
PORT=8080
RECIPE_BUILDER_BASE_URL=https://api.openai.com/v1
RECIPE_BUILDER_MODEL=gpt-5.4-mini
```

When `RECIPE_BUILDER_PROXY_TARGET` is present, the process behaves as the UI
proxy for `/api/*` calls. That is how the sandbox UI reaches the backend without
holding secrets.

### Routes

```text
GET  /healthz
GET  /api/health
POST /api/chat-plan
POST /api/create-from-plan
POST /api/draft
POST /api/validate
GET  /*
```

`GET /healthz` and `GET /api/health`

Returns service status, AI configuration state, proxy target, and model name.

`POST /api/chat-plan`

Accepts chat messages:

```json
{
  "useAi": true,
  "messages": [
    { "role": "user", "content": "Build a dashboard that checks domain expiry daily" }
  ]
}
```

Returns one of three modes:

```text
chat      casual natural-language response
question  focused clarification before planning
plan      structured plan ready for operator confirmation
```

Normal conversation uses plain LLM text mode through `callAiText`. Recipe
planning uses structured JSON through `callAiJson`.

`POST /api/create-from-plan`

Accepts a confirmed plan and generates the final draft.

```json
{
  "useAi": true,
  "plan": {
    "name": "domain-expiry-dashboard",
    "objective": "Build a dashboard that checks domain expiry daily"
  }
}
```

Returns:

- `recipeName`
- `recipeYaml`
- `capabilities`
- `checklist`
- `registryPayload`
- `validation`
- optional `aiUnderstood`, `aiAssumptions`, `aiNotes`, and `aiError`

`POST /api/draft`

Legacy direct drafting endpoint. It remains for smoke tests and backwards
compatibility, but the UI now prefers chat -> plan -> confirm.

`POST /api/validate`

Runs local validation on a supplied YAML string.

### Important Backend Functions

```text
inferCapabilities(prompt)
isActionableBuildPrompt(prompt)
buildDeterministicPlan(messages)
normalizePlan(raw, fallbackMessages)
generateDeterministicDraft({ prompt, recipeName })
validateDraft(yaml)
hasInlineSecretValue(yaml)
callAiText(messages)
callAiJson(messages)
maybePlanWithAi(messages, useAi)
maybeGenerateWithAi(input)
```

The design splits normal chat and structured planning:

- `callAiText` is used for natural conversation.
- `callAiJson` is used only where structured output is required.
- `maybePlanWithAi` chooses chat, question, or plan mode.
- `maybeGenerateWithAi` generates or improves WorkflowRecipe YAML.
- deterministic helpers provide a no-AI fallback.

## System Prompt Context

The backend includes a compact system context derived from the WorkflowRecipe
guide. It teaches the agent the local invariants:

- WorkflowRecipe CRDs live in `sandbox-recipes`.
- UI workloads run in `sandbox-ui`.
- Backend workloads run in `sandbox-recipes`.
- UI workloads should not receive secrets.
- Secrets should be referenced through `envSecret`.
- Provider access requires explicit egress bindings.
- MCP transport children belong in `mcp-server` only when transport is declared.
- Casual chat is allowed and should not become a fake recipe.
- YAML generation happens after plan confirmation.

This context is intentionally embedded in `server.js` so the deployed sample is
self-contained. Future versions could load it from documentation or a
versioned prompt file.

## Frontend App

The frontend lives in:

```text
workflow-recipes/samples/ai-recipe-builder/public/
  index.html
  app.js
  styles.css
```

`index.html` defines the app shell:

- hero/header
- health chip
- light/dark toggle
- chat panel
- plan panel
- generated output panel

`app.js` manages browser state:

```text
currentYaml
currentPlan
chatMessages
```

Important UI functions:

```text
preferredTheme()
applyTheme(theme)
renderChat()
renderPlan(plan)
renderDraft(draft)
renderValidation(validation)
sendMessage()
confirmPlan()
copyYaml()
```

The browser uses relative API paths like `api/chat-plan`, not absolute `/api/*`.
That matters inside the Desktop embedded app because the sandbox UI may be
served from a nested path.

`styles.css` ports the Desktop App visual language into this standalone sample:

- dark neutral shell
- warm light mode
- burnt-orange accent
- glass-like panels
- matching controls, chips, validation states, and code blocks

The selected theme is stored in:

```text
localStorage["ai-recipe-builder.theme"]
```

## LLM Connection

The app expects an OpenAI-compatible chat completions API:

```text
POST <base-url>/chat/completions
Authorization: Bearer <api-key>
```

The local minikube setup used a ZAI-compatible endpoint:

```text
base-url=https://api.z.ai/api/coding/paas/v4
model=glm-4.7
```

The Secret shape is:

```bash
kubectl --context=clerum-test -n sandbox-recipes create secret generic ai-recipe-builder-llm \
  --from-literal=api-key="<provider-api-key>" \
  --from-literal=base-url="<openai-compatible-base-url>" \
  --from-literal=model="<model-name>"
```

For ownership and Secret discovery, the local secret should be labeled:

```bash
kubectl --context=clerum-test -n sandbox-recipes label secret ai-recipe-builder-llm \
  clerum.io/owner-recipe=ai-recipe-builder --overwrite
```

Never store real keys in documentation.

## Data Flow

Natural chat:

```text
User message
  -> public/app.js sendMessage()
  -> POST api/chat-plan
  -> ui workload proxy
  -> api workload /api/chat-plan
  -> callAiText()
  -> OpenAI-compatible provider
  -> assistant text response
  -> chat bubble
```

Recipe plan:

```text
Concrete build request
  -> POST api/chat-plan
  -> maybePlanWithAi()
  -> callAiJson()
  -> structured plan JSON
  -> renderPlan()
  -> Confirm plan button
```

YAML generation:

```text
Confirm plan
  -> POST api/create-from-plan
  -> maybeGenerateWithAi()
  -> generated WorkflowRecipe YAML
  -> validateDraft()
  -> registry payload + checklist + YAML preview
```

No generated resource is applied automatically.

## Local Build And Rollout

Build the image into the minikube Docker daemon:

```bash
cd /home/pal/Clerum/Code/clerum
eval "$(minikube -p clerum-test docker-env)"

docker build -t clerum/ai-recipe-builder:0.1.0 \
  workflow-recipes/samples/ai-recipe-builder
```

Restart both workloads:

```bash
kubectl --context=clerum-test -n sandbox-recipes rollout restart deploy/api
kubectl --context=clerum-test -n sandbox-ui rollout restart deploy/ui

kubectl --context=clerum-test -n sandbox-recipes rollout status deploy/api --timeout=120s
kubectl --context=clerum-test -n sandbox-ui rollout status deploy/ui --timeout=120s
```

The UI may need a Desktop embedded-view refresh after rollout because the webview
can keep old JavaScript in memory.

## Live Debugging

Check the API workload logs:

```bash
kubectl --context=clerum-test -n sandbox-recipes logs deploy/api --tail=160
```

Check the Secret shape without printing secret values:

```bash
kubectl --context=clerum-test -n sandbox-recipes get secret ai-recipe-builder-llm \
  -o go-template='{{range $k,$v := .data}}{{printf "%s len=%d\n" $k (len ($v | base64decode))}}{{end}}'
```

Verify env wiring:

```bash
kubectl --context=clerum-test -n sandbox-recipes get deploy api \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{" secret="}{.valueFrom.secretKeyRef.name}{":"}{.valueFrom.secretKeyRef.key}{"\n"}{end}'
```

Test chat from inside the pod:

```bash
kubectl --context=clerum-test -n sandbox-recipes exec -i deploy/api -- node - <<'NODE'
(async () => {
  const res = await fetch('http://127.0.0.1:8080/api/chat-plan', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({
      useAi: true,
      messages: [
        {role:'user', content:'hi, can you tell me who you are?'}
      ]
    })
  });
  console.log(await res.text());
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
NODE
```

Expected shape:

```json
{
  "mode": "chat",
  "assistantMessage": "..."
}
```

## Known Limits

The app is a strong v1, but it is still a drafting assistant:

- It does not persist chat history across reloads.
- It does not stream tokens.
- It does not apply generated YAML.
- It does not publish registry entries.
- It does not manage provider keys.
- It does not deeply validate every CRD field against the Kubernetes OpenAPI
  schema.
- It uses an embedded system prompt in `server.js` rather than a separate prompt
  asset.

## Good Future Improvements

High-value next steps:

- Add streaming chat responses.
- Persist sessions locally or in a recipe-owned store.
- Add an explicit edit-plan step before confirmation.
- Add CRD schema-backed validation through Control API.
- Add a registry publish draft flow.
- Add model/provider selection when multiple shared LLM secrets exist.
- Add generated diff views when the plan changes.
- Add tests for chat mode, plan mode, fallback mode, and invalid YAML fallback.
- Move the system prompt into a versioned markdown or prompt file.
- Add a "copy install commands" panel for generated recipes.

The important architectural principle should stay the same: the app can assist,
draft, and validate, but human operators approve the resources that enter the
cluster.
