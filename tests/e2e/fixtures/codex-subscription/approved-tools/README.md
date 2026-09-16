# Approved tools MCP fixture

This development-only Node 24 service exposes a real stateless Streamable HTTP
MCP endpoint at `/mcp`. It does not implement Evenfire discovery, permissions,
the model or the execution bridge. Its HTTP contracts use MCP Host's installed
MCP SDK client. No new dependencies are required.

## Startup and deployment

Run `node --test tests/e2e/fixtures/codex-subscription/approved-tools/server.test.mjs`
from the repository root after installing MCP Host dependencies. HTTP contract
tests use ephemeral loopback ports and require host execution if the sandbox
forbids listening. No subscription is consumed.

Start the service with `node tests/e2e/fixtures/codex-subscription/approved-tools/server.mjs`.
CATALOG_SIZE defaults to 83; set it explicitly to 83, 150 or 250 for each
measured scenario. Configure RUN_ID to a unique safe run
identifier, and PORT to the assigned port. The default bind address is loopback.
For the isolated Minikube instance set BIND_ADDRESS to all interfaces. The
Node 24 test container needs only server.mjs mounted read-only.

Use a separate instance per scenario. Deploy through the documented owned
development-profile harness and its mutation lease. Expose a cluster-internal
Service with `/health` readiness and register `/mcp` through the supported
MCPServer/plugin test fixture path. Grant access through visible UI during
the E2E journey. Do not expose this service publicly or relax production
authentication, network or provider policy. No cluster operation is performed
by these files.

There is no reset endpoint. Restarting loses evidence and invalidates the run.
Cleanup only that run's resources after collecting evidence. Require zero
initial calls before starting the visible journey.

## Catalog and evidence

The catalog contains exactly CATALOG_SIZE tools. The last is
`workitem_read_receipt`, with the unique search phrase **verification receipt**.
Other tools read numbered work item categories. All schemas are empty objects
with no additional properties or required arguments.

A successful `tools/call` returns a text block containing JSON fields runId,
tool, callId and businessId. The business identifier is a UUID created inside
the service on the first business call. It is absent from the catalog, prompt
and initial evidence. Subsequent calls read the same identifier and each
invocation is recorded, so duplicate or unrelated operations remain observable.

`GET /health` returns ready, catalogSize and runId. `GET /evidence` requires
the configured runId query parameter and returns runId, catalogSize and calls.
Each call is the exact record returned by the operation. An invalid run ID
returns 400; a different run returns 404. Observation cannot advance the flow.
Discovery and rejected calls do not create records. After UI revocation,
reuse the same instance and verify its call count remains unchanged.

callId is the MCP JSON-RPC request ID, which can differ from the model call ID.
Correlate that boundary using real Evenfire execution evidence. The fixture
does not claim user or agent identity from model arguments.

## Responsibility and false-positive review

| Layer                  | Proof                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| HTTP contracts         | SDK initialization, exact catalog, valid schemas, actual calls, nonce and counters       |
| Browser E2E            | Visible login, configuration, grant, chat and response matching observed business result |
| Host/upstream evidence | Correct provider, selective definitions, identity and approval correlation               |

These protocol tests cannot certify intermediate rendering, button behavior,
UI transitions or protected-route guards. The browser lane must fail on each
of those faults and on an invented answer without an MCP execution. It must
not call `/mcp` itself to manufacture evidence. Evidence reads are observation
only. No internal Evenfire API is mocked or called here to skip its user flow.
Minikube, Playwright and real-subscription validation remain separate lanes.
