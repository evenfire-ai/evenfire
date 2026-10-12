.PHONY: install build dev docker-build docker-push

PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)

REGISTRY ?= us-central1-docker.pkg.dev/your-gcp-project/clerum
IMAGE_NAME ?= external-rest-api
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

install:
	npm install

build: install
	npm run build

dev: install
	CLERUM_DEV_MODE=true npm run dev

docker-build:
	docker build -f "$(PROJECT_ROOT)/external-rest-api/Dockerfile" -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) "$(PROJECT_ROOT)"

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)
