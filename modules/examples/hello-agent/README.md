# examples: hello-agent

## Purpose
Reference module used to prove the module contract and removal guarantees (not a product).

## Dependencies
@platform/contracts, @platform/core only.

## Setup
Add to modules.config.json, run `npm run migrate`, enable per tenant with `tenant:enable-module`.

## Removal
Remove from modules.config.json (disable; data kept), then `module:purge <id> --confirm <id>` and `module:verify-absent <id>`.
