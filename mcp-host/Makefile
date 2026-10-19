.PHONY: build clean install dev dev-claude dev-model docker-build docker-push docker-push-cross

# Variables

REGISTRY ?= us-central1-docker.pkg.dev/your-gcp-project/clerum
IMAGE_NAME ?= mcp-host
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

# Install dependencies
install:
	npm install

# Build TypeScript
build: install
	npm run build

# Clean build artifacts
clean:
	rm -rf dist node_modules

# Dev mode runs with JWT auth off (CLERUM_ENABLE_AUTH=false). With auth on,
# mcp-host refuses to start without CLERUM_AUTH_JWT_PUBLIC_KEY. Only run these
# targets on a machine and network you control.

# Run in development mode with OpenAI (uses OPENAI_API_KEY from env)
# Example: OPENAI_API_KEY=sk-xxx make dev
dev: build
	CLERUM_DEV_MODE=true \
	CLERUM_ENABLE_AUTH=false \
	npm start

# Run in dev mode with Claude (uses CLAUDE_API_KEY from env)
# Example: CLAUDE_API_KEY=sk-ant-xxx make dev-claude
dev-claude: build
	CLERUM_DEV_MODE=true \
	CLERUM_ENABLE_AUTH=false \
	CLERUM_MODEL_PROVIDER=claude \
	npm start

# Run in dev mode with a specific model
# Example: OPENAI_API_KEY=sk-xxx make dev-model MODEL=gpt-4-turbo
dev-model: build
	CLERUM_DEV_MODE=true \
	CLERUM_ENABLE_AUTH=false \
	CLERUM_MODEL_NAME=$(MODEL) \
	npm start

# Build Docker image. The build context is the repo root (..) because the
# Dockerfile COPYs the shared packages/ that mcp-host links via file: deps.
docker-build:
	docker build -f Dockerfile -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) ..

# Push Docker image
docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

# Build and push multi-platform image (for M1/ARM hosts targeting amd64 clusters)
docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) -f Dockerfile --push ..

