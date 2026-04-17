# Deploy meet to Polkadot
#
# Prerequisites:
#   1. Node.js >= 22
#   2. bulletin-deploy: npm install -g bulletin-deploy

BRANCH := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
DOMAIN ?= meet-$(BRANCH)00.dot
MNEMONIC ?= team silver catch almost series idea either else owner surround diary south

.PHONY: build deploy

build:
	npx next build

deploy: build
	MNEMONIC="$(MNEMONIC)" \
	NODE_OPTIONS="--max-old-space-size=8192" \
	bulletin-deploy 'out' '$(DOMAIN)'
