.PHONY: build clean install dev docker-build docker-push docker-push-cross

# Variables
REGISTRY ?= us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum
IMAGE_NAME ?= stdio-bridge
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

install:
	npm install

build: install
	npm run build

clean:
	rm -rf dist node_modules

dev: build
	STDIO_COMMAND=echo \
	STDIO_ARGS='["hello"]' \
	BRIDGE_PORT=3000 \
	npm start

docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push .
