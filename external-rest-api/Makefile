.PHONY: install build dev docker-build docker-push

REGISTRY ?= us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum
IMAGE_NAME ?= external-rest-api
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

install:
	npm install

build: install
	npm run build

dev: install
	npm run dev

docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)
