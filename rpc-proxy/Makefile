.PHONY: install build dev docker-build docker-push docker-push-cross

PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)

REGISTRY ?= us-central1-docker.pkg.dev/your-gcp-project/clerum
IMAGE_NAME ?= rpc-proxy
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

install:
	npm install

build: install
	npm run build

dev: install
	CLERUM_DEV_MODE=true npm run dev

docker-build:
	docker build -f "$(PROJECT_ROOT)/rpc-proxy/Dockerfile" -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) "$(PROJECT_ROOT)"

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

docker-push-cross:
	docker buildx build --platform linux/amd64 -f "$(PROJECT_ROOT)/rpc-proxy/Dockerfile" -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push "$(PROJECT_ROOT)"
