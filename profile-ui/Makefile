.PHONY: install build dev docker-build docker-push

REGISTRY ?= us-central1-docker.pkg.dev/your-gcp-project/clerum
IMAGE_NAME ?= profile-ui
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")
PORT ?= 3000

install:
	npm install

build: install
	npm run build

dev: install
	EXTERNAL_REST_API_INTERNAL_URL=http://localhost:8091 npm run dev -- --port $(PORT)

docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)
