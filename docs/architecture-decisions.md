# Architecture decisions

## ADR-001: execution and toolchain baseline

The verified baseline is dev at a8f7e266cbae41e5954b42b09c33d75b1b22e6d7, with only README, license and the execution contract. Node 22.22.1/npm9.2.0 exist; Rust, Solana and Anchor do not. Bootstrap a monorepo without upgrading existing code. Pin Anchor Rust/TS0.32.1 and recommended Agave2.3.0. Local tooling and build artifacts are ignored; no remote deployment is part of implementation.

## ADR-002: immutable vector and mutable origin classification

Provenance, distribution and origin rights are separate. Merkle leaves encode node, revenue kind, role, wallet and weight with domain separation. Origin leaves refer to the immutable content author; classification can split only their unpaid allocation. Distributor and licensed-source leaves are retained. An existing node's root is never rewritten. Repost creation uses the rights authority plus creator signature and no public parent input.

Trust: the V0 rights authority knows the private parent and certifies valid residual math and aggregate10000bps. It can mis-attest a new vector; this is not zero knowledge. Independent auditing and stronger proofs can replace it without changing financial custody. The program validates original node roots itself.

## ADR-003: token asset restrictions

SPL Token and Token-2022 token_interface transfers use checked amounts. Only plain, unfrozen, non-rebasing mints without freeze authority or Token-2022 extensions are supported initially. Transfer-fee/hook/confidential/permanent-delegate and other extensions are rejected: crediting requested amounts would break solvency. Wrapped SOL is supported as an approved SPL mint; native SOL payment is omitted under the contract's optional cost clause. No bridges or external strategy.

## ADR-004: bounded review lifecycle

One final source-classification case per content in V0; independent/derivative outcomes are irreversible for that case. This avoids silently rewriting finalized rights or reopening prior financial epochs. Evidence and conversation updates remain offchain. Future repeat reviews require explicit versioned case and rights snapshots, not mutation of sealed settlements.

## ADR-005: custody and integer settlement

Use proof-materialized leaf liabilities and derived exit readiness (see revenue-ledger.md). Fee rounding favors the rights holders. Never redistribute an aggregate remainder after partial payments. Indexer and service failures cannot rewrite chain ownership, receipts or vault debt.

## ADR-006: minimum offchain services

Use local file persistence, encrypted paid blobs, signed content/reaction messages, deterministic similarity risk interface and separate private provenance storage. Semantic models, production DRM, recommendation, arbitration court and UI are excluded. Production deployment requires durable storage, key custody, rate limits and validated chain ingestion; V0 documents those trust boundaries.
