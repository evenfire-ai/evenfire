.PHONY: install build docker-build docker-push

REGISTRY ?= us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum
IMAGE_NAME ?= control-ui
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")
CONTROL_API_INTERNAL_URL ?= http://control-api.control-plane.svc.cluster.local:8090

install:
	npm install

build: install
	npm run build

dev: build
	CONTROL_API_INTERNAL_URL=http://localhost:8090 
	npm run dev

docker-build:
	docker build --build-arg CONTROL_API_INTERNAL_URL="$(CONTROL_API_INTERNAL_URL)" -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)
