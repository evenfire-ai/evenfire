.PHONY: build dev dev-example clean docker-build docker-push docker-push-cross install

REGISTRY ?= us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum
IMAGE_NAME ?= host-context-controller
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

# Install dependencies
install:
	npm install

# Build TypeScript
build: install
	npm run build

# Run in development mode with .env file
# Copy .env.example to .env and modify as needed
dev: build
	@if [ -f .env ]; then \
		set -a && . ./.env && set +a && npm start; \
	else \
		echo "No .env file found. Copy .env.example to .env and configure it."; \
		echo "Or use 'make dev-example' for a quick test."; \
		exit 1; \
	fi

# Run with inline example MCP servers for quick testing (no .env needed)
# Note: image field is required in the CRD but not used in dev mode (no reconciliation)
dev-example: build
	CLERUM_DEV_MODE=true \
	CLERUM_MCP_SERVERS='[{"name":"filesystem","spec":{"contextRef":"dev-context","description":"Filesystem operations","image":"mcp/filesystem:latest","transport":{"type":"sse","url":"http://localhost:3001/sse","port":3001},"enabled":true}},{"name":"github","spec":{"contextRef":"dev-context","description":"GitHub operations","image":"mcp/github:latest","transport":{"type":"sse","url":"http://localhost:3002/sse","port":3002},"auth":{"type":"bearer","secretRef":"github-token"},"enabled":true}}]' \
	CLERUM_CONTEXTS='[{"name":"dev-context","namespace":"dev","spec":{"contextId":"dev-context","description":"Dev context","mcpServers":["filesystem","github"]}}]' \
	CLERUM_MCP_AUTH='{"github":"ghp_example_token_123"}' \
	npm start

# Clean build artifacts
clean:
	rm -rf dist node_modules

# Docker build
docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

# Docker push (requires login)
docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

# Build and push multi-platform image (for M1/ARM hosts targeting amd64 clusters)
docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push .
