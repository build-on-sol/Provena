#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Explicit loopback URL prevents this helper from using a configured remote cluster.
node scripts/setup-local.cjs
node scripts/sync-local-program.cjs
cargo build-sbf --tools-version v1.57 --manifest-path programs/content_rights_protocol/Cargo.toml --sbf-out-dir target/deploy
cargo run -p content-rights-protocol --example build_idl -- programs/content_rights_protocol idl/content_rights_protocol.json
npm run build
solana --url http://127.0.0.1:8899 --keypair target/local-authorities/admin.json airdrop 20
solana --url http://127.0.0.1:8899 --keypair target/local-authorities/admin.json program deploy --program-id target/deploy/content_rights_protocol-keypair.json target/deploy/content_rights_protocol.so
node scripts/initialize-local.cjs
printf 'Local program deployed and initialized with separate admin, originality, rights and treasury keys.\n'
