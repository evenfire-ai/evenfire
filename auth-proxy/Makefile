.PHONY: build clean install dev docker-build docker-push docker-push-cross test

REGISTRY ?= us-central1-docker.pkg.dev/eventfire-491421/clerum
IMAGE_NAME ?= auth-proxy
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
	npm start

docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push .
