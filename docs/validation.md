# V0 validation and engineering handoff

## Baseline and scope

Verified worktree: `/home/k5068/.codex/worktrees/c5e8/Provena`, branch `dev`, initial HEAD `a8f7e266cbae41e5954b42b09c33d75b1b22e6d7`. The initial checkout contained README, LICENSE and the V0 execution contract; there was no existing runtime, schema, migration, test suite or separate Engineering Handoff. No applicable filesystem AGENTS.md was present. The user's supplied repository execution instructions and the execution contract govern this implementation.

Implementation follows the six V0 phases: Anchor account/authority skeleton; immutable content and distribution; integer token custody/claims/safeguard; content-scoped paid access; bilateral review settlement; minimal offchain services and SDK. The original execution contract and license are unchanged. This document records verified findings rather than changing the product contract.

## Reproducible checks

Use the toolchain/environment in README, including the OpenSSL paths for this WSL image. Run:

```bash
npm ci --ignore-scripts
npm test
npm audit
cargo fmt --all --check
cargo test --workspace
npm run build:program
npm run build:idl
npm run test:vm
git diff --check
```

The VM suite deliberately requires an SBF artifact. It is ignored by ordinary host `cargo test`, then explicitly enabled by `test:vm`; a missing artifact fails that run instead of silently skipping custody tests. No RPC, deployment, token purchase or externally funded transaction is required for these in-process tests.

## Acceptance evidence

| Criteria | Implementation and deterministic evidence |
|---|---|
| AC-1, AC-4 | Rights-math golden/property vectors plus actual co-signed repost transactions and token payouts: TIP 70/18/12, independent SALE 80/18/2. Updating a parent policy leaves existing child roots unchanged. |
| AC-2 | `process_deposit` makes one checked token transfer to the asset vault. It does not enumerate beneficiaries or load ancestors. Merkle work belongs to individual claims. |
| AC-3 | Receipt PDA seeds are `access, content, buyer`; VM purchase replay and SDK/RPC content/buyer/owner checks. |
| AC-5 | Canonical hash is a global fingerprint seed; cross-author duplicate VM submission rejects. Shared canonicalization retains raw identity and freezes V1 behavior. |
| AC-6 | DistributionNode schema and repost account metas contain no parent address. Private salted commitments and complete reveal verification are tested separately. |
| AC-7 | Fee withdrawal requires configured admin/treasury and earned-fee cap; VM arbitrary admin, destination and amount attacks reject. Upgrade authority remains a disclosed deployment trust boundary. |
| AC-8, AC-12 | Expired normal balances require a signed, amount-bounded exit. VM tests reject immediate/early withdrawal, allow 48-hour readiness, preserve partial requests and expire returned windows. |
| AC-9, AC-10 | Zero-revenue dispute starts a real Clock cutoff. Permissionless transition and late deposits retain the original cutoff; they do not start a new window. |
| AC-11 | Content-wide inherited deadline, unresolved-case checks, old-epoch closure and partial-claim tests prevent grace resets. |
| AC-13, AC-14 | Independent charges zero. Derivative assesses an integer 5% fee only on each leaf's unclaimed disputed allocation. Prior payments, one-time fee assessment, source/candidate split and token solvency are tested. |
| AC-15 | Immutable distributor leaves survive origin reclassification. Math tests verify both downstream shares; VM settlement exercises actual distributor and source withdrawals. |
| AC-16, AC-17 | Citation manifests commit exact ordered source segments and mandatory attribution/view/tip actions. Citation processing never adds a royalty leaf; source licensing is a separate bilateral instruction. |
| AC-18 | Paid body defaults NONE. Shared and service tests reject unauthorized paid-body citation and release keys only after signed requests and verified chain receipts. |
| AC-19 | Ownership, liabilities, receipts, dispute and exit clocks live in Anchor accounts. VM financial tests use no backend/indexer. Service tests fail closed on RPC failure and reject public financial event ingestion. Proof/storage backups remain an operational requirement. |
| AC-20 | Host math/property tests, strict SDK/canonicalization/service tests and separately executed real SBF/LiteSVM transaction tests cover core paths, substitutions, impersonation, replay, integer bounds and time transitions. |

## Verified corrective findings

1. Anchor 0.32.1 requires AccountInfo's `resize`; an old test-dependency lock selected 2.2.1 and failed compilation. The compatible VM line is LiteSVM 0.7.1 with Solana SDK 2.3.1, AccountInfo 2.3.0 and Keypair 2.2.3 frozen in Cargo.lock. These were environment/dependency integration failures, not transaction-test failures.
2. The SBF compiler reports stack errors while returning success. Purchase/Claim contexts exceeded 4096 bytes; boxing their large Anchor accounts removed those errors without changing serialized schema or instruction ABI. Acceptance requires actual VM execution, not the build exit code alone.
3. A shared mint vault needs an epoch-level cap as well as individual paid counters. Claims and fee materialization now enforce `paid + fees <= gross`, protecting other epochs even if a rights authority certifies a bad vector.
4. Anchor's AccountClient does not check the owning program on receipt fetch. SDK access checks now read one RPC account and validate owner, executable flag, discriminator, version, positive amount and exact content/buyer. The key service performs equivalent finalized checks.
5. The official anchor-lang-idl 0.1.4 builder incorrectly passes literal `+{toolchain}` when Rustup exports RUSTUP_TOOLCHAIN. The example preserves the resolved Cargo binary and removes that environment branch before calling the official builder. IDL is generated from source, not hand-maintained.
6. Local program-address synchronization originally left a service constant unchanged. Service readers now reuse the SDK's address. The user-run local helper rebuilds source, IDL and SDK after synchronizing its freshly generated deployment key.
7. Targeted TOML/Jayson dependency overrides remove the reported npm advisories. Both Anchor/web3 imports and the SDK/service test suite are verified after the overrides.

Agave 2.3.0 post-processing with newer platform-tools v1.57 emits an undefined-syscall warning for standard Solana calls. The SBF artifact is verified by executing its real hashing, system-account creation and SPL token CPI paths in LiteSVM. This warning is recorded distinctly from the corrected stack errors; no public/local-validator deployment result is claimed.

## Capability limits and authority preservation

- V0 permits one licensed source with a 5000-bps cap, and one irreversible final classification case per content. Multi-source and repeat-review schema changes require a separately authorized versioned design.
- Native SOL was optional and is omitted; approved wrapped SOL and plain SPL/Token-2022 use the existing asset adapter. Every Token-2022 extension and freeze-authority mint is rejected.
- Article metrics return an explicit unknown paid-beneficiary count when a complete verified entitlement projection is unavailable; they never substitute claim count. The claim dashboard reports finalized historical claims and marks live balances unknown. Clients read chain accounts and use proofs for authoritative balances. These display projections are not complete financial dashboards.
- Detached originality/rights audit signatures require the corresponding authority to co-sign actual transactions. The mock similarity result is risk evidence, never unilateral copyright adjudication.
- Local deployment/initialization scripts are delivered for explicit user execution. No deployment, merge, push, publication, production mutation, paid service, external communication or future strategy was performed.
- Production custody, independent security review, durable storage operation and optional future UI are outside this V0 implementation. The retained upgrade key can replace code; handler restrictions alone do not remove that trust.

## Final check results

The final result counts and artifact verification are recorded here after the final integrated run.
