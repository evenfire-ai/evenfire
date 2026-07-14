REGISTRY ?= us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum
IMAGE    ?= clerum-workflow-base
VERSION  ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

.PHONY: build test docker-build publish validate clean

build:
	npm run build

test:
	npm test

clean:
	rm -rf dist

docker-build: build
	docker build -f packages/workflow-sdk/Dockerfile.base -t $(REGISTRY)/$(IMAGE):$(VERSION) ../..

publish: docker-build
	docker push $(REGISTRY)/$(IMAGE):$(VERSION)

validate: test build
	@echo "SDK validation passed: tests + build OK"
