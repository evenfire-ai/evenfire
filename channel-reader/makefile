.PHONY: dev build install clean docker-build docker-push docker-push-cross docker-login

REGISTRY ?= us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum
IMAGE_NAME ?= channel-reader
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")
TELEGRAM_BOT_TOKEN ?= # fill this in for local development
TELEGRAM_CHANNEL_ID ?= # fill this in for local development
TELEGRAM_USER_ID ?= # fill this in for local development

install:
	npm install

build: install
	npm run build

clean:
	rm -rf dist node_modules

# Run in development mode
# Note: Also start mcp-host in dev mode for message processing
# Example: In one terminal run `make dev` in mcp-host/, in another run `make dev` here
dev: build
	CLERUM_DEV_MODE=true \

	CLERUM_HOST_REF=chatllm \
	CLERUM_MCP_HOST_URL=http://localhost:8080 \
	CLERUM_TELEGRAM_BOT_TOKEN="$(TELEGRAM_BOT_TOKEN)" \
	CLERUM_CHANNEL='{"hostRef":"chatllm","telegram":[{"channelId":"$(TELEGRAM_CHANNEL_ID)","userIds":["$(TELEGRAM_USER_ID)"]}]}' \
	npm start

# Docker
docker-login:
	docker login $(REGISTRY)

docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

# Build and push multi-platform image (for M1/ARM hosts targeting amd64 clusters)
docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push .
