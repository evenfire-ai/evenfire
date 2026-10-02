.PHONY: install build docker-build docker-push

PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)

REGISTRY ?= us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum
IMAGE_NAME ?= control-api
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

install:
	npm install

build: install
	npm run build

docker-build:
	docker build -f "$(PROJECT_ROOT)/control-api/Dockerfile" -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) "$(PROJECT_ROOT)"

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)
