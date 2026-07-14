.PHONY: deploy-mongodb undeploy-mongodb deploy-airtable undeploy-airtable deploy-playwright undeploy-playwright deploy-all undeploy-all

RUBY ?= ruby
PUBLIC_EGRESS_EXCEPTIONS ?= ../deploy/base/public-egress-exceptions.yaml
PUBLIC_EGRESS_RENDERER ?= ../deploy/scripts/render-public-egress-exceptions.rb

# The skill-mapper operator automatically creates Deployments and Services
# when it detects McpServer CRDs. You only need to deploy:
#   1. The secret (credentials the MCP server needs)
#   2. The McpServer CRD (defines the server for the operator)

# ─── MongoDB MCP Server ───────────────────────────────────────────────

deploy-mongodb:
	kubectl apply -f mongodb/secret.yaml
	kubectl apply -f mongodb/mcpserver.yaml
	$(RUBY) $(PUBLIC_EGRESS_RENDERER) $(PUBLIC_EGRESS_EXCEPTIONS) mongodb/networkpolicy.yaml | kubectl apply -f -

undeploy-mongodb:
	$(RUBY) $(PUBLIC_EGRESS_RENDERER) $(PUBLIC_EGRESS_EXCEPTIONS) mongodb/networkpolicy.yaml | kubectl delete -f - --ignore-not-found
	kubectl delete -f mongodb/mcpserver.yaml --ignore-not-found
	kubectl delete -f mongodb/secret.yaml --ignore-not-found

# ─── Airtable MCP Server ─────────────────────────────────────────────

deploy-airtable:
	kubectl apply -f airtable/secret.yaml
	kubectl apply -f airtable/mcpserver.yaml
	$(RUBY) $(PUBLIC_EGRESS_RENDERER) $(PUBLIC_EGRESS_EXCEPTIONS) airtable/networkpolicy.yaml | kubectl apply -f -

undeploy-airtable:
	$(RUBY) $(PUBLIC_EGRESS_RENDERER) $(PUBLIC_EGRESS_EXCEPTIONS) airtable/networkpolicy.yaml | kubectl delete -f - --ignore-not-found
	kubectl delete -f airtable/mcpserver.yaml --ignore-not-found
	kubectl delete -f airtable/secret.yaml --ignore-not-found

# ─── Playwright MCP Server ────────────────────────────────────────────

deploy-playwright:
	kubectl apply -f playwright/mcpserver.yaml
	$(RUBY) $(PUBLIC_EGRESS_RENDERER) $(PUBLIC_EGRESS_EXCEPTIONS) playwright/networkpolicy.yaml | kubectl apply -f -

undeploy-playwright:
	$(RUBY) $(PUBLIC_EGRESS_RENDERER) $(PUBLIC_EGRESS_EXCEPTIONS) playwright/networkpolicy.yaml | kubectl delete -f - --ignore-not-found
	kubectl delete -f playwright/mcpserver.yaml --ignore-not-found

# ─── All MCP Servers ──────────────────────────────────────────────────

deploy-all: deploy-mongodb deploy-airtable deploy-playwright

undeploy-all: undeploy-mongodb undeploy-airtable undeploy-playwright
