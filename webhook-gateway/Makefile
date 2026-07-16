.PHONY: build clean install dev docker-build docker-push docker-push-cross test

REGISTRY ?= us-central1-docker.pkg.dev/your-gcp-project/clerum
IMAGE_NAME ?= webhook-gateway
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

install:
	npm install

build: install
	npm run build

clean:
	rm -rf dist node_modules

test:
	npm test

dev: build
	GATEWAY_RECIPE_NAMESPACE=sandbox-recipes \
	GATEWAY_RECIPE_NAME=local-dev \
	GATEWAY_CONFIG_PATH=$(PWD)/test/fixtures/dev-config.json \
	npm start

docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push .
