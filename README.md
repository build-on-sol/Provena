# Provena

Solana V0 content rights settlement: Content → Rights → Distribution → Revenue → Claim → Dispute → 权益保障库.

The [execution contract](./Solana%20内容权益社交协议%20V0%20—%20Codex%20执行契约.md) defines scope. The implementation starts with protocol safety; no UI, tokenomics, NFT, external yield strategy or production deployment is included.

```text
programs/content_rights_protocol/  Anchor program, pure math, VM transaction tests
packages/canonicalization/         frozen hash/citation validation V1
packages/rights-math/              integer residual economics and Merkle proofs
packages/protocol-sdk/             PDA/IDL instruction builders and reveal verification
services/                         signed storage, provenance and finalized-event projection
idl/                              interface generated from actual Anchor code
docs/                             protocol, ledger, states, decisions and threat model
scripts/                          local key preparation and local-only deployment helper
```

## Toolchain and build

Node 22+, Rust (verified with 1.99.0), Anchor crates/TS 0.32.1, Agave CLI 2.3.0; SBF platform-tools v1.57. The compiler tools can be installed independently from Anchor CLI. `Cargo.lock` and `package-lock.json` freeze dependencies. Targeted TOML/Jayson overrides address actual advisories without changing the SDK's public interfaces.

If using the worktree-local tools prepared during implementation:

```bash
export CARGO_HOME="$PWD/.local-tools/cargo"
export RUSTUP_HOME="$PWD/.local-tools/rustup"
export PATH="$PWD/.local-tools/cargo/bin:$PWD/.local-tools/solana-release/bin:$PATH"
# This WSL image has OpenSSL headers/libraries but no pkg-config:
export OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu
export OPENSSL_INCLUDE_DIR=/usr/include
```

```bash
npm ci --ignore-scripts
npm run build
cargo test --workspace
cargo build-sbf --tools-version v1.57 --manifest-path programs/content_rights_protocol/Cargo.toml --sbf-out-dir target/deploy
cargo run -p content-rights-protocol --example build_idl -- programs/content_rights_protocol idl/content_rights_protocol.json
node --check scripts/initialize-local.cjs
```

## Local tests

```bash
npm test
cargo test --workspace
# Requires the SBF artifact; no remote deployment or RPC is used:
cargo test -p content-rights-protocol --test security -- --ignored
npm audit
```

Math tests and host compilation do not substitute for successful SBF/VM execution. See [validation](docs/validation.md) for actual results and gaps.

## Local deployment and authority setup

Local deployment is an explicit user-run operation. The helper connects only to 127.0.0.1. It generates/preserves separate admin, originality, rights and treasury keypairs under ignored `target/local-authorities`, synchronizes a local program keypair's public address, rebuilds code/IDL/SDK, deploys to an already-running test validator and initializes the protocol. It never uses your globally configured cluster. Do not reuse local keys in production.

```bash
node scripts/setup-local.cjs
# Terminal 1:
solana-test-validator --ledger target/local-validator --bind-address 127.0.0.1
# Terminal 2:
bash scripts/deploy-local.sh
```

`initializeProtocol` requires the deployed program and its ProgramData account; the admin must be its actual upgrade authority. Supply the three other public keys, never the corresponding secrets, as arguments. Use generated IDL and `createProtocolClient(idl, provider)`; the SDK constructs unsigned instructions and the correct wallet/authority signs the transaction. The program ID embedded in the checked-in source is for VM tests; the helper synchronizes the user's local deployment address before rebuilding.

Originality signs content hashing/citation attestations and approvals; Rights signs new repost vector correctness or agreed derivative finalization; both authors sign Independent/settlement agreement. Admin cannot claim for those authors. `withdrawProtocolFees` can transfer only materialized earned fees to the configured treasury token account.

## Minimum offchain service

```bash
npm run build
export IDL_PATH="$PWD/idl/content_rights_protocol.json"
export SOLANA_RPC_URL=http://127.0.0.1:8899
export ORIGINALITY_AUTHORITY_KEY="$PWD/target/local-authorities/originality.json"
export RIGHTS_AUTHORITY_KEY="$PWD/target/local-authorities/rights.json"
# Required for paid storage; set a securely generated 64-hex CONTENT_MASTER_KEY in your environment.
npm run service
```

The service listens on 127.0.0.1:8787. `CONTENT_MASTER_KEY` encrypts paid artifacts using AES-GCM; no default secret is generated or printed. `PROVENA_DATA_FILE` selects the durable local single-writer JSON store. The service fails closed when live access verification fails. Store backups and authority-key custody are operational requirements for deployment.

Endpoints include `/health`, `/feed`, `/content/:id`, `/metrics/:id`, signed `/content`, `/paid-key`, `/originality`, `/reactions`, `/provenance/*`, `/review/*`, `/creator/review`, `/dashboard/claims`. Signed messages include route/payload, wallet, nonce and timestamp. SDK/service tests show exact encoding. The deterministic originality mock emits risk only. A detached audit attestation is not a chain authorization: the designated authority must co-sign the SDK transaction. Parent mapping stays private; public node accounts and events have no parent pointer.

Indexer results derive from finalized program events. Incomplete entitlement information is marked unknown rather than fabricated from claim count. Indexer/storage failure cannot change chain ownership, purchase receipts, user liabilities or exit readiness.

## Protocol documentation

- [Protocol specification](docs/protocol-spec.md)
- [State machines](docs/state-machines.md)
- [Revenue ledger](docs/revenue-ledger.md)
- [Architecture decisions](docs/architecture-decisions.md)
- [Threat model](docs/threat-model.md)
- [用户公约](docs/public-covenant.zh-CN.md)

V0 trust assumptions include upgrade-key custody, offchain canonical/citation attestation, private-parent rights attestation and operator access to paid plaintext. Native SOL is optional and omitted; approved wrapped SOL and plain SPL/Token-2022 are supported. There is no admin principal withdrawal, strategy deployment or claim-window reset.
