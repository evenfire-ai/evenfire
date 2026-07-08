.PHONY: install build dev start clean reinstall port-forward-external-rest-api port-forward-rpc-proxy port-forward-profile-ui port-forward-control-api

install:
	npm install

build: install
	npm run build

dev: build
	npm run dev

start: build
	npm run start

clean:
	rm -rf dist

reinstall:
	rm -rf node_modules package-lock.json
	npm install

port-forward-external-rest-api:
	kubectl -n profiles port-forward svc/external-rest-api 8091:8091

port-forward-rpc-proxy:
	kubectl -n rpc-proxy port-forward svc/rpc-proxy 8094:8094

