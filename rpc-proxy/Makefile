.PHONY: install build dev docker-build docker-push docker-push-cross

REGISTRY ?= us-central1-docker.pkg.dev/your-gcp-project/clerum
IMAGE_NAME ?= rpc-proxy
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

docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push .
